// The updater's rules: what it will believe, what it will download, and what it will run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('./updateCore.js');
const apply = require('./apply.js');
const { createUpdateService } = require('./updateService.js');
const feedCore = require('../news/feedCore.js');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });
const other = crypto.generateKeyPairSync('ed25519');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const url = (v, name) => `${core.ASSET_PREFIX}v${v}/${name}`;
const INSTALLER = Buffer.from('pretend installer bytes '.repeat(500));

function manifestFor(version, bytes = INSTALLER, extra = {}) {
  return {
    v: 1, seq: 100, issued: '2026-10-02T10:00:00Z', version, notes: 'Small fixes.',
    assets: { 'win32-x64': { url: url(version, 'mwcode-Setup.exe'), size: bytes.length, sha256: sha(bytes) } },
    ...extra,
  };
}
const bytesOf = (m) => Buffer.from(JSON.stringify(m));

// ── the signature ────────────────────────────────────────────────────────
test('a manifest verifies only with the key that signed it, and any change breaks it', () => {
  const json = bytesOf(manifestFor('1.0.1'));
  const sig = core.signManifest(json, PRIV);
  assert.equal(core.verifyManifest(json, sig, PUB), true);
  assert.equal(core.verifyManifest(Buffer.concat([json, Buffer.from(' ')]), sig, PUB), false, 'a changed byte');
  assert.equal(core.verifyManifest(json, sig, other.publicKey.export({ type: 'spki', format: 'pem' })), false, 'another key');
  assert.equal(core.verifyManifest(json, 'not a signature', PUB), false);
  assert.equal(core.verifyManifest(json, '', PUB), false);
});

test('a news-feed signature can never pass as an update signature', () => {
  const json = bytesOf(manifestFor('1.0.1'));
  const asFeed = feedCore.signFeed(json, PRIV); // same key, the feed's prefix
  assert.equal(core.verifyManifest(json, asFeed, PUB), false);
});

// ── the manifest ─────────────────────────────────────────────────────────
test('a well-formed manifest is accepted and cleaned', () => {
  const m = core.parseManifest(bytesOf(manifestFor('1.0.1', INSTALLER, { evil: '<script>' })));
  assert.equal(m.version, '1.0.1');
  assert.equal(m.assets['win32-x64'].sha256, sha(INSTALLER));
  assert.equal(m.evil, undefined, 'unknown fields are dropped');
});

test('installers may only come from this project\'s release downloads', () => {
  const bad = [
    'http://github.com/mindweave-cli/mwcode/releases/download/v1.0.1/a.exe',
    'https://evil.example/mindweave-cli/mwcode/releases/download/v1.0.1/a.exe',
    'https://github.com/someone-else/mwcode/releases/download/v1.0.1/a.exe',
    'https://github.com/mindweave-cli/mwcode/releases/download/v1.0.1/../../a.exe',
    'https://github.com/mindweave-cli/mwcode/releases/download/v1.0.1/a.exe?x=1',
    'https://user:pw@github.com/mindweave-cli/mwcode/releases/download/v1.0.1/a.exe',
    'https://github.com:444/mindweave-cli/mwcode/releases/download/v1.0.1/a.exe',
    'https://github.com/mindweave-cli/mwcode/releases/download/v1.0.1/sub/a.exe',
    'https://github.com/mindweave-cli/mwcode/releases/download/latest/a.exe',
    'https://github.com/mindweave-cli/mwcode/releases/download/v1.0.1/.hidden',
  ];
  for (const u of bad) assert.equal(core.assetUrl(u), null, u);
  assert.ok(core.assetUrl(url('1.0.1', 'mwcode-Setup.exe')));
  for (const u of bad) {
    const m = manifestFor('1.0.1');
    m.assets['win32-x64'].url = u;
    assert.throws(() => core.parseManifest(bytesOf(m)), /bad asset/, u);
  }
});

