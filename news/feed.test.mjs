// node --test news/feed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('./feedCore.js');
const { createFeedService } = require('./feedService.js');

const keys = crypto.generateKeyPairSync('ed25519');
const PRIV = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB = keys.publicKey.export({ type: 'spki', format: 'pem' });
const other = crypto.generateKeyPairSync('ed25519');

const item = (over = {}) => ({ id: 'a-1', kind: 'news', date: '2026-09-29', title: 'Hello', summary: 'A summary', ...over });
const feedBytes = (items, seq = 1) => Buffer.from(JSON.stringify({ v: 1, seq, issued: '2026-09-29T10:00:00Z', items }));
const sign = (bytes, key = PRIV) => core.signFeed(bytes, key);

// ── signature ────────────────────────────────────────────────────────────
test('a signed feed verifies; a changed byte, a wrong key and a bad signature do not', () => {
  const b = feedBytes([item()]);
  const sig = sign(b);
  assert.equal(core.verifyFeed(b, sig, PUB), true);
  assert.equal(core.verifyFeed(Buffer.concat([b, Buffer.from(' ')]), sig, PUB), false);
  assert.equal(core.verifyFeed(b, sign(b, other.privateKey.export({ type: 'pkcs8', format: 'pem' })), PUB), false);
  assert.equal(core.verifyFeed(b, 'AAAA', PUB), false);
  assert.equal(core.verifyFeed(b, '', PUB), false);
});

// ── what an item may contain ─────────────────────────────────────────────
test('items are rebuilt from an allow-list: unknown fields vanish', () => {
  const it = core.cleanItem(item({ evil: '<script>x</script>', onclick: 'x', html: '<b>hi</b>' }));
  assert.deepEqual(Object.keys(it).sort(), ['date', 'id', 'images', 'kind', 'points', 'sections', 'summary', 'title']);
});

test('links: only https on a known host survive', () => {
  const ok = (url) => core.cleanItem(item({ link: { label: 'x', url } }))?.link;
  assert.ok(ok('https://github.com/mindweave-cli/Mindweave/releases'));
  assert.equal(ok('http://github.com/x'), undefined);
  assert.equal(ok('https://evil.example/x'), undefined);
  assert.equal(ok('javascript:alert(1)'), undefined);
  assert.equal(ok('https://github.com.evil.example/x'), undefined);
  assert.equal(ok('https://user:pw@github.com/x'), undefined);
  assert.equal(ok('file:///c:/windows'), undefined);
});

test('the copy command may only be the one fixed shape', () => {
  const cmd = (command) => core.cleanItem(item({ kind: 'update', area: 'cli', command }));
  assert.ok(cmd('npm install -g mindweave@latest'));
  assert.ok(cmd('npm install -g mindweave'));
  assert.equal(cmd('npm install -g mindweave && calc'), null);
  assert.equal(cmd('curl x | sh'), null);
});

test('bad shapes are refused: kind, area, ids, dates, versions', () => {
  assert.equal(core.cleanItem(item({ kind: 'ad' })), null);
  assert.equal(core.cleanItem(item({ kind: 'update', area: 'web' })), null);
  assert.equal(core.cleanItem(item({ id: '../x' })), null);
  assert.equal(core.cleanItem(item({ date: 'yesterday' })), null);
  assert.equal(core.cleanItem(item({ kind: 'update', area: 'app', version: '1.2' })), null);
  assert.equal(core.cleanItem(item({ title: 'x'.repeat(121) })), null);
});

test('text loses control and direction-changing characters', () => {
  const it = core.cleanItem(item({ title: 'Hi\u202Ethere\u0000!' }));
  assert.equal(it.title, 'Hithere!');
});

test('pictures need the repo address and a hash', () => {
  const good = { src: core.IMAGE_PREFIX + 'a.png', sha256: 'a'.repeat(64), alt: 'x' };
  assert.equal(core.cleanItem(item({ images: [good] })).images.length, 1);
  assert.equal(core.cleanItem(item({ images: [{ ...good, src: 'https://evil.example/a.png' }] })).images.length, 0);
  assert.equal(core.cleanItem(item({ images: [{ ...good, sha256: 'nope' }] })).images.length, 0);
  assert.equal(core.cleanItem(item({ images: [{ ...good, src: 'data:image/png;base64,AAAA' }] })).images.length, 0);
});

