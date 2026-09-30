'use strict';
// One durable place for everything the window remembers (which page was open, the sidebar, and so on).
//
// The window's own storage (localStorage) is written to disk lazily, a few seconds late, and the last
// writes are lost when the app is killed or crashes. This store lives in the main process and writes
// the whole file the moment a value changes: to a temporary file, then renamed over the real one, with
// the previous good copy kept beside it. A crash mid-write leaves either the old file or the new one,
// never half of each, and a damaged file falls back to the copy.

const fs = require('fs');
const path = require('path');

const KEY = /^mw:[A-Za-z0-9:._-]{1,100}$/;
const MAX_VALUE = 1024 * 1024;
const MAX_KEYS = 500;

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Writes a JSON file so that it is never half-written. Used by the store and by the desktop state.
function writeJsonAtomic(file, value, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0));
  try { fs.copyFileSync(file, `${file}.bak`); } catch { /* first write: nothing to keep */ }
  fs.renameSync(tmp, file);
}

function createUiStore(file) {
  let data = readJson(file) || readJson(`${file}.bak`) || {};

  function save() {
    try { writeJsonAtomic(file, data); return true; } catch { return false; }
  }

  return {
    all: () => ({ ...data }),
    get: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    set(k, v) {
      if (typeof k !== 'string' || !KEY.test(k) || typeof v !== 'string' || v.length > MAX_VALUE) return false;
      if (data[k] === v) return true;
      if (!(k in data) && Object.keys(data).length >= MAX_KEYS) return false;
      data[k] = v;
      return save();
    },
    remove(k) {
      if (!(k in data)) return true;
      delete data[k];
      return save();
    },
  };
}

module.exports = { createUiStore, writeJsonAtomic, readJson };
