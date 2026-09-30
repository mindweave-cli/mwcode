// The Linux version of assemble.js: puts the finished app folder together (dist/linux-unpacked),
// which electron-builder then turns into the .deb and the AppImage (--prepackaged). Run on Linux,
// after node build/stage.js there, so the dependencies with native parts (ripgrep) are Linux ones.
//
//   dist/linux-unpacked/
//     mwcode                  the launcher (build/linux/mwcode: picks X11 or Wayland)
//     mwcode-bin              the app (Electron, renamed)
//     resources/app/          the app's files and node_modules (the core included)
//     resources/node/         Node for the CLI, the official Linux build, checked against its checksum
//     resources/bin/          mw, mindweave (the .deb links them into /usr/bin)
// Run: node build/assemble-linux.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const NODE_VERSION = 'v24.21.0'; // the same Node the Windows build ships
const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'linux-unpacked');
const res = path.join(out, 'resources');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const stageApp = path.join(root, '.stage', 'app');
const cache = path.join(root, 'build', 'vendor', 'node-linux');

if (process.platform !== 'linux') throw new Error('Run this on Linux.');
if (!fs.existsSync(path.join(stageApp, 'node_modules', 'mindweave', 'dist', 'index.js'))) {
  throw new Error('Run node build/stage.js first.');
}

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// The Linux Node, downloaded once into build/vendor/node-linux and kept only when its checksum matches
// the one nodejs.org publishes for that version.
async function linuxNode() {
  const name = `node-${NODE_VERSION}-linux-x64`;
  const dir = path.join(cache, name);
  if (fs.existsSync(path.join(dir, 'bin', 'node'))) return dir;
  const base = `https://nodejs.org/dist/${NODE_VERSION}/`;
  const sums = (await download(base + 'SHASUMS256.txt')).toString();
  const want = sums.split('\n').find((l) => l.endsWith(`  ${name}.tar.xz`))?.split(' ')[0];
  if (!want) throw new Error('no checksum for ' + name);
  const tar = await download(base + name + '.tar.xz');
  const got = crypto.createHash('sha256').update(tar).digest('hex');
  if (got !== want) throw new Error(`checksum mismatch for ${name}: ${got}`);
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, name + '.tar.xz');
  fs.writeFileSync(file, tar);
  execFileSync('tar', ['-xJf', file, '-C', cache]);
  fs.rmSync(file);
  console.log('• node', NODE_VERSION, 'checksum ok');
  return dir;
}

async function main() {
  const node = await linuxNode();
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(electronDist, out, { recursive: true, verbatimSymlinks: true, filter: (src) => !/default_app\.asar$/.test(src) });
  fs.renameSync(path.join(out, 'electron'), path.join(out, 'mwcode-bin'));
  fs.copyFileSync(path.join(root, 'build', 'linux', 'mwcode'), path.join(out, 'mwcode'));
  fs.chmodSync(path.join(out, 'mwcode'), 0o755);

  fs.cpSync(stageApp, path.join(res, 'app'), { recursive: true, verbatimSymlinks: true });
  fs.mkdirSync(path.join(res, 'node'), { recursive: true });
  fs.copyFileSync(path.join(node, 'bin', 'node'), path.join(res, 'node', 'node'));
  fs.copyFileSync(path.join(node, 'LICENSE'), path.join(res, 'node', 'LICENSE'));
  fs.chmodSync(path.join(res, 'node', 'node'), 0o755);
  fs.mkdirSync(path.join(res, 'bin'), { recursive: true });
  for (const f of ['mw', 'mindweave']) {
    fs.copyFileSync(path.join(root, 'build', 'cli', f), path.join(res, 'bin', f));
    fs.chmodSync(path.join(res, 'bin', f), 0o755);
  }
  console.log('• assembled', out);
}

main().catch((e) => { console.error(e); process.exit(1); });