test('a manifest with a bad hash, size, version or shape is refused', () => {
  const mutate = (fn) => { const m = manifestFor('1.0.1'); fn(m); return bytesOf(m); };
  assert.throws(() => core.parseManifest(mutate((m) => { m.assets['win32-x64'].sha256 = 'abc'; })), /bad asset/);
  assert.throws(() => core.parseManifest(mutate((m) => { m.assets['win32-x64'].size = -1; })), /bad asset/);
  assert.throws(() => core.parseManifest(mutate((m) => { m.assets['win32-x64'].size = 9e12; })), /bad asset/);
  assert.throws(() => core.parseManifest(mutate((m) => { m.version = '1.0'; })), /bad version/);
  assert.throws(() => core.parseManifest(mutate((m) => { m.v = 2; })), /unknown manifest/);
  assert.throws(() => core.parseManifest(mutate((m) => { m.seq = 0; })), /bad sequence/);
  assert.throws(() => core.parseManifest(mutate((m) => { m.assets = {}; })), /no usable/);
  assert.throws(() => core.parseManifest(Buffer.from('nope')), /not JSON/);
  assert.throws(() => core.parseManifest(Buffer.alloc(core.LIMITS.manifestBytes + 1)), /too large/);
});

test('only a newer version, in a manifest no older than one already seen, is acted on', () => {
  const m = core.parseManifest(bytesOf(manifestFor('1.0.1')));
  assert.equal(core.judge(m, { current: '1.0.0', lastSeq: 50 }).ok, true);
  assert.equal(core.judge(m, { current: '1.0.1', lastSeq: 50 }).ok, false, 'same version');
  assert.equal(core.judge(m, { current: '1.2.0', lastSeq: 50 }).ok, false, 'older version');
  assert.equal(core.judge(m, { current: '1.0.0', lastSeq: 101 }).ok, false, 'replayed old manifest');
  assert.equal(core.judge(m, { current: 'dev', lastSeq: 0 }).ok, false, 'unknown current version');
  assert.equal(core.cmpVersion('1.10.0', '1.9.0'), 1, 'numbers, not text');
});

test('each system takes only its own file', () => {
  assert.equal(core.platformKey('win32', 'x64', false), 'win32-x64');
  assert.equal(core.platformKey('darwin', 'arm64', false), 'darwin-arm64');
  assert.equal(core.platformKey('darwin', 'x64', false), null, 'Intel Macs have no build');
  assert.equal(core.platformKey('linux', 'x64', true), 'linux-x64-appimage');
  assert.equal(core.platformKey('linux', 'x64', false), null, 'a .deb cannot replace itself');
});

// ── what a copy of the app can do ────────────────────────────────────────
test('capability: source checkouts, .deb installs and translocated Mac apps do not self-update', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cap-'));
  assert.equal(apply.capability({ packaged: false, userData: tmp }).mode, 'none');
  assert.equal(apply.capability({ platform: 'linux', packaged: true, env: {}, userData: tmp }).mode, 'manual');
  const app = path.join(tmp, 'mwcode.AppImage');
  fs.writeFileSync(app, 'x');
  assert.equal(apply.capability({ platform: 'linux', packaged: true, env: { APPIMAGE: app }, userData: tmp }).mode, 'auto');
  const t = apply.capability({ platform: 'darwin', packaged: true, execPath: '/private/var/folders/x/AppTranslocation/ABC/d/mwcode.app/Contents/MacOS/mwcode', userData: tmp });
  assert.equal(t.mode, 'manual');
  assert.match(t.reason, /Applications/);
  assert.equal(apply.capability({ platform: 'win32', packaged: true, userData: tmp }).mode, 'auto');
});

test('an all-users Windows install is updated with the installer\'s own window, not silently', () => {
  const env = { ProgramFiles: 'C:\\Program Files' };
  assert.equal(apply.needsElevation('C:\\Program Files\\mwcode\\mwcode.exe', env), true);
  assert.equal(apply.needsElevation('C:\\Users\\a\\AppData\\Local\\Programs\\mwcode\\mwcode.exe', env), false);
  assert.deepEqual(apply.winArgs(), ['--updated', '/S', '--force-run']);
});

test('the Mac swap script waits for the app, checks the new one, and puts the old one back on failure', () => {
  const s = apply.macScript();
  for (const needle of ['kill -0 "$pid"', 'ditto -x -k', 'codesign --verify', 'mv "$target" "$backup"', 'mv "$backup" "$target"', 'xattr -dr com.apple.quarantine', 'open "$target"']) {
    assert.ok(s.includes(needle), needle);
  }
  assert.ok(s.indexOf('codesign --verify') < s.indexOf('mv "$target" "$backup"'), 'the new app is checked BEFORE the old one is touched');
  if (process.platform !== 'win32') {
    const f = path.join(os.tmpdir(), `mw-mac-${process.pid}.sh`);
    fs.writeFileSync(f, s);
    const r = require('node:child_process').spawnSync('sh', ['-n', f]);
    assert.equal(r.status, 0, String(r.stderr));
    fs.rmSync(f);
  }
});

