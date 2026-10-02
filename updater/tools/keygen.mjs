// Makes the signing key pair for app updates. Run once.
//   node updater/tools/keygen.mjs
// The PRIVATE key is written to ~/.mwcode-updates/private.pem and goes nowhere else: never into a
// repo, never into the app, never into a chat. Whoever holds it can make every installed app install
// whatever they like. Back it up somewhere safe, because it cannot be recovered. The PUBLIC key is
// written into updater/updateKey.js, which ships inside the app. It is separate from the news key on
// purpose: losing or rotating one must not affect the other.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const keyDir = path.join(os.homedir(), '.mwcode-updates');
const privatePath = path.join(keyDir, 'private.pem');
const publicPath = path.join(here, '..', 'updateKey.js');

if (fs.existsSync(privatePath) && !process.argv.includes('--force')) {
  console.error(`A private key already exists at ${privatePath}. Replacing it would stop every installed app from accepting updates until it is reinstalled by hand.\nPass --force only if you mean that.`);
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(keyDir, { recursive: true });
fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' });
fs.writeFileSync(publicPath, `'use strict';\n// The public half of the update signing key. Safe to publish: it can only check signatures.\nmodule.exports = { PUBLIC_KEY: \`${pub}\` };\n`);
console.log(`Private key: ${privatePath}  (back it up somewhere safe; it cannot be recovered)`);
console.log(`Public key:  ${publicPath}  (already in the app's source; rebuild the app to ship it)`);
