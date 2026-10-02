// Builds the folder the installer is made from (.stage/app): the app's own files, and a clean
// production install of its dependencies with the core packed from ../Mindweave (a real copy, not
// the development link, so none of the core's sources, tests or dev tools come along).
// Run: node build/stage.js   (then electron-builder packs .stage/app)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const core = path.join(root, '..', 'Mindweave');
const stage = path.join(root, '.stage');
const appDir = path.join(stage, 'app');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, npm_config_loglevel: 'error' } });

// What the running app needs, and nothing else (no tests, notes, prototypes or screenshots).
const FILES = ['main.js', 'preload.js', 'renderer.js', 'index.html', 'styles.css', 'providerInfo.js', 'recordings.js', 'ui-store.js'];
const DIRS = ['assets', 'news', 'updater'];
const SKIP = /\.test\.m?js$|^tools$/;

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

console.log('• core: build and pack');
run('npm run build', core);
const tgz = execSync('npm pack --silent --pack-destination "' + stage + '"', { cwd: core }).toString().trim().split(/\r?\n/).pop();

console.log('• app files');
for (const f of FILES) fs.copyFileSync(path.join(root, f), path.join(appDir, f));
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.test(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
};
for (const d of DIRS) copyDir(path.join(root, d), path.join(appDir, d));

const pkg = require(path.join(root, 'package.json'));
const deps = { ...pkg.dependencies, mindweave: 'file:../' + tgz };
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: pkg.name, productName: 'mwcode', version: pkg.version, description: pkg.description || 'mwcode',
  author: pkg.author || 'Mindweave', license: 'Apache-2.0', main: pkg.main, dependencies: deps,
  // Linux: the window's app id, so the desktop ties the running window to mwcode.desktop (icon, pinning).
  homepage: pkg.homepage, desktopName: pkg.desktopName,
}, null, 2));
fs.copyFileSync(path.join(core, 'LICENSE'), path.join(appDir, 'LICENSE'));

// For another system than this one (the Mac build, made on Linux): `node build/stage.js darwin arm64`
// installs that system's copies of the parts that differ per system (ripgrep's binary).
const [targetOs, targetCpu] = process.argv.slice(2);
const target = targetOs ? ` --os=${targetOs} --cpu=${targetCpu || 'arm64'}` : '';
console.log('• production dependencies' + (targetOs ? ` for ${targetOs} ${targetCpu || 'arm64'}` : ''));
run('npm install --omit=dev --no-audit --no-fund --no-package-lock' + target, appDir);

// The CLI launchers resolve the core at app/node_modules/mindweave; fail here, not on a user's machine.
const entry = path.join(appDir, 'node_modules', 'mindweave', 'dist', 'index.js');
if (!fs.existsSync(entry)) throw new Error('core entry missing: ' + entry);
console.log('• staged at', appDir);
