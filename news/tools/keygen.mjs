// Makes the signing key pair for the news feed. Run once.
//   node news/tools/keygen.mjs
// The PRIVATE key is written to ~/.mwcode-news/private.pem and goes nowhere else: never into a
// repo, never into the app, never into a chat. Whoever holds it can put anything in front of every
// user. The PUBLIC key is written into news/feedKey.js, which ships inside the app.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const keyDir = path.join(os.homedir(), '.mwcode-news');
const privatePath = path.join(keyDir, 'private.pem');
const publicPath = path.join(here, '..', 'feedKey.js');

if (fs.existsSync(privatePath) && !process.argv.includes('--force')) {
  console.error(`A private key already exists at ${privatePath}. Replacing it would lock every installed app out of your news until they update.\nPass --force only if you mean that.`);
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(keyDir, { recursive: true });
fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' });
fs.writeFileSync(publicPath, `'use strict';\n// The public half of the news signing key. Safe to publish: it can only check signatures.\nmodule.exports = { PUBLIC_KEY: \`${pub}\` };\n`);
console.log(`Private key: ${privatePath}  (back it up somewhere safe; it cannot be recovered)`);
console.log(`Public key:  ${publicPath}  (already in the app's source)`);
