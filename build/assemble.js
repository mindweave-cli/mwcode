// Puts the finished app folder together (dist/win-unpacked), which electron-builder then turns into
// the installer and uninstaller (--prepackaged). Done here rather than by electron-builder because its
// dependency scan ran out of memory on this tree; .stage/app is already a clean production install.
//
//   dist/win-unpacked/
//     mwcode.exe              the app (Electron, named and iconed as mwcode)
//     resources/app/          the app's files and node_modules (the core included)
//     resources/node/         Node for the CLI (the app's own runtime can't read a terminal's keys)
//     resources/bin/          mw.cmd, mindweave.cmd (the installer puts this folder on PATH)
//     resources/setup/        path.ps1, used by the installer and uninstaller
// Run: node build/assemble.js   (after node build/stage.js)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The Node the CLI runs on: the official Windows build, downloaded once into build/vendor/node and
// kept only when its checksum matches the one nodejs.org publishes (the Linux and Mac builds do the same).
const NODE_VERSION = 'v24.21.0';
const root = path.join(__dirname, '..');
const vendorNode = path.join(root, 'build', 'vendor', 'node');

async function windowsNode() {
  const exe = path.join(vendorNode, 'node.exe');
  const license = path.join(vendorNode, 'LICENSE');
  const base = `https://nodejs.org/dist/${NODE_VERSION}/`;
  const sums = await (await fetch(base + 'SHASUMS256.txt')).text();
  const want = sums.split('\n').find((l) => l.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
  if (!want) throw new Error('no checksum listed for win-x64/node.exe');
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  if (!fs.existsSync(exe) || sha(fs.readFileSync(exe)) !== want) {
    const buf = Buffer.from(await (await fetch(base + 'win-x64/node.exe')).arrayBuffer());
    if (sha(buf) !== want) throw new Error('checksum mismatch for node.exe');
    fs.mkdirSync(vendorNode, { recursive: true });
    fs.writeFileSync(exe, buf);
    console.log('• node', NODE_VERSION, 'checksum ok');
  }
  if (!fs.existsSync(license)) {
    const text = await (await fetch(`https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/LICENSE`)).text();
    fs.writeFileSync(license, text);
  }
}

const out = path.join(root, 'dist', 'win-unpacked');
const res = path.join(out, 'resources');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const stageApp = path.join(root, '.stage', 'app');
const pkg = require(path.join(root, 'package.json'));

if (!fs.existsSync(path.join(stageApp, 'node_modules', 'mindweave', 'dist', 'index.js'))) {
  throw new Error('Run node build/stage.js first.');
}

async function main() {
  await windowsNode();
  // Only this build's own folder: dist/ also holds the Linux and Mac packages.
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(electronDist, out, { recursive: true, filter: (src) => !/default_app\.asar$/.test(src) });
  fs.renameSync(path.join(out, 'electron.exe'), path.join(out, 'mwcode.exe'));

  const mod = require('rcedit');
  const rcedit = typeof mod === 'function' ? mod : mod.rcedit || mod.default;
  const v = pkg.version;
  await rcedit(path.join(out, 'mwcode.exe'), {
    icon: path.join(root, 'assets', 'icon.ico'),
    'file-version': v,
    'product-version': v,
    'version-string': {
      FileDescription: 'mwcode',
      ProductName: 'mwcode',
      CompanyName: 'Mindweave',
      InternalName: 'mwcode',
      OriginalFilename: 'mwcode.exe',
      LegalCopyright: pkg.build.copyright,
    },
  });

  fs.cpSync(stageApp, path.join(res, 'app'), { recursive: true });
  fs.mkdirSync(path.join(res, 'node'), { recursive: true });
  for (const f of ['node.exe', 'LICENSE']) fs.copyFileSync(path.join(root, 'build', 'vendor', 'node', f), path.join(res, 'node', f));
  fs.mkdirSync(path.join(res, 'bin'), { recursive: true });
  for (const f of ['mw.cmd', 'mindweave.cmd']) fs.copyFileSync(path.join(root, 'build', 'cli', f), path.join(res, 'bin', f));
  fs.mkdirSync(path.join(res, 'setup'), { recursive: true });
  fs.copyFileSync(path.join(root, 'build', 'setup', 'path.ps1'), path.join(res, 'setup', 'path.ps1'));
  console.log('• assembled', out);
}

main().catch((e) => { console.error(e); process.exit(1); });
