'use strict';
// The signed update manifest: its format and its checks, and nothing else. Shared by the app
// (updateService.js) and by the publish tool, so what is published is judged by exactly the rules
// the app applies.
//
// A release carries two small files next to the installers: update.json and update.sig. The
// signature is Ed25519 over the exact bytes of update.json, with a fixed prefix so it can never be
// mistaken for a signature of anything else (the news feed uses a different prefix and a different
// key). update.json names the version and, for each platform, the file, its size and its SHA-256, so
// one signature covers the version AND the bytes of every installer. The app trusts nothing in it
// until the signature checks out against the public key built into the app, and an installer is
// used only if its size and hash match what was signed.

const crypto = require('crypto');

const REPO = 'mindweave-cli/mwcode';
const LATEST = `https://github.com/${REPO}/releases/latest/download/`;
const MANIFEST_URL = `${LATEST}update.json`;
const SIG_URL = `${LATEST}update.sig`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`;
const SIG_PREFIX = 'mwcode-update-v1\n';

const LIMITS = { manifestBytes: 64 * 1024, assetBytes: 600 * 1024 * 1024, notes: 400 };
const PLATFORMS = ['win32-x64', 'darwin-arm64', 'linux-x64-appimage'];

// ── signature ────────────────────────────────────────────────────────────
function signManifest(jsonBytes, privateKeyPem) {
  return crypto.sign(null, Buffer.concat([Buffer.from(SIG_PREFIX), jsonBytes]), privateKeyPem).toString('base64');
}

function verifyManifest(jsonBytes, sigBase64, publicKeyPem) {
  try {
    const sig = Buffer.from(String(sigBase64).trim(), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.concat([Buffer.from(SIG_PREFIX), jsonBytes]), publicKeyPem, sig);
  } catch {
    return false;
  }
}

// ── versions ─────────────────────────────────────────────────────────────
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

const CONTROL = new RegExp('[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f  ‪-‮⁦-⁩]', 'g');
function text(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, '').trim();
  return s && s.length <= max ? s : null;
}

// The only place an installer may come from: this project's release downloads, over https, and a
// plain file name at the end (no path tricks, no query).
function assetUrl(v) {
  try {
    const u = new URL(String(v));
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password || u.port || u.search || u.hash) return null;
    if (!u.href.startsWith(ASSET_PREFIX)) return null;
    const rest = u.pathname.slice(ASSET_PREFIX.length - 'https://github.com'.length).split('/');
    if (rest.length !== 2 || !/^v?\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(rest[0]) || !/^[A-Za-z0-9._-]{1,120}$/.test(rest[1]) || rest[1].startsWith('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}

// ── the manifest ─────────────────────────────────────────────────────────
// Bytes in, clean manifest out. Throws a short reason if it is not acceptable.
function parseManifest(jsonBytes) {
  if (jsonBytes.length > LIMITS.manifestBytes) throw new Error('manifest too large');
  let raw;
  try { raw = JSON.parse(jsonBytes.toString('utf8')); } catch { throw new Error('manifest is not JSON'); }
  if (!raw || raw.v !== 1) throw new Error('unknown manifest version');
  if (!Number.isInteger(raw.seq) || raw.seq < 1) throw new Error('bad sequence');
  if (typeof raw.issued !== 'string' || Number.isNaN(Date.parse(raw.issued))) throw new Error('bad issue date');
  if (!SEMVER.test(String(raw.version))) throw new Error('bad version');
  if (!raw.assets || typeof raw.assets !== 'object') throw new Error('no assets');
  const assets = {};
  for (const key of PLATFORMS) {
    const a = raw.assets[key];
    if (!a) continue;
    const url = assetUrl(a.url);
    const sha256 = typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256) ? a.sha256 : null;
    const size = Number.isInteger(a.size) && a.size > 0 && a.size <= LIMITS.assetBytes ? a.size : null;
    if (!url || !sha256 || !size) throw new Error(`bad asset for ${key}`);
    assets[key] = { url, sha256, size };
  }
  if (!Object.keys(assets).length) throw new Error('no usable assets');
  const out = { seq: raw.seq, issued: raw.issued, version: String(raw.version), assets };
  const notes = text(raw.notes, LIMITS.notes);
  if (notes) out.notes = notes;
  return out;
}

// Which asset this machine takes, or null. `appImage` is true when running from an AppImage.
function platformKey(platform, arch, appImage) {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64' && appImage) return 'linux-x64-appimage';
  return null;
}

// Is this manifest worth acting on? It must be newer than what is installed, and no older than one
// already accepted (a replayed old manifest is refused, so nobody can walk users back a version).
function judge(manifest, { current, lastSeq }) {
  if (!SEMVER.test(String(current))) return { ok: false, reason: 'unknown current version' };
  if (manifest.seq < lastSeq) return { ok: false, reason: 'older than one already seen' };
  if (cmpVersion(manifest.version, current) <= 0) return { ok: false, reason: 'not newer' };
  return { ok: true };
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = {
  REPO, MANIFEST_URL, SIG_URL, RELEASES_PAGE, ASSET_PREFIX, SIG_PREFIX, LIMITS, PLATFORMS, SEMVER,
  signManifest, verifyManifest, cmpVersion, assetUrl, parseManifest, platformKey, judge, sha256Hex,
};
