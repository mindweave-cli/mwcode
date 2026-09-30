'use strict';
// The signed news feed: its format, its checks, and nothing else. Shared by the app (main.js)
// and by the publish tools, so what is published is judged by exactly the rules the app applies.
//
// A feed is two files: feed.json and feed.sig. The signature is Ed25519 over the exact bytes of
// feed.json (with a fixed prefix so it can never be mistaken for a signature of anything else).
// The app trusts NOTHING in feed.json until the signature checks out against the public key built
// into the app, and even then it rebuilds every item from an allow-list of fields: text only, no
// markup, https links to known hosts, pictures only by hash.

const crypto = require('crypto');

const FEED_REPO = 'mindweave-cli/mindweave-news';
const RAW_BASE = `https://raw.githubusercontent.com/${FEED_REPO}/main/`;
const FEED_URLS = [
  { json: `${RAW_BASE}feed.json`, sig: `${RAW_BASE}feed.sig` },
  // A copy through a CDN, in case the first host is unreachable. Both are equally untrusted:
  // only the signature makes a feed believable.
  { json: `https://cdn.jsdelivr.net/gh/${FEED_REPO}@main/feed.json`, sig: `https://cdn.jsdelivr.net/gh/${FEED_REPO}@main/feed.sig` },
];
const LINK_HOSTS = new Set(['github.com', 'mindweavedev.netlify.app', 'x.com']);
const IMAGE_PREFIX = RAW_BASE + 'images/';
const SIG_PREFIX = 'mwcode-feed-v1\n';

const LIMITS = {
  feedBytes: 512 * 1024,
  items: 50,
  imageBytes: 600 * 1024,
  imagesPerItem: 4,
  imagesTotal: 20,
};

// ── signature ────────────────────────────────────────────────────────────
function signFeed(jsonBytes, privateKeyPem) {
  return crypto.sign(null, Buffer.concat([Buffer.from(SIG_PREFIX), jsonBytes]), privateKeyPem).toString('base64');
}

function verifyFeed(jsonBytes, sigBase64, publicKeyPem) {
  try {
    const sig = Buffer.from(String(sigBase64).trim(), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.concat([Buffer.from(SIG_PREFIX), jsonBytes]), publicKeyPem, sig);
  } catch {
    return false;
  }
}

// ── plain-value helpers ──────────────────────────────────────────────────
// Text only: control characters out, length capped. Markup is not interpreted anywhere.
// Control characters and the invisible characters that reorder text, built from escapes so no literal one sits in this file.
const CONTROL = new RegExp('[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]', 'g');
function text(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, '').trim();
  if (!s || s.length > max) return null;
  return s;
}

function httpsUrl(v, hosts) {
  try {
    const u = new URL(String(v));
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (u.port && u.port !== '443') return null;
    if (!hosts.has(u.hostname.toLowerCase())) return null;
    return u.href;
  } catch {
    return null;
  }
}

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const isoOk = (v) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v));
// The one command the feed may offer to copy. A fixed shape, never free text.
const COMMAND = /^npm install -g mindweave(@[\w.\-]{1,20})?$/;

