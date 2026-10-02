// Which terminal version is really on this computer, and when the app may update it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectCli, updateCli, findOnPath } = require('./cliUpdate.js');

// A fake machine: the files that exist, and what each program prints.
function machine({ files, platform = 'win32', versions = {}, npmLs = '{}', install = { ok: true } }) {
  const calls = [];
  const execFileFn = (line, argv, _opts, cb) => {
    // A .cmd runs as one quoted line through the shell; anything else as a file and its arguments.
    const quoted = /^"([^"]+)"\s*(.*)$/.exec(line);
    const file = quoted ? quoted[1] : line;
    const args = quoted ? quoted[2].split(' ').filter(Boolean) : argv;
    calls.push([file, ...args]);
    const key = file;
    if (args[0] === '--version') return cb(versions[key] ? null : new Error('x'), versions[key] || '', '');
    if (args[0] === 'ls') return cb(null, npmLs, '');
    if (args[0] === 'install') return install.ok ? cb(null, 'added 1 package', '') : cb(new Error('fail'), '', install.stderr || '');
    cb(new Error('unexpected'), '', '');
  };
  const sep = platform === 'win32' ? ';' : ':';
  return { calls, opts: { env: { PATH: files.dirs.join(sep) }, platform, exists: (f) => files.have.includes(f), execFileFn, bundledDir: files.bundled || null } };
}

const NPM_DIR = 'C:\\Users\\a\\AppData\\Roaming\\npm';
const APP_BIN = 'C:\\Users\\a\\AppData\\Local\\Programs\\mwcode\\resources\\bin';

test('the copy that really runs is the one judged, not the app\'s own', async () => {
  const m = machine({
    files: { dirs: [NPM_DIR], have: [`${NPM_DIR}\\mindweave.cmd`, `${NPM_DIR}\\npm.cmd`], bundled: APP_BIN },
    versions: { [`${NPM_DIR}\\mindweave.cmd`]: 'mindweave 3.0.1\n' },
    npmLs: JSON.stringify({ dependencies: { mindweave: { version: '3.0.1' } } }),
  });
  const s = await detectCli(m.opts);
  assert.equal(s.version, '3.0.1');
  assert.equal(s.source, 'npm');
  assert.equal(s.canUpdate, true);
});

test('the app\'s own copy is never updated from here: it moves with the app', async () => {
  const m = machine({
    files: { dirs: [APP_BIN, NPM_DIR], have: [`${APP_BIN}\\mindweave.cmd`, `${NPM_DIR}\\npm.cmd`], bundled: APP_BIN.toUpperCase() },
    versions: { [`${APP_BIN}\\mindweave.cmd`]: 'mindweave 3.0.0\n' },
    npmLs: JSON.stringify({ dependencies: { mindweave: { version: '3.0.1' } } }),
  });
  const s = await detectCli(m.opts);
  assert.equal(s.source, 'bundled');
  assert.equal(s.canUpdate, false);
  assert.equal(m.calls.some((c) => c[1] === 'ls'), false, 'npm is not even asked');
});

test('a copy npm does not know about is left alone', async () => {
  const m = machine({
    files: { dirs: ['/opt/tools', '/usr/bin'], have: ['/opt/tools/mindweave', '/usr/bin/npm'], bundled: null },
    platform: 'linux',
    versions: { '/opt/tools/mindweave': 'mindweave 3.0.0\n' },
    npmLs: '{}',
  });
  const s = await detectCli(m.opts);
  assert.deepEqual([s.source, s.canUpdate, s.version], ['other', false, '3.0.0']);
});

test('no terminal version at all, and an unreadable version, are both plain answers', async () => {
  const none = await detectCli(machine({ files: { dirs: ['/usr/bin'], have: [] }, platform: 'linux' }).opts);
  assert.deepEqual([none.found, none.source, none.canUpdate], [false, 'none', false]);
  const broken = await detectCli(machine({ files: { dirs: ['/usr/bin'], have: ['/usr/bin/mw'] }, platform: 'linux' }).opts);
  assert.equal(broken.version, null);
});

