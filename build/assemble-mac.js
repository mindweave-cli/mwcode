// Builds the macOS app (dist/mac-arm64/mwcode.app) and its zip, on Linux: no Mac is needed. Run after
// `node build/stage.js darwin arm64`, so the dependencies with native parts are the Mac ones.
//
//   mwcode.app/Contents/
//     MacOS/mwcode                 the app (Electron, renamed)
//     Frameworks/mwcode Helper*.app Electron's helpers, renamed to match (Electron finds them by name)
//     Resources/icon.icns          the icon
//     Resources/app/               the app's files and node_modules (the core included)
//     Resources/node/              Node for the CLI, the official Mac build
//     Resources/bin/               mw, mindweave (Settings > About adds them to the Terminal)
//
// Everything downloaded is checked against the checksum its publisher lists. The finished app is signed
// "ad-hoc" with rcodesign: no Apple developer account, so macOS asks once (Open Anyway) before the first
// start, but Apple Silicon Macs run nothing unsigned at all.
// Run: node build/assemble-mac.js [arm64|x64]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ARCH = process.argv[2] || 'arm64';
const ELECTRON = '44.4.5';
const NODE = 'v24.21.0';
const RCODESIGN = '0.29.0';
const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const stageApp = path.join(root, '.stage', 'app');
const cache = path.join(root, 'build', 'vendor', 'mac');
const outDir = path.join(root, 'dist', `mac-${ARCH}`);
const appDir = path.join(outDir, 'mwcode.app');
const contents = path.join(appDir, 'Contents');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

if (process.platform !== 'linux') throw new Error('Run this on Linux (it uses unzip, tar, zip and python3).');
if (!fs.existsSync(path.join(stageApp, 'node_modules', 'mindweave', 'dist', 'index.js'))) {
  throw new Error('Run node build/stage.js darwin ' + ARCH + ' first.');
}

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A file from `url`, kept in build/vendor/mac once its checksum matched.
async function fetchChecked(url, name, want) {
  const file = path.join(cache, name);
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === want) return file;
  const buf = await download(url);
  const got = sha256(buf);
  if (got !== want) throw new Error(`checksum mismatch for ${name}: ${got}`);
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(file, buf);
  console.log('•', name, 'checksum ok');
  return file;
}
const listed = (sums, name) => {
  const line = sums.split('\n').find((l) => l.trim().endsWith(name));
  if (!line) throw new Error('no checksum listed for ' + name);
  return line.trim().split(/\s+/)[0];
};

// Info.plist edits through python3's plistlib, which reads XML and binary plists alike.
function editPlist(file, values, remove = []) {
  const py = 'import plistlib,sys,json\n' +
    'p=sys.argv[1]; d=plistlib.load(open(p,"rb"))\n' +
    'd.update(json.loads(sys.argv[2]))\n' +
    'for k in json.loads(sys.argv[3]): d.pop(k, None)\n' +
    'plistlib.dump(d, open(p,"wb"))\n';
  run('python3', ['-c', py, file, JSON.stringify(values), JSON.stringify(remove)]);
}