test('image types are judged by their bytes', () => {
  assert.equal(core.imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  assert.equal(core.imageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(core.imageMime(Buffer.from('<html>')), null);
});

// ── whole feed ───────────────────────────────────────────────────────────
test('a bad item is dropped, the rest stay; a bad feed is refused', () => {
  const p = core.parseFeed(feedBytes([item(), item({ id: 'b', kind: 'nope' }), item({ id: 'a-1' })]));
  assert.deepEqual(p.items.map((i) => i.id), ['a-1']);
  assert.throws(() => core.parseFeed(Buffer.from('{"v":2,"seq":1,"issued":"2026-09-29","items":[]}')));
  assert.throws(() => core.parseFeed(Buffer.from('not json')));
  assert.throws(() => core.parseFeed(Buffer.alloc(core.LIMITS.feedBytes + 1)));
  assert.throws(() => core.parseFeed(feedBytes([], 0)));
});

test('targeting: version range and expiry', () => {
  const items = ['old', 'new', 'gone', 'open'].map((id) => item({ id }));
  items[0].maxVersion = '2.0.0';
  items[1].minVersion = '3.0.0';
  items[2].expires = '2026-01-01';
  const clean = items.map(core.cleanItem);
  const ids = (v) => core.applicable(clean, { versions: { app: v, core: v, cli: v }, now: Date.parse('2026-09-29') }).map((i) => i.id);
  assert.deepEqual(ids('2.5.1'), ['open']);
  assert.deepEqual(ids('3.1.0'), ['new', 'open']);
  assert.deepEqual(ids('1.9.9'), ['old', 'open']);
});

// ── the service ──────────────────────────────────────────────────────────
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mwfeed-')); }
function response(buf, status = 200) {
  return { ok: status === 200, status, headers: { get: () => String(buf.length) }, body: (async function* () { yield buf; })() };
}
function host(files) { return async (url) => (files[url] ? response(files[url]) : response(Buffer.alloc(0), 404)); }
const URLS = [{ json: 'https://x/feed.json', sig: 'https://x/feed.sig' }];
function service(files, dir = tmp(), extra = {}) {
  const updates = [];
  const svc = createFeedService({ dir, versions: () => ({ app: '3.0.0', core: '3.0.0', cli: '3.0.0' }), publicKey: PUB, fetchFn: host(files), urls: URLS, onUpdate: (r) => updates.push(r), ...extra });
  return { svc, dir, updates };
}
const publish = (items, seq, key = PRIV) => { const b = feedBytes(items, seq); return { 'https://x/feed.json': b, 'https://x/feed.sig': Buffer.from(sign(b, key)) }; };

test('service: the newest item is on top, whatever order the feed lists them in', async () => {
  const { svc } = service(publish([item({ id: 'mid', date: '2026-09-29' }), item({ id: 'new', date: '2026-09-30' }), item({ id: 'old', date: '2026-09-28' })], 1));
  const r = await svc.refresh();
  assert.deepEqual(r.items.map((i) => i.id), ['new', 'mid', 'old']);
});

test('service: a good feed is shown, formatted, and announced once', async () => {
  const { svc, updates } = service(publish([item({ id: 'x' })], 1));
  const r = await svc.refresh();
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].date, 'Sep 29, 2026');
  assert.equal(r.error, null);
  await svc.refresh();
  assert.equal(updates.length, 1, 'the same feed again changes nothing');
});

test('service: a feed signed with another key is refused and nothing is shown', async () => {
  const { svc } = service(publish([item()], 1, other.privateKey.export({ type: 'pkcs8', format: 'pem' })));
  const r = await svc.refresh();
  assert.equal(r.items.length, 0);
  assert.match(r.error, /signature/);
});

test('service: an older feed cannot replace a newer one (no rollback)', async () => {
  const dir = tmp();
  await service(publish([item({ id: 'new' })], 5), dir).svc.refresh();
  const r = await service(publish([item({ id: 'old' })], 4), dir).svc.refresh();
  assert.deepEqual(r.items.map((i) => i.id), ['new']);
  assert.match(r.error, /older/);
});