test('mindweave is preferred over mw, and .cmd is found on Windows', () => {
  const have = [`${NPM_DIR}\\mw.cmd`, `${NPM_DIR}\\mindweave.cmd`];
  assert.equal(findOnPath('mindweave', { env: { PATH: NPM_DIR }, platform: 'win32', exists: (f) => have.includes(f) }), `${NPM_DIR}\\mindweave.cmd`);
});

test('updating runs npm with fixed arguments, then reads the new version', async () => {
  const m = machine({
    files: { dirs: [NPM_DIR], have: [`${NPM_DIR}\\mindweave.cmd`, `${NPM_DIR}\\npm.cmd`], bundled: APP_BIN },
    versions: { [`${NPM_DIR}\\mindweave.cmd`]: 'mindweave 3.0.2\n' },
    npmLs: JSON.stringify({ dependencies: { mindweave: {} } }),
  });
  const r = await updateCli({ canUpdate: true, npm: `${NPM_DIR}\\npm.cmd` }, m.opts);
  assert.equal(r.ok, true);
  assert.equal(r.state.version, '3.0.2');
  assert.deepEqual(m.calls.find((c) => c[1] === 'install').slice(1), ['install', '-g', 'mindweave@latest']);
});

test('a copy that is not npm\'s, or the app\'s own, is refused without running anything', async () => {
  const m = machine({ files: { dirs: [], have: [] } });
  for (const state of [{ canUpdate: false }, { canUpdate: true }, null]) {
    const r = await updateCli(state, m.opts);
    assert.equal(r.ok, false);
  }
  assert.equal(m.calls.length, 0);
});

test('failures say what to do, in plain words', async () => {
  const fail = (stderr) => updateCli({ canUpdate: true, npm: `${NPM_DIR}\\npm.cmd` }, machine({ files: { dirs: [], have: [] }, install: { ok: false, stderr } }).opts);
  assert.match((await fail('npm error code EACCES')).error, /not allowed/);
  assert.match((await fail('npm error code EBUSY')).error, /open in a terminal/);
  assert.match((await fail('npm error code ENOTFOUND')).error, /reach npm/);
  assert.match((await fail('some other\nthing broke')).error, /thing broke/);
});

test('Linux and macOS: a link into the app is the app\'s own copy, wherever the link sits', async () => {
  // The .deb links /usr/bin/mw into /opt/mwcode/resources/bin; the Mac "add the command line" step
  // links /usr/local/bin/mw into the app. Only the target says whose copy it is.
  const m = machine({
    files: { dirs: ['/usr/bin'], have: ['/usr/bin/mindweave', '/usr/bin/npm'], bundled: '/opt/mwcode/resources/bin' },
    platform: 'linux',
    versions: { '/usr/bin/mindweave': 'mindweave 3.0.1\n' },
    npmLs: JSON.stringify({ dependencies: { mindweave: {} } }),
  });
  const real = (f) => (f === '/usr/bin/mindweave' ? '/opt/mwcode/resources/bin/mindweave' : f);
  const s = await detectCli({ ...m.opts, realpath: real });
  assert.deepEqual([s.source, s.canUpdate], ['bundled', false]);
  assert.equal(m.calls.some((c) => c[1] === 'ls'), false);
  // The same link, were it NOT into the app, is a copy npm may own.
  const other = await detectCli({ ...m.opts, realpath: (f) => f });
  assert.equal(other.source, 'npm');
});

test('macOS paths: a copy under Homebrew or nvm is updated through the npm beside it', async () => {
  const dir = '/Users/a/.nvm/versions/node/v24.0.0/bin';
  const m = machine({
    files: { dirs: [dir], have: [`${dir}/mindweave`, `${dir}/npm`], bundled: '/Applications/mwcode.app/Contents/Resources/bin' },
    platform: 'linux',
    versions: { [`${dir}/mindweave`]: 'mindweave 3.0.0\n' },
    npmLs: JSON.stringify({ dependencies: { mindweave: {} } }),
  });
  const s = await detectCli({ ...m.opts, realpath: (f) => f });
  assert.deepEqual([s.source, s.canUpdate, s.npm], ['npm', true, `${dir}/npm`]);
});