// ── the service, against a pretend network ───────────────────────────────
function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(body.length) : null) },
    body: (async function* () { for (let i = 0; i < body.length; i += 4096) yield body.subarray(i, i + 4096); })(),
  };
}

function rig({ current = '1.0.0', manifest = manifestFor('1.0.1'), sign = PRIV, installer = INSTALLER, signManifestBytes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-upd-'));
  const json = signManifestBytes || bytesOf(manifest);
  const files = {
    'https://m/update.json': json,
    'https://m/update.sig': Buffer.from(core.signManifest(bytesOf(manifest), sign)),
    [manifest.assets['win32-x64'].url]: installer,
  };
  const calls = [];
  const events = [];
  let applied = null;
  let quit = 0;
  const svc = createUpdateService({
    dir, current, publicKey: PUB, packaged: true, platform: 'win32', arch: 'x64', env: {}, execPath: 'C:\\Users\\a\\mwcode.exe',
    urls: { manifest: 'https://m/update.json', sig: 'https://m/update.sig' },
    fetchFn: async (u) => { calls.push(u); return files[u] ? response(files[u]) : response(Buffer.alloc(0), { status: 404 }); },
    onChange: (s) => events.push(s.status),
    applyFn: (cap, a) => { applied = a; },
    quit: () => { quit++; },
  });
  return { svc, dir, calls, events, get applied() { return applied; }, get quit() { return quit; }, files };
}

test('a newer signed release is downloaded, verified, and installed only when asked', async () => {
  const r = rig();
  await r.svc.check({ force: true });
  assert.equal(r.svc.get().status, 'available');
  assert.ok(!r.calls.some((u) => u.includes('releases/download')), 'nothing is downloaded until the user asks');
  await r.svc.download();
  const s = r.svc.get();
  assert.equal(s.status, 'ready');
  assert.equal(s.version, '1.0.1');
  assert.equal(s.pct, 100);
  assert.deepEqual(r.events.filter((e, i, a) => a.indexOf(e) === i), ['checking', 'available', 'downloading', 'ready']);
  assert.equal(r.applied, null, 'nothing is run until the user restarts');
  await r.svc.restart();
  assert.ok(r.applied.file.endsWith('mwcode-Setup.exe'));
  assert.equal(r.quit, 1);
});

test('a manifest signed with the wrong key is ignored and nothing is downloaded', async () => {
  const r = rig({ sign: other.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  await r.svc.check({ force: true });
  assert.equal(r.svc.get().status, 'error');
  assert.match(r.svc.get().error, /not signed/);
  assert.ok(!r.calls.some((u) => u.includes('releases/download')), 'the installer was never requested');
});

test('an installer whose bytes do not match the signed fingerprint is thrown away', async () => {
  const bad = Buffer.from('x'.repeat(INSTALLER.length)); // right size, wrong content
  const r = rig({ installer: bad });
  await r.svc.check({ force: true });
  await r.svc.download();
  const s = r.svc.get();
  assert.notEqual(s.status, 'ready');
  assert.match(s.error, /fingerprint/);
  const left = fs.existsSync(path.join(r.dir, 'updates', '1.0.1')) ? fs.readdirSync(path.join(r.dir, 'updates', '1.0.1')) : [];
  assert.deepEqual(left, [], 'no partial or bad file is left behind');
  await r.svc.restart();
  assert.equal(r.applied, null);
});

test('a download of the wrong size is refused', async () => {
  const r = rig({ installer: Buffer.concat([INSTALLER, Buffer.from('extra')]) });
  await r.svc.check({ force: true });
  await r.svc.download();
  assert.notEqual(r.svc.get().status, 'ready');
  assert.match(r.svc.get().error, /size|larger|signed/);
});

test('a release that is not newer, or an older manifest replayed, offers nothing', async () => {
  const same = rig({ current: '1.0.1' });
  await same.svc.check({ force: true });
  assert.equal(same.svc.get().status, 'idle');
  const old = rig();
  fs.writeFileSync(path.join(old.dir, 'update-state.json'), JSON.stringify({ lastSeq: 500, checkedAt: 1 }));
  await old.svc.check({ force: true });
  assert.equal(old.svc.get().status, 'idle', 'seq 100 is older than the 500 already seen');
});

test('a file changed on disk between download and install is not run', async () => {
  const r = rig();
  await r.svc.check({ force: true });
  await r.svc.download();
  fs.appendFileSync(r.applied?.file || path.join(r.dir, 'updates', '1.0.1', 'mwcode-Setup.exe'), 'tampered');
  await r.svc.restart();
  assert.equal(r.applied, null);
  assert.equal(r.quit, 0, 'the app does not quit for an update it refused');
  assert.equal(r.svc.get().status, 'available');
  assert.match(r.svc.get().error, /changed/);
});

test('a finished download from an earlier run is reused, not fetched again', async () => {
  const r = rig();
  await r.svc.check({ force: true });
  await r.svc.download();
  const installerFetches = () => r.calls.filter((u) => u.includes('releases/download')).length;
  assert.equal(installerFetches(), 1);
  const second = createUpdateService({
    dir: r.dir, current: '1.0.0', publicKey: PUB, packaged: true, platform: 'win32', arch: 'x64', env: {}, execPath: 'C:\\Users\\a\\mwcode.exe',
    urls: { manifest: 'https://m/update.json', sig: 'https://m/update.sig' },
    fetchFn: async (u) => { r.calls.push(u); return response(r.files[u]); },
  });
  fs.writeFileSync(path.join(r.dir, 'update-state.json'), JSON.stringify({ lastSeq: 0, checkedAt: 0 }));
  await second.check({ force: true });
  await second.download();
  assert.equal(second.get().status, 'ready');
  assert.equal(installerFetches(), 1);
});

test('a copy that is not installed (source checkout) never looks for updates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-upd-'));
  let hit = 0;
  const svc = createUpdateService({ dir, current: '1.0.0', publicKey: PUB, packaged: false, fetchFn: async () => { hit++; return response(Buffer.alloc(0)); } });
  await svc.check({ force: true });
  svc.start();
  svc.stop();
  assert.equal(hit, 0);
  assert.equal(svc.get().status, 'none');
});

