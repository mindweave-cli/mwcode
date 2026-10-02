'use strict';
// Looks for a newer mwcode, downloads it, and installs it when the user says so. Runs in the main
// process only: the window gets a small state object and never touches the network for this.
//
// What it guarantees:
//   - nothing is downloaded or run unless a manifest signed with the key built into the app says so
//   - an installer is used only if its size and SHA-256 match what that signature covers, checked
//     when the download finishes AND again just before it is run
//   - a manifest older than one already accepted is refused, and so is one that is not newer than
//     the running version (nobody can walk users back to an old release)
//   - the installer comes only from this project's GitHub release downloads, over https
//   - a failure of any kind (offline, blocked, bad file) leaves the installed app exactly as it was
//   - nothing about the user is sent: plain GETs, no cookies, no identifiers, nothing in the URL
//
// State the window sees:
//   status  idle | checking | available | downloading | ready | error | none
//   mode    auto (installs itself) | manual (download it yourself) | none (not an installed copy)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./updateCore');
const { capability: detect, apply, downloadDir } = require('./apply');
const { writeJsonAtomic, readJson } = require('../ui-store');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 25 * 1000;
const MANIFEST_TIMEOUT_MS = 10 * 1000;
const STALL_MS = 60 * 1000;

function createUpdateService({
  dir, // the app's data folder (userData)
  current, // the running version
  publicKey,
  packaged,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  execPath = process.execPath,
  fetchFn = globalThis.fetch,
  onChange = () => {},
  applyFn = apply,
  quit = () => {},
  urls = { manifest: core.MANIFEST_URL, sig: core.SIG_URL },
  now = () => Date.now(),
}) {
  const stateFile = path.join(dir, 'update-state.json');
  const cap = detect({ platform, packaged, execPath, env, userData: dir });
  const key = core.platformKey(platform, arch, Boolean(env.APPIMAGE));

  let timer = null;
  let busy = false;
  let manifest = null; // the accepted manifest for a newer version
  let file = null; // the finished download
  let view = {
    status: cap.mode === 'none' ? 'none' : 'idle',
    mode: cap.mode,
    current,
    version: null,
    notes: null,
    pct: 0,
    error: null,
    reason: cap.reason || null,
    manualUrl: core.RELEASES_PAGE,
    checkedAt: 0,
  };

  const load = () => {
    try {
      const s = readJson(stateFile) || readJson(`${stateFile}.bak`);
      return { lastSeq: Number.isInteger(s?.lastSeq) ? s.lastSeq : 0, checkedAt: Number(s?.checkedAt) || 0 };
    } catch {
      return { lastSeq: 0, checkedAt: 0 };
    }
  };
  const save = (s) => {
    try { writeJsonAtomic(stateFile, s); } catch { /* the next check starts from what is on disk */ }
  };

  function set(patch) {
    view = { ...view, ...patch };
    onChange({ ...view });
  }

  async function fetchCapped(url, max, timeoutMs) {
    const res = await fetchFn(url, { redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'mwcode-update' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > max) throw new Error('too large');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > max) throw new Error('too large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // The SHA-256 of a file on disk, read in pieces so a large installer never sits in memory.
  function hashFile(p) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(p).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
  }

  // Where this version's download goes, and what it is called there.
  function targetPath(m) {
    const asset = m.assets[key];
    const base = downloadDir(cap, m.version);
    const name = path.basename(new URL(asset.url).pathname);
    return path.join(base, cap.appImage ? `.mwcode-update-${m.version}.AppImage` : name);
  }

  // Old downloads are not worth keeping: remove every other version's leftovers, best effort.
  function tidy(keepVersion) {
    try {
      const root = path.join(dir, 'updates');
      for (const e of fs.existsSync(root) ? fs.readdirSync(root) : []) if (e !== keepVersion) fs.rmSync(path.join(root, e), { recursive: true, force: true });
      if (cap.appImage) {
        const own = path.dirname(cap.appImage);
        for (const e of fs.readdirSync(own)) if (e.startsWith('.mwcode-update-') && !e.includes(`-${keepVersion}.`)) fs.rmSync(path.join(own, e), { force: true });
      }
    } catch { /* leftovers are only wasted space */ }
  }

  // ── check ──────────────────────────────────────────────────────────────
  async function check({ force = false } = {}) {
    if (busy || cap.mode === 'none' || !key) {
      if (!key && cap.mode !== 'none' && view.status === 'idle') set({ status: 'none', mode: 'none', reason: 'No update for this system.' });
      return view;
    }
    if (view.status === 'downloading' || view.status === 'ready') return view;
    busy = true;
    if (force) set({ status: 'checking', error: null });
    try {
      const [json, sig] = await Promise.all([
        fetchCapped(urls.manifest, core.LIMITS.manifestBytes, MANIFEST_TIMEOUT_MS),
        fetchCapped(urls.sig, 1024, MANIFEST_TIMEOUT_MS),
      ]);
      if (!core.verifyManifest(json, sig.toString('utf8'), publicKey)) throw new Error('the update information is not signed by mwcode');
      const m = core.parseManifest(json);
      const state = load();
      const verdict = core.judge(m, { current, lastSeq: state.lastSeq });
      save({ lastSeq: Math.max(state.lastSeq, m.seq), checkedAt: now() });
      if (!verdict.ok) {
        manifest = null;
        set({ status: 'idle', version: null, notes: null, error: null, checkedAt: now() });
        return view;
      }
      if (!m.assets[key]) {
        set({ status: 'idle', version: null, error: null, checkedAt: now() });
        return view;
      }
      manifest = m;
      set({ status: 'available', version: m.version, notes: m.notes || null, error: null, pct: 0, checkedAt: now() });
      // Nothing is downloaded until the user presses Update: an installer is over a hundred
      // megabytes, and it is their connection. Manual installs never download at all.
    } catch (err) {
      // Offline or blocked is normal and not worth a warning on its own: it only matters when the
      // user asked for the check, or when something already downloaded went wrong.
      if (force || view.status === 'available') set({ status: view.status === 'available' ? 'available' : 'error', error: String(err.message || err) });
    } finally {
      busy = false;
    }
    return view;
  }

  // ── download ───────────────────────────────────────────────────────────
  async function startDownload() {
    if (!manifest || cap.mode !== 'auto') return view;
    if (view.status === 'downloading' || view.status === 'ready') return view;
    const asset = manifest.assets[key];
    const dest = targetPath(manifest);
    set({ status: 'downloading', pct: 0, error: null });
    try {
      // A finished download from an earlier run is reused if it is exactly the signed one.
      if (fs.existsSync(dest) && fs.statSync(dest).size === asset.size && (await hashFile(dest)) === asset.sha256) {
        file = dest;
        set({ status: 'ready', pct: 100 });
        return view;
      }
      const part = `${dest}.part`;
      fs.rmSync(part, { force: true });
      const ctrl = new AbortController();
      let stall = null;
      const arm = () => { clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), STALL_MS); };
      arm();
      const res = await fetchFn(asset.url, { redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: ctrl.signal, headers: { 'user-agent': 'mwcode-update' } });
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
      const declared = Number(res.headers.get('content-length'));
      if (declared && declared !== asset.size) throw new Error('the download is not the size that was signed');
      const out = fs.createWriteStream(part, { mode: 0o600 });
      const hash = crypto.createHash('sha256');
      let got = 0;
      let lastPct = -1;
      try {
        for await (const chunk of res.body) {
          got += chunk.length;
          if (got > asset.size) throw new Error('the download is larger than what was signed');
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          arm();
          const pct = Math.floor((got / asset.size) * 100);
          if (pct !== lastPct) { lastPct = pct; set({ pct }); }
        }
        await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
      } catch (err) {
        out.destroy();
        throw err;
      } finally {
        clearTimeout(stall);
      }
      if (got !== asset.size) throw new Error('the download is incomplete');
      if (hash.digest('hex') !== asset.sha256) throw new Error('the download does not match its signed fingerprint');
      fs.renameSync(part, dest);
      file = dest;
      tidy(manifest.version);
      set({ status: 'ready', pct: 100 });
    } catch (err) {
      fs.rmSync(`${dest}.part`, { force: true });
      const msg = err && err.name === 'AbortError' ? 'the download stalled' : String(err.message || err);
      set({ status: 'available', pct: 0, error: msg });
    }
    return view;
  }

  // ── install ────────────────────────────────────────────────────────────
  // Checks the file once more, hands it to the system's way of installing, and quits so the swap can
  // happen. The app comes back on its own as the new version.
  async function restart() {
    if (view.status !== 'ready' || !file || !manifest) return view;
    const asset = manifest.assets[key];
    try {
      if (fs.statSync(file).size !== asset.size || (await hashFile(file)) !== asset.sha256) throw new Error('the downloaded file changed; try again');
      applyFn(cap, { file, platform });
    } catch (err) {
      fs.rmSync(file, { force: true });
      file = null;
      set({ status: 'available', pct: 0, error: String(err.message || err) });
      return view;
    }
    quit();
    return view;
  }

  function start() {
    if (cap.mode === 'none' || env.MWCODE_NO_UPDATE_CHECK === '1') return;
    const first = setTimeout(() => { check().catch(() => {}); }, FIRST_CHECK_MS);
    timer = setInterval(() => { check().catch(() => {}); }, CHECK_EVERY_MS);
    first.unref?.();
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { get: () => ({ ...view }), check, download: startDownload, restart, start, stop, capability: cap };
}

module.exports = { createUpdateService };
