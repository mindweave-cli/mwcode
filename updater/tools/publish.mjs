// Makes the two small files a release needs next to its installers: update.json and update.sig.
//   node updater/tools/publish.mjs <folder with the installers> <version> [--notes "one short sentence"]
//
// The folder holds the files exactly as they will be attached to the GitHub release (the Windows
// installer, the Mac zip, the Linux AppImage). Any that are missing are simply left out, and users on
// those systems are not offered an update. Nothing is uploaded: the last lines printed are the command
// to run yourself once you have looked at what was made.
//
// The result is checked here with the SAME code the app uses to judge it (updateCore.js), so a release
// the app would refuse cannot be made by mistake.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../updateCore.js');
const { PUBLIC_KEY } = require('../updateKey.js');

const [dirArg, version, ...rest] = process.argv.slice(2);
const notesAt = rest.indexOf('--notes');
const notes = notesAt >= 0 ? rest[notesAt + 1] : undefined;
if (!dirArg || !version || !core.SEMVER.test(version)) {
  console.error('Usage: node updater/tools/publish.mjs <folder> <version, like 1.0.1> [--notes "text"]');
  process.exit(1);
}
const dir = path.resolve(dirArg);
const privatePath = path.join(os.homedir(), '.mwcode-updates', 'private.pem');
if (!fs.existsSync(privatePath)) {
  console.error(`No private key at ${privatePath}. Run: node updater/tools/keygen.mjs`);
  process.exit(1);
}

// The file for each platform, found by its ending.
const WANT = {
  'win32-x64': /\.exe$/i,
  'darwin-arm64': /mac-arm64\.zip$/i,
  'linux-x64-appimage': /\.AppImage$/i,
};
const files = fs.readdirSync(dir);
const assets = {};
for (const [key, re] of Object.entries(WANT)) {
  const hits = files.filter((f) => re.test(f));
  if (hits.length > 1) { console.error(`More than one file looks like ${key}: ${hits.join(', ')}`); process.exit(1); }
  if (!hits.length) { console.log(`skipping ${key}: no file`); continue; }
  const p = path.join(dir, hits[0]);
  const bytes = fs.readFileSync(p);
  assets[key] = {
    url: `${core.ASSET_PREFIX}v${version}/${hits[0]}`,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  console.log(`${key}: ${hits[0]}  ${(bytes.length / 1048576).toFixed(1)} MB  ${assets[key].sha256.slice(0, 12)}…`);
}
if (!Object.keys(assets).length) { console.error('No installers found in that folder.'); process.exit(1); }

const manifest = { v: 1, seq: Math.floor(Date.now() / 1000), issued: new Date().toISOString(), version, assets };
if (notes) manifest.notes = notes;
const json = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const sig = core.signManifest(json, fs.readFileSync(privatePath, 'utf8'));

// Judge it exactly as an installed app would.
if (!core.verifyManifest(json, sig, PUBLIC_KEY)) { console.error('The signature does not verify against the key in the app. Was the app built with the matching public key?'); process.exit(1); }
core.parseManifest(json);

fs.writeFileSync(path.join(dir, 'update.json'), json);
fs.writeFileSync(path.join(dir, 'update.sig'), sig + '\n');
console.log('\nWrote update.json and update.sig. Checked with the app\'s own rules.');
console.log(`\nWhen you are ready, upload everything in that folder as one release:\n  gh release create v${version} ${path.join(dir, '*')} -R ${core.REPO} --title "mwcode ${version}"`);