test('a manual-install copy is told about the update but downloads nothing itself', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-upd-'));
  const m = manifestFor('1.0.1');
  m.assets['linux-x64-appimage'] = m.assets['win32-x64'];
  delete m.assets['win32-x64'];
  const files = { 'https://m/update.json': bytesOf(m), 'https://m/update.sig': Buffer.from(core.signManifest(bytesOf(m), PRIV)) };
  const seen = [];
  const svc = createUpdateService({
    dir, current: '1.0.0', publicKey: PUB, packaged: true, platform: 'linux', arch: 'x64', env: { APPIMAGE: path.join(dir, 'nope', 'x.AppImage') }, execPath: '/x',
    urls: { manifest: 'https://m/update.json', sig: 'https://m/update.sig' },
    fetchFn: async (u) => { seen.push(u); return response(files[u]); },
  });
  await svc.check({ force: true });
  assert.equal(svc.get().mode, 'manual');
  assert.equal(svc.get().status, 'available');
  assert.equal(svc.get().manualUrl, core.RELEASES_PAGE);
  assert.ok(!seen.some((u) => u.includes('releases/download')));
});

test('windows: an update never shows the setup window, per-user or all-users', () => {
  const file = 'C:/up/mwcode-Setup.exe';
  const helper = 'C:/mw/resources/elevate.exe';
  const run = (over) => {
    const calls = [];
    apply.applyWindows({ file, spawnFn: (f, a) => { calls.push([f, a]); return { unref() {} }; }, exists: () => true, ...over });
    return calls;
  };
  const silent = ['--updated', '/S', '--force-run'];
  assert.deepEqual(run({ interactive: false }), [[file, silent]]);
  // All-users: through the elevate helper (one permission prompt), still silent.
  assert.deepEqual(run({ interactive: true, elevateExe: helper }), [[helper, [file, ...silent]]]);
  // Only without the helper does the installer's own window remain.
  assert.deepEqual(run({ interactive: true, elevateExe: helper, exists: () => false }), [[file, ['--updated']]]);
  assert.deepEqual(run({ interactive: true }), [[file, ['--updated']]]);
});
