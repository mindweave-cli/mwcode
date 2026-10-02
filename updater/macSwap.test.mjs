// Runs the real macOS swap script against stand-ins for Apple's tools (ditto, codesign, xattr, open),
// so the parts that matter (waiting for the app to quit, replacing it, and putting the old one back
// when anything fails) are exercised for real. Skipped on Windows, which has no sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { macScript } = require('./apply.js');

const haveTools = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v zip && command -v unzip']).status === 0;

function rig({ codesignFails = false, copyFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-mac-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  tool('ditto', `if [ "$1" = "-x" ]; then unzip -q "$3" -d "$4"; else ${copyFails ? 'cp -a "$1" "$2.partial"; rm -rf "$2.partial"; exit 1' : 'cp -a "$1" "$2"'}; fi`);
  tool('codesign', codesignFails ? 'exit 1' : 'exit 0');
  tool('xattr', `echo "$@" >> "${root}/xattr.log"`);
  tool('open', `echo "$@" >> "${root}/open.log"`);
  tool('mktemp', 'exec /usr/bin/mktemp "$@"');
  tool('find', 'exec /usr/bin/find "$@"');

  const makeApp = (parent, marker) => {
    const app = path.join(parent, 'mwcode.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'mwcode'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(app, 'Contents', 'marker'), marker);
    return app;
  };
  const apps = path.join(root, 'Applications');
  fs.mkdirSync(apps);
  const target = makeApp(apps, 'old');
  const stage = path.join(root, 'stage');
  fs.mkdirSync(stage);
  makeApp(stage, 'new');
  const zip = path.join(root, 'update.zip');
  spawnSync('zip', ['-qry', zip, 'mwcode.app'], { cwd: stage });
  const script = path.join(root, 'apply.sh');
  fs.writeFileSync(script, macScript(), { mode: 0o700 });
  const log = path.join(root, 'apply.log');
  const run = (pid) => new Promise((resolve) => {
    const p = spawn('/bin/sh', [script, String(pid), zip, target, log], { env: { ...process.env, MW_BIN: bin }, stdio: 'ignore' });
    p.on('exit', (code) => resolve(code));
  });
  const marker = () => fs.readFileSync(path.join(target, 'Contents', 'marker'), 'utf8');
  const opened = () => (fs.existsSync(path.join(root, 'open.log')) ? fs.readFileSync(path.join(root, 'open.log'), 'utf8') : '');
  const quarantine = () => (fs.existsSync(path.join(root, 'xattr.log')) ? fs.readFileSync(path.join(root, 'xattr.log'), 'utf8') : '');
  return { root, apps, target, run, marker, opened, quarantine, log };
}

// A pid that is already gone, so the script does not wait.
const GONE = 2 ** 22 + 12345;

test('the new app replaces the old one, loses the quarantine mark, and is opened', { skip: !haveTools }, async () => {
  const r = rig();
  assert.equal(await r.run(GONE), 0);
  assert.equal(r.marker(), 'new');
  assert.match(r.quarantine(), /-dr com\.apple\.quarantine/);
  assert.match(r.opened(), /mwcode\.app/);
  assert.deepEqual(fs.readdirSync(r.apps), ['mwcode.app'], 'no backup is left behind');
});

test('it waits for the running app to quit before touching anything', { skip: !haveTools }, async () => {
  const r = rig();
  const sleeper = spawn('sleep', ['1.5'], { stdio: 'ignore' });
  const started = Date.now();
  const done = r.run(sleeper.pid);
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(r.marker(), 'old', 'still the old app while the old one is running');
  assert.equal(await done, 0);
  assert.ok(Date.now() - started >= 1200);
  assert.equal(r.marker(), 'new');
});

test('a new app that fails its signature check is never swapped in; the old one is reopened', { skip: !haveTools }, async () => {
  const r = rig({ codesignFails: true });
  assert.notEqual(await r.run(GONE), 0);
  assert.equal(r.marker(), 'old');
  assert.match(r.opened(), /mwcode\.app/);
  assert.deepEqual(fs.readdirSync(r.apps), ['mwcode.app']);
});

test('a copy that fails halfway puts the old app back', { skip: !haveTools }, async () => {
  const r = rig({ copyFails: true });
  await r.run(GONE);
  assert.equal(r.marker(), 'old');
  assert.deepEqual(fs.readdirSync(r.apps), ['mwcode.app'], 'no backup or half-copied app is left');
  assert.match(r.opened(), /mwcode\.app/);
});

test('a download with no app inside it changes nothing', { skip: !haveTools }, async () => {
  const r = rig();
  fs.writeFileSync(path.join(r.root, 'update.zip'), 'not a zip');
  assert.notEqual(await r.run(GONE), 0);
  assert.equal(r.marker(), 'old');
});