test('service: offline keeps the last good copy', async () => {
  const dir = tmp();
  await service(publish([item({ id: 'kept' })], 1), dir).svc.refresh();
  const r = await service({}, dir).svc.refresh();
  assert.deepEqual(r.items.map((i) => i.id), ['kept']);
  assert.ok(r.error);
});

test('service: the saved copy is checked again when read; a doctored file shows nothing', async () => {
  const { svc, dir } = service(publish([item({ id: 'real' })], 1));
  await svc.refresh();
  const f = path.join(dir, 'feed-state.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.feed.json = Buffer.from(feedBytes([item({ id: 'forged' })], 1)).toString('base64');
  fs.writeFileSync(f, JSON.stringify(s));
  assert.equal(svc.get().items.length, 0);
});

test('service: a picture is kept only if its bytes match the signed hash', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
  const good = { src: core.IMAGE_PREFIX + 'ok.png', sha256: core.sha256Hex(png), alt: 'ok' };
  const bad = { src: core.IMAGE_PREFIX + 'bad.png', sha256: core.sha256Hex(Buffer.from('something else')), alt: 'bad' };
  const files = { ...publish([item({ images: [good, bad] })], 1), [good.src]: png, [bad.src]: png };
  const { svc } = service(files);
  const r = await svc.refresh();
  assert.equal(r.items[0].images.length, 1);
  assert.match(r.items[0].images[0].src, /^data:image\/png;base64,/);
});

test('service: an oversized feed is refused', async () => {
  const big = Buffer.alloc(core.LIMITS.feedBytes + 10, 32);
  const { svc } = service({ 'https://x/feed.json': big, 'https://x/feed.sig': Buffer.from(sign(big)) });
  const r = await svc.refresh();
  assert.equal(r.items.length, 0);
});

test('service: a picture that drops out of the feed is deleted from disk', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pic')]);
  const im = { src: core.IMAGE_PREFIX + 'p.png', sha256: core.sha256Hex(png), alt: 'p' };
  const dir = tmp();
  await service({ ...publish([item({ images: [im] })], 1), [im.src]: png }, dir).svc.refresh();
  assert.ok(fs.existsSync(path.join(dir, 'feed-images', im.sha256)));
  await service(publish([item()], 2), dir).svc.refresh();
  assert.equal(fs.existsSync(path.join(dir, 'feed-images', im.sha256)), false);
});

test('an update you already have is not shown; each kind is judged by its own version', () => {
  const app = core.cleanItem(item({ id: 'app', kind: 'update', area: 'app', version: '3.1.0' }));
  const cli = core.cleanItem(item({ id: 'cli', kind: 'update', area: 'cli', version: '2.6.0' }));
  const news = core.cleanItem(item({ id: 'news', minVersion: '3.0.0' }));
  const ids = (versions) => core.applicable([app, cli, news], { versions, now: Date.parse('2026-09-29') }).map((i) => i.id);
  assert.deepEqual(ids({ app: '3.0.0', core: '2.5.1', cli: '2.5.1' }), ['app', 'cli', 'news']);
  assert.deepEqual(ids({ app: '3.1.0', core: '2.5.1', cli: '2.6.0' }), ['news']);
  assert.deepEqual(ids({ app: '2.9.0', core: '2.5.1', cli: '2.5.1' }), ['app', 'cli']);
});

test('service: what was read is kept on disk at once, and survives a new service and a refresh', async () => {
  const dir = tmp();
  const files = publish([item({ id: 'x' })], 1);
  const a = service(files, dir).svc;
  await a.refresh();
  a.markRead(['x', 'not valid!', '../y']);
  const b = service(files, dir).svc; // as after a restart
  assert.deepEqual(b.get().read, ['x']);
  await b.refresh();
  assert.deepEqual(b.get().read, ['x']);
});

test('link buttons: up to four, only https to allowed hosts', () => {
  const it = core.cleanItem(item({ links: [
    { label: 'GitHub', url: 'https://github.com/mindweave-cli/mindweave' },
    { label: 'X', url: 'https://x.com/mindweavecli' },
    { label: 'Bad', url: 'https://evil.example/x' },
    { label: 'Also bad', url: 'javascript:alert(1)' },
    { label: 'Site', url: 'https://mindweavedev.netlify.app/' },
    { label: 'Fifth', url: 'https://github.com/x' },
  ] }));
  assert.deepEqual(it.links.map((l) => l.label), ['GitHub', 'X']);
});