// ── one item ─────────────────────────────────────────────────────────────
// Returns a clean item or null. Only the fields listed here ever leave this function.
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.id) ? raw.id : null;
  const kind = raw.kind === 'news' || raw.kind === 'update' ? raw.kind : null;
  const title = text(raw.title, 120);
  const summary = text(raw.summary, 400);
  if (!id || !kind || !title || !summary || !isoOk(raw.date)) return null;
  const item = { id, kind, date: raw.date.slice(0, 10), title, summary, points: [], sections: [], images: [] };

  if (kind === 'update') {
    if (!['app', 'core', 'cli'].includes(raw.area)) return null;
    item.area = raw.area;
    if (raw.version !== undefined) {
      if (!SEMVER.test(String(raw.version))) return null;
      item.version = String(raw.version);
    }
    if (raw.command !== undefined) {
      const c = text(raw.command, 80);
      if (!c || !COMMAND.test(c)) return null;
      item.command = c;
    }
  }

  if (Array.isArray(raw.points)) {
    for (const p of raw.points.slice(0, 8)) { const t = text(p, 240); if (t) item.points.push(t); }
  }
  if (Array.isArray(raw.sections)) {
    for (const s of raw.sections.slice(0, 12)) {
      const h = text(s?.h, 80);
      if (!h) continue;
      const sec = { h };
      const body = text(s.text, 2000);
      if (body) sec.text = body;
      if (Array.isArray(s.list)) sec.list = s.list.slice(0, 12).map((x) => text(x, 300)).filter(Boolean);
      if (sec.text || sec.list?.length) item.sections.push(sec);
    }
  }
  if (Array.isArray(raw.images)) {
    for (const im of raw.images.slice(0, LIMITS.imagesPerItem)) {
      const src = typeof im?.src === 'string' && im.src.startsWith(IMAGE_PREFIX) && httpsUrl(im.src, new Set(['raw.githubusercontent.com'])) ? im.src : null;
      const sha256 = typeof im?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(im.sha256) ? im.sha256 : null;
      if (!src || !sha256) continue;
      const one = { src, sha256, alt: text(im.alt, 200) || '' };
      const cap = text(im.caption, 200);
      if (cap) one.caption = cap;
      item.images.push(one);
    }
  }
  if (raw.link !== undefined) {
    const url = httpsUrl(raw.link?.url, LINK_HOSTS);
    const label = text(raw.link?.label, 60);
    if (url && label) item.link = { label, url };
  }
  // Buttons under the item ("GitHub", "X", "Website"): up to four, https to the allowed hosts only.
  if (Array.isArray(raw.links)) {
    item.links = raw.links.slice(0, 4).map((l) => {
      const url = httpsUrl(l?.url, LINK_HOSTS);
      const label = text(l?.label, 40);
      return url && label ? { label, url } : null;
    }).filter(Boolean);
  }
  if (raw.minVersion !== undefined) { if (!SEMVER.test(String(raw.minVersion))) return null; item.minVersion = String(raw.minVersion); }
  if (raw.maxVersion !== undefined) { if (!SEMVER.test(String(raw.maxVersion))) return null; item.maxVersion = String(raw.maxVersion); }
  if (raw.expires !== undefined) { if (!isoOk(raw.expires)) return null; item.expires = raw.expires; }
  return item;
}

// ── the whole feed ───────────────────────────────────────────────────────
// Bytes in, clean feed out. Throws a short reason if the feed as a whole is not acceptable.
// Individual bad items are dropped, not fatal.
function parseFeed(jsonBytes) {
  if (jsonBytes.length > LIMITS.feedBytes) throw new Error('feed too large');
  let raw;
  try { raw = JSON.parse(jsonBytes.toString('utf8')); } catch { throw new Error('feed is not JSON'); }
  if (!raw || raw.v !== 1) throw new Error('unknown feed version');
  if (!Number.isInteger(raw.seq) || raw.seq < 1) throw new Error('bad sequence');
  if (!isoOk(raw.issued)) throw new Error('bad issue date');
  if (!Array.isArray(raw.items) || raw.items.length > LIMITS.items) throw new Error('bad items');
  const seen = new Set();
  const items = [];
  let images = 0;
  for (const r of raw.items) {
    const it = cleanItem(r);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    it.images = it.images.slice(0, Math.max(0, LIMITS.imagesTotal - images));
    images += it.images.length;
    items.push(it);
  }
  return { seq: raw.seq, issued: raw.issued, items };
}

// Which items this copy should show right now. `versions` is what is installed: { app, core, cli }.
// News and app updates are judged by the app's version, a core update by the core's, a CLI update
// by the CLI's. An update you already have is not news.
function applicable(items, { versions, now = Date.now() }) {
  return items.filter((it) => {
    if (it.expires && Date.parse(it.expires) < now) return false;
    const have = versions[it.kind === 'update' ? it.area : 'app'];
    if (!SEMVER.test(String(have))) return true;
    if (it.minVersion && cmpVersion(have, it.minVersion) < 0) return false;
    if (it.maxVersion && cmpVersion(have, it.maxVersion) > 0) return false;
    if (it.kind === 'update' && it.version && cmpVersion(have, it.version) >= 0) return false;
    return true;
  });
}

// A downloaded picture, judged by what it really is: only these four raster types, by their first bytes.
function imageMime(buf) {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.length > 6 && (buf.slice(0, 6).toString() === 'GIF87a' || buf.slice(0, 6).toString() === 'GIF89a')) return 'image/gif';
  return null;
}
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = {
  FEED_REPO, RAW_BASE, FEED_URLS, LINK_HOSTS, IMAGE_PREFIX, LIMITS, SIG_PREFIX,
  signFeed, verifyFeed, parseFeed, cleanItem, applicable, imageMime, sha256Hex, cmpVersion, SEMVER,
};