async function main() {
  // Electron for macOS.
  const ezip = `electron-v${ELECTRON}-darwin-${ARCH}.zip`;
  const ebase = `https://github.com/electron/electron/releases/download/v${ELECTRON}/`;
  const esums = (await download(ebase + 'SHASUMS256.txt')).toString();
  const electronZip = await fetchChecked(ebase + ezip, ezip, listed(esums, ezip));

  // Node for macOS, for the CLI.
  const ntar = `node-${NODE}-darwin-${ARCH}.tar.gz`;
  const nbase = `https://nodejs.org/dist/${NODE}/`;
  const nsums = (await download(nbase + 'SHASUMS256.txt')).toString();
  const nodeTar = await fetchChecked(nbase + ntar, ntar, listed(nsums, ntar));

  // rcodesign, which signs Mac apps from Linux.
  const rname = `apple-codesign-${RCODESIGN}-x86_64-unknown-linux-musl`;
  const rbase = `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${RCODESIGN}/`;
  const rsum = (await download(rbase + rname + '.tar.gz.sha256')).toString().trim().split(/\s+/)[0];
  const rtar = await fetchChecked(rbase + rname + '.tar.gz', rname + '.tar.gz', rsum);
  const rcodesign = path.join(cache, rname, 'rcodesign');
  if (!fs.existsSync(rcodesign)) run('tar', ['-xzf', rtar, '-C', cache]);

  // The app bundle, from Electron.app.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const unpack = path.join(outDir, '.electron');
  run('unzip', ['-q', electronZip, '-d', unpack]);
  fs.renameSync(path.join(unpack, 'Electron.app'), appDir);
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.renameSync(path.join(contents, 'MacOS', 'Electron'), path.join(contents, 'MacOS', 'mwcode'));

  // Electron's helpers take the app's name: it looks for "<app> Helper (…).app".
  const frameworks = path.join(contents, 'Frameworks');
  for (const entry of fs.readdirSync(frameworks)) {
    const m = /^Electron Helper( \(\w+\))?\.app$/.exec(entry);
    if (!m) continue;
    const suffix = m[1] || '';
    const name = `mwcode Helper${suffix}`;
    const dir = path.join(frameworks, `${name}.app`);
    fs.renameSync(path.join(frameworks, entry), dir);
    fs.renameSync(path.join(dir, 'Contents', 'MacOS', `Electron Helper${suffix}`), path.join(dir, 'Contents', 'MacOS', name));
    const kind = suffix ? '.' + suffix.replace(/[ ()]/g, '').toLowerCase() : '';
    editPlist(path.join(dir, 'Contents', 'Info.plist'), {
      CFBundleExecutable: name, CFBundleName: name, CFBundleDisplayName: name,
      CFBundleIdentifier: `com.mindweave.mwcode.helper${kind}`,
    });
  }

  const resources = path.join(contents, 'Resources');
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  fs.rmSync(path.join(resources, 'electron.icns'), { force: true });
  fs.copyFileSync(path.join(root, 'assets', 'icon.icns'), path.join(resources, 'icon.icns'));
  editPlist(path.join(contents, 'Info.plist'), {
    CFBundleExecutable: 'mwcode', CFBundleName: 'mwcode', CFBundleDisplayName: 'mwcode',
    CFBundleIdentifier: 'com.mindweave.mwcode', CFBundleIconFile: 'icon.icns',
    CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version,
    NSHumanReadableCopyright: pkg.build.copyright,
    LSApplicationCategoryType: 'public.app-category.developer-tools',
  });

  // The app's own files, Node for the CLI, and the CLI.
  run('cp', ['-a', stageApp, path.join(resources, 'app')]);
  const nodeDir = path.join(resources, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  const top = `node-${NODE}-darwin-${ARCH}`;
  run('tar', ['-xzf', nodeTar, '-C', nodeDir, '--strip-components=2', `${top}/bin/node`]);
  run('tar', ['-xzf', nodeTar, '-C', nodeDir, '--strip-components=1', `${top}/LICENSE`]);
  fs.mkdirSync(path.join(resources, 'bin'), { recursive: true });
  for (const f of ['mw', 'mindweave']) {
    fs.copyFileSync(path.join(root, 'build', 'cli', f), path.join(resources, 'bin', f));
    fs.chmodSync(path.join(resources, 'bin', f), 0o755);
  }

  // Signed ad-hoc, every piece inside included, then zipped with its links kept (-y).
  run(rcodesign, ['sign', appDir]);
  const zipName = `mwcode-${pkg.version}-mac-${ARCH}.zip`;
  fs.rmSync(path.join(root, 'dist', zipName), { force: true });
  run('zip', ['-qry', '-X', path.join('..', zipName), 'mwcode.app'], { cwd: outDir });
  console.log('• built', path.join('dist', zipName));
}

main().catch((e) => { console.error(e); process.exit(1); });
