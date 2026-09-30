// recordings.js — keeps what the agent saw while it tested an app, so the test can be
// replayed after it ends.
//
// The engine streams frames of the app under test (ToolContext.onLive) only while the
// agent is acting on it. Each test (one `live` id) becomes a folder of numbered frames
// plus an index of when each was drawn, under the app's user-data folder. The live view
// shows the same frames as they arrive; the recording is what is left when it stops.
//
// Old recordings are removed on start: anything older than RETAIN_DAYS, then the oldest
// until the whole folder is under MAX_BYTES.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const RETAIN_DAYS = 14;
const MAX_BYTES = 800 * 1024 * 1024;
/** Frames closer together than this are thinned out on disk; the live view still gets
 *  every one. Enough for smooth playback without filling the disk with a fast page. */
const MIN_FRAME_GAP_MS = 60;

function createRecorder(root) {
  const open = new Map(); // live id → { dir, frames: [{ file, ts }], seq, chain, lastTs, flush }

  function safeId(live) {
    return String(live).replace(/[^a-z0-9-]/gi, '').slice(0, 64);
  }

  function entry(live) {
    let rec = open.get(live);
    if (!rec) {
      const dir = path.join(root, safeId(live));
      rec = { dir, frames: [], seq: 0, chain: fsp.mkdir(dir, { recursive: true }), lastTs: 0, flush: null };
      open.set(live, rec);
    }
    return rec;
  }

  function writeIndex(live) {
    const rec = open.get(live);
    if (!rec) return;
    rec.chain = rec.chain
      .then(() => fsp.writeFile(path.join(rec.dir, 'index.json'), JSON.stringify({ live, frames: rec.frames })))
      .catch(() => {});
  }

  /** Keep one frame. Writes stay in order per test; the index is written shortly after
   *  the frames stop coming, so a burst costs one index write, not one per frame. */
  function record(e) {
    if (!e || e.kind !== 'frame' || !e.live || !e.data) return;
    const rec = entry(e.live);
    if (e.ts - rec.lastTs < MIN_FRAME_GAP_MS) return;
    rec.lastTs = e.ts;
    const file = `${String(++rec.seq).padStart(5, '0')}.${e.mime === 'image/png' ? 'png' : 'jpg'}`;
    const bytes = Buffer.from(e.data, 'base64');
    rec.chain = rec.chain.then(() => fsp.writeFile(path.join(rec.dir, file), bytes)).catch(() => {});
    rec.frames.push({ file, ts: e.ts, w: e.width || 0, h: e.height || 0 });
    clearTimeout(rec.flush);
    rec.flush = setTimeout(() => writeIndex(e.live), 800);
  }

  /** A test's frames, oldest first, as absolute paths with the time each was drawn. */
  async function get(live) {
    const rec = open.get(live);
    if (rec) {
      await rec.chain.catch(() => {});
      return rec.frames.map((f) => ({ path: path.join(rec.dir, f.file), ts: f.ts, w: f.w, h: f.h }));
    }
    try {
      const dir = path.join(root, safeId(live));
      const idx = JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'));
      return (idx.frames || []).map((f) => ({ path: path.join(dir, f.file), ts: f.ts, w: f.w, h: f.h }));
    } catch {
      return [];
    }
  }

  /** Drop recordings past their age, then the oldest until under the size cap. */
  async function prune() {
    let dirs;
    try {
      dirs = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - RETAIN_DAYS * 86400000;
    const kept = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      try {
        const st = await fsp.stat(dir);
        if (st.mtimeMs < cutoff) {
          await fsp.rm(dir, { recursive: true, force: true });
          continue;
        }
        let bytes = 0;
        for (const f of await fsp.readdir(dir)) bytes += (await fsp.stat(path.join(dir, f))).size;
        kept.push({ dir, mtime: st.mtimeMs, bytes });
      } catch {
        // In use or already gone: leave it for next time.
      }
    }
    kept.sort((a, b) => a.mtime - b.mtime);
    let total = kept.reduce((n, k) => n + k.bytes, 0);
    for (const k of kept) {
      if (total <= MAX_BYTES) break;
      await fsp.rm(k.dir, { recursive: true, force: true }).catch(() => {});
      total -= k.bytes;
    }
  }

  return { record, get, prune };
}

module.exports = { createRecorder };
