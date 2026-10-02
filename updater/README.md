# Updater

How installed copies of mwcode update themselves. Plain files, no dependencies.

## What happens on a user's machine

1. About 25 seconds after start, then every 6 hours, `updateService.js` downloads `update.json` and
   `update.sig` from the latest release of `mindweave-cli/mwcode`. Plain GETs, nothing about the user.
2. The signature (Ed25519, key built into the app in `updateKey.js`) must verify, the manifest must be
   well formed, newer than the running version, and no older than one already accepted.
3. Nothing is downloaded until the user presses Update in Settings > About (or the box in the top row).
4. The installer is downloaded only from this project's release downloads. Its size and SHA-256 must match
   the signed manifest, when the download ends and again just before it is run.
5. Restart to update, then per system (`apply.js`):
   - **Windows**: runs the installer with `--updated /S --force-run` (the installer's own update path:
     keeps PATH and data, starts the new app). An all-users install runs it with its window, for the
     permission prompt.
   - **macOS**: a script waits for the app to quit, unpacks the zip with `ditto`, checks the new app with
     `codesign --verify`, swaps it in (the old one goes back if anything fails), clears the quarantine
     mark and opens it. The usual Electron updater cannot be used here: it only installs updates signed by an Apple developer identity, and this app is not.
   - **Linux AppImage**: the new file is downloaded next to the AppImage and renamed over it, then started.
   - **Linux .deb, translocated or read-only Mac app**: the download page is offered instead.
6. Source checkouts (`app.isPackaged` false) never check.

## Making a release

One time: `node updater/tools/keygen.mjs`. The private key goes to `~/.mwcode-updates/private.pem`. Back it
up. If it is lost, installed apps can never accept another update and have to be reinstalled by hand. The
public key is written to `updateKey.js`, so rebuild the apps after making it.

Each release:

1. Build the installers (`npm run dist`, `dist:linux`, `dist:mac`) and copy the Windows `.exe`, the Mac
   `*-mac-arm64.zip` and the Linux `.AppImage` into one folder.
2. `node updater/tools/publish.mjs <folder> <version> --notes "one short sentence"`. It writes `update.json`
   and `update.sig` into the folder and checks them with the app's own rules.
3. Upload the whole folder as one release tagged `v<version>` (the command it prints). The version in the
   tag, the manifest and `package.json` must agree: the manifest's URLs point at `releases/download/v<version>/`.

## Tests

`node --test updater/update.test.mjs` (any system) and `updater/macSwap.test.mjs` (needs `sh`, `zip` and
`unzip`; runs the real Mac swap script against stand-ins for Apple's tools).
