'use strict';
// Fetches the signed feed, keeps the last good copy on disk, and hands the app clean items.
// Runs in the main process only. The window never touches the network for this.
//
// What it guarantees:
//   - nothing is shown that was not signed with the key built into the app
//   - a feed older than one already accepted is refused (no replaying old news over new)
//   - pictures are used only if their bytes match the hash inside the signed feed, and only if
//     they really are png / jpeg / webp / gif; the window gets them as data, not as a link
//   - a failure of any kind (offline, blocked, bad file) leaves the last good copy in place
//   - nothing about the user is sent: a plain GET, no cookies, no identifiers

const fs = require('fs');
const path = require('path');
const core = require('./feedCore');
const { writeJsonAtomic, readJson } = require('../ui-store');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;
const TIMEOUT_MS = 8000;

function fmtDate(iso) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function createFeedService({ dir, versions, publicKey, onUpdate = () => {}, fetchFn = globalThis.fetch, urls = core.FEED_URLS, now = () => Date.now() }) {
  const stateFile = path.join(dir, 'feed-state.json');
  const imageDir = path.join(dir, 'feed-images');
  const dataUris = new Map(); // sha256 -> data: URI, verified once

  function load() {
    try {
      const s = readJson(stateFile) || readJson(`${stateFile}.bak`);
      if (!s) throw new Error('none');
      return { lastSeq: Number.isInteger(s.lastSeq) ? s.lastSeq : 0, checkedAt: s.checkedAt || 0, lastError: s.lastError || null, feed: s.feed || null, read: Array.isArray(s.read) ? s.read.filter((x) => typeof x === 'string') : [] };
    } catch {
      return { lastSeq: 0, checkedAt: 0, lastError: null, feed: null, read: [] };
    }
  }
  function save(state) {
    try {
      writeJsonAtomic(stateFile, state);
    } catch { /* the next check just starts from what is on disk */ }
  }

  async function fetchCapped(url, max) {
    const res = await fetchFn(url, { redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'mwcode-news' } });
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

  function imageUri(sha) {
    if (dataUris.has(sha)) return dataUris.get(sha);
    try {
      const buf = fs.readFileSync(path.join(imageDir, sha));
      const mime = core.imageMime(buf);
      if (!mime || core.sha256Hex(buf) !== sha) return null;
      const uri = `data:${mime};base64,${buf.toString('base64')}`;
      dataUris.set(sha, uri);
      return uri;
    } catch {
      return null;
    }
  }

  // What the window gets: this copy's items, cleaned, with pictures as data.
  function get() {
    const state = load();
    const base = { checkedAt: state.checkedAt, error: state.lastError, items: [], read: state.read };
    // Switched off means nothing new is fetched; what was already received stays readable.
    if (!state.feed) return base;
    try {
      const json = Buffer.from(state.feed.json, 'base64');
      // Checked again on every read: a file changed on disk is as untrusted as one from the network.
      if (!core.verifyFeed(json, state.feed.sig, publicKey)) return base;
      const parsed = core.parseFeed(json);
      const items = core.applicable(parsed.items, { versions: versions(), now: now() })
        .map((it, pos) => ({
          ...it,
          date: fmtDate(it.date),
          _sort: it.date,
          _pos: pos,
          images: it.images.map((im) => ({ src: imageUri(im.sha256), alt: im.alt, ...(im.caption ? { caption: im.caption } : {}) })).filter((im) => im.src),
        }))
        // Newest first. Items from the same day keep the feed's own order, which is written newest
        // first, so the latest one is always on top.
        .sort((a, b) => (a._sort < b._sort ? 1 : a._sort > b._sort ? -1 : a._pos - b._pos))
        .map(({ _sort, _pos, ...rest }) => rest);
      return { ...base, items };
    } catch {
      return base;
    }
  }

  let inflight = null;
  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const state = load();
      let accepted = null;
      let failure = 'Could not reach the news feed.';
      for (const u of urls) {
        try {
          const json = await fetchCapped(u.json, core.LIMITS.feedBytes);
          const sig = (await fetchCapped(u.sig, 1024)).toString('utf8').trim();
          if (!core.verifyFeed(json, sig, publicKey)) { failure = 'A feed was refused: its signature did not check out.'; continue; }
          const parsed = core.parseFeed(json);
          if (parsed.seq < state.lastSeq) { failure = 'A feed was refused: it was older than the one already received.'; continue; }
          accepted = { json, sig, parsed };
          break;
        } catch (e) {
          if (/timeout|abort/i.test(String(e?.name || e?.message))) failure = 'The news feed took too long to answer.';
        }
      }
      if (!accepted) {
        state.lastError = failure;
        save(state);
        return get();
      }
      // Pictures of items this copy will show, kept only when they match the signed hash.
      fs.mkdirSync(imageDir, { recursive: true });
      for (const it of core.applicable(accepted.parsed.items, { versions: versions(), now: now() })) {
        for (const im of it.images) {
          if (imageUri(im.sha256)) continue;
          try {
            const buf = await fetchCapped(im.src, core.LIMITS.imageBytes);
            if (core.sha256Hex(buf) !== im.sha256 || !core.imageMime(buf)) continue;
            fs.writeFileSync(path.join(imageDir, im.sha256), buf);
          } catch { /* the item is shown without this picture */ }
        }
      }
      // Pictures no longer in the feed are deleted, so a removed post leaves nothing behind.
      const keep = new Set(accepted.parsed.items.flatMap((it) => it.images.map((im) => im.sha256)));
      try {
        for (const f of fs.readdirSync(imageDir)) if (!keep.has(f)) { fs.rmSync(path.join(imageDir, f), { force: true }); dataUris.delete(f); }
      } catch { /* nothing to clean */ }
      const changed = accepted.parsed.seq !== state.lastSeq || !state.feed || state.feed.json !== accepted.json.toString('base64');
      state.lastSeq = accepted.parsed.seq;
      state.feed = { json: accepted.json.toString('base64'), sig: accepted.sig };
      state.checkedAt = now();
      state.lastError = null;
      save(state);
      const result = get();
      if (changed) onUpdate(result);
      return result;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  let timers = [];
  function start() {
    if (timers.length) return;
    const first = setTimeout(() => { void refresh(); }, FIRST_CHECK_MS);
    const every = setInterval(() => { void refresh(); }, CHECK_EVERY_MS);
    first.unref?.();
    every.unref?.();
    timers = [first, every];
  }
  function stop() { timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); timers = []; }

  // What the user has read. Kept in this file, written the moment it happens, so a crash, a forced
  // quit or an update restart cannot bring an item back as unread.
  function markRead(ids) {
    const state = load();
    const known = new Set(state.read);
    for (const id of ids || []) if (typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) known.add(id);
    state.read = [...known].slice(-500);
    save(state);
    return state.read;
  }


  return { get, refresh, start, stop, markRead };
}

module.exports = { createFeedService };
