// node --test ui-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUiStore, writeJsonAtomic, readJson } = require('./ui-store.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mwstore-'));

test('a value is on disk the moment it is set, and a new store (a restart) sees it', () => {
  const file = path.join(tmp(), 'ui.json');
  const a = createUiStore(file);
  a.set('mw:side:v1', 'closed');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['mw:side:v1'], 'closed');
  assert.equal(createUiStore(file).get('mw:side:v1'), 'closed');
});

test('remove is durable too', () => {
  const file = path.join(tmp(), 'ui.json');
  const a = createUiStore(file);
  a.set('mw:x', '1');
  a.remove('mw:x');
  assert.equal(createUiStore(file).get('mw:x'), null);
});

test('a damaged file falls back to the last good copy instead of forgetting everything', () => {
  const file = path.join(tmp(), 'ui.json');
  const a = createUiStore(file);
  a.set('mw:a', '1');
  a.set('mw:b', '2'); // the copy now holds a
  fs.writeFileSync(file, '{"mw:a": "1", "mw:b"'); // killed halfway through a write
  const b = createUiStore(file);
  assert.equal(b.get('mw:a'), '1');
});

test('nothing half-written is ever left in place of the real file', () => {
  const dir = tmp();
  const file = path.join(dir, 'ui.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(readJson(file), { a: 2 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('only well-formed keys and string values are accepted', () => {
  const s = createUiStore(path.join(tmp(), 'ui.json'));
  assert.equal(s.set('other', 'x'), false);
  assert.equal(s.set('mw:../x', 'x'), false);
  assert.equal(s.set('mw:ok', { not: 'a string' }), false);
  assert.equal(s.set('mw:big', 'x'.repeat(1024 * 1024 + 1)), false);
  assert.equal(s.set('mw:ok', 'fine'), true);
  assert.equal(s.get('__proto__'), null);
});

test('a missing or empty file starts clean', () => {
  const s = createUiStore(path.join(tmp(), 'nope.json'));
  assert.deepEqual(s.all(), {});
});
