'use strict';
// The terminal version that is really on this computer, and updating it from inside the app.
//
// The app carries its own copy of Mindweave, but the `mindweave` / `mw` a person types in a terminal
// is whichever one comes first on their PATH: the app's own (the Windows installer and the Linux
// package put it there), or one installed with npm. Judging "is there a newer terminal version" by the
// app's bundled copy was wrong for anyone with an npm install, so this finds the one that actually runs.
//
//   - bundled: it is the app's own copy. It moves with the app's update, so there is nothing to do here.
//   - npm:     installed with `npm install -g`. The app can update it itself, running npm with fixed
//              arguments and nothing taken from the network.
//   - other:   found, but not something the app can update. The update notice stays a plain pointer.
//   - none:    no `mindweave` on the PATH.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SEMVER = /\b(\d+\.\d+\.\d+)\b/;
const VERSION_TIMEOUT_MS = 10_000;
const NPM_LS_TIMEOUT_MS = 20_000;
const NPM_INSTALL_TIMEOUT_MS = 5 * 60_000;

const flavour = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function findOnPath(name, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const P = flavour(platform);
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.bat'] : [''];
  const dirs = String(env.PATH || env.Path || '').split(P.delimiter).filter(Boolean);
  for (const dir of dirs) for (const ext of exts) {
    const file = P.join(dir, name + ext);
    if (exists(file)) return file;
  }
  return null;
}

// A .cmd file can only be started through cmd.exe. The path comes from the PATH on this computer and
// the arguments are fixed words, so nothing from outside ends up on the command line.
function run(file, args, { platform, timeout, execFileFn = execFile }) {
  return new Promise((resolve) => {
    const viaShell = platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    const done = (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    };
    // The whole line is built here, so the shell is given one fixed string and no separate arguments.
    if (viaShell) execFileFn(`"${file}" ${args.join(' ')}`, [], { timeout, windowsHide: true, shell: true }, done);
    else execFileFn(file, args, { timeout, windowsHide: true }, done);
  });
}

const sameDir = (a, b, platform) => {
  const P = flavour(platform);
  const norm = (x) => P.resolve(x).replace(/[\\/]+$/, '');
  return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

// Where a link really points. The Linux package and the macOS "add the command line" step put `mw` in place
// as a link into the app, and it is the target that says whose copy it is.
const realOf = (f) => { try { return fs.realpathSync(f); } catch { return f; } };

async function detectCli({ bundledDir = null, env = process.env, platform = process.platform, exists = fs.existsSync, execFileFn = execFile, realpath = realOf } = {}) {
  const where = { env, platform, exists };
  const file = findOnPath('mindweave', where) || findOnPath('mw', where);
  if (!file) return { found: false, source: 'none', version: null, canUpdate: false };

  const out = await run(file, ['--version'], { platform, timeout: VERSION_TIMEOUT_MS, execFileFn });
  const version = (out.ok && SEMVER.exec(out.stdout)?.[1]) || null;

  if (bundledDir && sameDir(flavour(platform).dirname(realpath(file)), realpath(bundledDir), platform)) {
    return { found: true, source: 'bundled', version, canUpdate: false, file };
  }
  // Installed with npm only if npm itself says so; a copy put there some other way is left alone.
  const npm = findOnPath('npm', where);
  let managed = false;
  if (npm) {
    const ls = await run(npm, ['ls', '-g', 'mindweave', '--depth=0', '--json'], { platform, timeout: NPM_LS_TIMEOUT_MS, execFileFn });
    try { managed = Boolean(JSON.parse(ls.stdout)?.dependencies?.mindweave); } catch { /* not npm's */ }
  }
  return { found: true, source: managed ? 'npm' : 'other', version, canUpdate: managed, file, npm: managed ? npm : null };
}

const lastLine = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';

function explain(out) {
  const text = `${out.stderr}\n${out.stdout}`;
  if (/EACCES|EPERM|permission denied/i.test(text)) return 'npm was not allowed to change its global folder. Close any terminal that has Mindweave open and try again, or run the command yourself.';
  if (/EBUSY|resource busy/i.test(text)) return 'Mindweave is open in a terminal, so it cannot be replaced. Close it and try again.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(text)) return 'It could not reach npm. Check the connection and try again.';
  return lastLine(out.stderr) || lastLine(out.stdout) || 'npm did not finish.';
}

// `state` is what detectCli returned. Only an npm-managed copy is touched, with fixed arguments.
async function updateCli(state, opts = {}) {
  if (!state?.canUpdate || !state.npm) return { ok: false, error: 'This copy of the command line cannot be updated from here.' };
  const platform = opts.platform || process.platform;
  const out = await run(state.npm, ['install', '-g', 'mindweave@latest'], { platform, timeout: NPM_INSTALL_TIMEOUT_MS, execFileFn: opts.execFileFn });
  if (!out.ok) return { ok: false, error: explain(out) };
  return { ok: true, state: await detectCli(opts) };
}

module.exports = { detectCli, updateCli, findOnPath, SEMVER };
