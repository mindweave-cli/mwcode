// Turns news/source.json into a signed feed.
//   node news/tools/publish.mjs <news-folder>
// <news-folder> is the local copy of the mindweave-news repo. It holds source.json (what you write)
// and images/ (pictures). This writes feed.json and feed.sig next to them, then checks the result
// the way the app will. You then commit and push that folder; nothing else is needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../feedCore.js');
const { PUBLIC_KEY } = require('../feedKey.js');

const dir = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(dir, 'source.json'))) {
  console.error('Usage: node news/tools/publish.mjs <news-folder>   (the folder holding source.json)');
  process.exit(1);
}
const keyPath = process.env.MWCODE_NEWS_KEY || path.join(os.homedir(), '.mwcode-news', 'private.pem');
if (!fs.existsSync(keyPath)) { console.error(`No private key at ${keyPath}. Run keygen.mjs first.`); process.exit(1); }

const source = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
if (!Array.isArray(source.items)) { console.error('source.json needs an "items" list.'); process.exit(1); }

// Pictures are written as { "file": "images/x.png", "alt": "...", "caption": "..." }. The tool fills in
// the address and the hash, so the app can check the bytes it downloads are the ones you meant.
const items = source.items.map((it) => ({
  ...it,
  images: (it.images || []).map((im) => {
    const file = path.join(dir, im.file);
    if (!fs.existsSync(file)) throw new Error(`${it.id}: picture not found: ${im.file}`);
    const buf = fs.readFileSync(file);
    if (buf.length > core.LIMITS.imageBytes) throw new Error(`${it.id}: ${im.file} is over ${core.LIMITS.imageBytes / 1024} KB`);
    if (!core.imageMime(buf)) throw new Error(`${it.id}: ${im.file} is not a png, jpeg, webp or gif`);
    return { src: core.RAW_BASE + im.file.replace(/\\/g, '/'), sha256: core.sha256Hex(buf), alt: im.alt || '', ...(im.caption ? { caption: im.caption } : {}) };
  }),
}));

// The sequence only goes up, so an old copy of the feed can never replace a newer one.
let seq = 1;
const outPath = path.join(dir, 'feed.json');
if (fs.existsSync(outPath)) {
  try { seq = JSON.parse(fs.readFileSync(outPath, 'utf8')).seq + 1; } catch { /* first publish */ }
}
const feed = { v: 1, seq, issued: new Date().toISOString(), items };
const bytes = Buffer.from(JSON.stringify(feed, null, 2) + '\n');

// Judge it exactly as the app will, before it goes anywhere.
const parsed = core.parseFeed(bytes);
const dropped = items.length - parsed.items.length;
if (dropped) {
  const kept = new Set(parsed.items.map((i) => i.id));
  console.error(`These items would be refused by the app, so nothing was published:\n  ${items.filter((i) => !kept.has(i.id)).map((i) => i.id || '(no id)').join(', ')}\nCheck ids, dates (YYYY-MM-DD), title/summary length, kinds, https links to allowed hosts, and versions like 3.1.0.`);
  process.exit(1);
}
const sig = core.signFeed(bytes, fs.readFileSync(keyPath, 'utf8'));
if (!core.verifyFeed(bytes, sig, PUBLIC_KEY)) {
  console.error('The signature does not match the public key in the app. Wrong private key? Nothing was written.');
  process.exit(1);
}
fs.writeFileSync(outPath, bytes);
fs.writeFileSync(path.join(dir, 'feed.sig'), sig + '\n');
console.log(`Signed feed #${seq}: ${parsed.items.length} item(s) → ${outPath}`);
console.log('Now commit and push that folder.');
