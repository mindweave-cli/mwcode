'use strict';
// Putting a downloaded update in place, for each system. Nothing here downloads or trusts anything:
// updateService.js has already checked the signature, the size and the SHA-256 by the time these run.
//
//   Windows  the installer the user would have run, started silently with the flags the installer's own
//            update path understands (--updated, /S, --force-run): it replaces the app, keeps PATH and
//            data as they are, and starts the new version. An all-users install needs a permission prompt,
//            so that one runs the installer with its window instead.
//   macOS    no Apple signature, so the usual updater refuses. A short script waits for this app to quit,
//            unpacks the new app, swaps it in (putting the old one back if anything fails), clears the
//            "downloaded from the internet" mark and opens it. The mark is cleared because this app did
//            the downloading, not a browser, so there is nothing for the user to approve a second time.
//   Linux    an AppImage replaces its own file and starts again. A .deb cannot be replaced by the app it
//            installed, so that one only points to the download.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ── what this copy of the app can do ─────────────────────────────────────
// { mode: 'auto' | 'manual' | 'none', reason?, bundle?, appImage?, dir }
//   auto    the app can install the update itself
//   manual  an update can be offered, but the user has to download it (reason says why)
//   none    not an installed copy (a source checkout): updates do not apply
function capability({ platform = process.platform, packaged, execPath = process.execPath, env = process.env, userData }) {
  if (!packaged) return { mode: 'none', reason: 'not an installed copy', dir: userData };
  if (platform === 'win32') return { mode: 'auto', interactive: needsElevation(execPath, env), dir: userData };
  if (platform === 'darwin') {
    const bundle = path.resolve(execPath, '..', '..', '..');
    const why = bundleProblem(bundle);
    return why ? { mode: 'manual', reason: why, bundle, dir: userData } : { mode: 'auto', bundle, dir: userData };
  }
  if (platform === 'linux') {
    const appImage = env.APPIMAGE;
    if (!appImage) return { mode: 'manual', reason: 'Installed from a .deb: download the new one to update.', dir: userData };
    const dir = path.dirname(appImage);
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      fs.accessSync(appImage, fs.constants.W_OK);
    } catch {
      return { mode: 'manual', reason: 'The folder holding the AppImage is read-only.', appImage, dir: userData };
    }
    return { mode: 'auto', appImage, dir };
  }
  return { mode: 'none', reason: 'unsupported system', dir: userData };
}

// A per-user install lives under the user's own folders; an all-users one under Program Files and
// needs a permission prompt to change.
function needsElevation(execPath, env) {
  // Windows paths, judged as Windows paths whatever system this runs on.
  const p = path.win32.resolve(execPath).toLowerCase();
  return [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
    .filter(Boolean)
    .some((root) => p.startsWith(path.win32.resolve(root).toLowerCase() + path.win32.sep));
}

function bundleProblem(bundle) {
  if (!bundle.endsWith('.app')) return 'Not running from an app bundle.';
  if (bundle.includes('/AppTranslocation/')) return 'Move mwcode to the Applications folder, then open it from there.';
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
    return null;
  } catch {
    return 'mwcode is in a folder this account cannot change. Move it to Applications, or download the new one.';
  }
}

// ── Windows ──────────────────────────────────────────────────────────────
// Always silent: an update never shows the setup window. --force-run opens the new app when it is done.
function winArgs() {
  return ['--updated', '/S', '--force-run'];
}
// A per-user install is replaced directly. An all-users one (Program Files) needs one Windows permission
// prompt, which the elevate helper shipped with the app raises before running the same silent install.
// Only if that helper is missing does it fall back to the installer's own window.
function applyWindows({ file, interactive, elevateExe, spawnFn = spawn, exists = fs.existsSync }) {
  const opts = { detached: true, stdio: 'ignore' };
  if (!interactive) spawnFn(file, winArgs(), opts).unref();
  else if (elevateExe && exists(elevateExe)) spawnFn(elevateExe, [file, ...winArgs()], opts).unref();
  else spawnFn(file, ['--updated'], opts).unref();
}

// ── macOS ────────────────────────────────────────────────────────────────
// $1 pid of this app   $2 the downloaded zip   $3 the app to replace   $4 the log file
function macScript() {
  return `#!/bin/sh
# Replaces the running mwcode with the downloaded one, after it has quit. Every step that can fail
# puts the old app back, and the old app is opened either way so the user is never left with nothing.
pid="$1"; zip="$2"; target="$3"; log="$4"
bin="\${MW_BIN:-/usr/bin}"
exec >>"$log" 2>&1
echo "update started $(date)"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 300 ]; then echo "app did not quit"; exit 1; fi
  sleep 0.2
done
work="$("$bin"/mktemp -d)" || exit 1
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
reopen() { "$bin"/xattr -dr com.apple.quarantine "$target" 2>/dev/null; "$bin"/open "$target"; }
"$bin"/ditto -x -k "$zip" "$work" || { echo "unzip failed"; reopen; exit 1; }
next="$("$bin"/find "$work" -maxdepth 2 -name '*.app' -print -quit)"
name="$(basename "$target" .app)"
if [ -z "$next" ] || [ ! -x "$next/Contents/MacOS/$name" ]; then echo "no app in the download"; reopen; exit 1; fi
"$bin"/codesign --verify --deep "$next" 2>/dev/null || { echo "new app failed its signature check"; reopen; exit 1; }
backup="$target.previous-$$"
mv "$target" "$backup" || { echo "could not move the old app"; reopen; exit 1; }
if "$bin"/ditto "$next" "$target"; then
  rm -rf "$backup"
  echo "updated"
else
  echo "copy failed, putting the old app back"
  rm -rf "$target"
  mv "$backup" "$target"
fi
reopen
exit 0
`;
}
function applyMac({ file, bundle, dir, pid = process.pid }) {
  const script = path.join(dir, 'apply-mac.sh');
  fs.writeFileSync(script, macScript(), { mode: 0o700 });
  spawn('/bin/sh', [script, String(pid), file, bundle, path.join(dir, 'apply.log')], { detached: true, stdio: 'ignore' }).unref();
}

// ── Linux AppImage ───────────────────────────────────────────────────────
// The new file was downloaded into the AppImage's own folder, so the swap is one atomic rename. The
// running copy keeps working from the old file it has open; the new one starts once this one is gone.
function applyAppImage({ file, appImage, pid = process.pid }) {
  fs.chmodSync(file, 0o755);
  fs.renameSync(file, appImage);
  const env = { ...process.env };
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[k];
  spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"', 'sh', String(pid), appImage], { detached: true, stdio: 'ignore', env }).unref();
}

// Runs the right one. The caller quits the app right afterwards.
function apply(cap, { file, platform = process.platform, elevateExe = process.resourcesPath ? path.join(process.resourcesPath, 'elevate.exe') : null }) {
  if (platform === 'win32') return applyWindows({ file, interactive: cap.interactive, elevateExe });
  if (platform === 'darwin') return applyMac({ file, bundle: cap.bundle, dir: cap.dir });
  if (platform === 'linux') return applyAppImage({ file, appImage: cap.appImage });
  throw new Error('unsupported system');
}

// Where a download for this machine is kept until it is applied. For an AppImage that is its own
// folder, so the final swap is a rename on one disk.
function downloadDir(cap, version) {
  const base = cap.appImage ? path.dirname(cap.appImage) : path.join(cap.dir, 'updates', version);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

module.exports = { capability, needsElevation, bundleProblem, winArgs, macScript, apply, applyWindows, applyMac, applyAppImage, downloadDir };
