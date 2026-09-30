// While mwcode runs from source it runs inside node_modules/electron/dist/electron.exe, and Windows
// takes the name Task Manager shows ("Electron") and the icon from that file itself. This stamps the
// mwcode name and icon onto it. Runs after every npm install (postinstall), since a reinstall puts the
// plain file back. A packaged build does the same to its own mwcode.exe; this is only for development.
//   node build/brand-electron.js
const path = require('path');
const fs = require('fs');

async function main() {
  if (process.platform !== 'win32') return;
  let exe;
  try {
    exe = require('electron'); // the path to the executable
  } catch {
    return;
  }
  if (!exe || !fs.existsSync(exe)) return;
  const mod = require('rcedit');
  const rcedit = typeof mod === 'function' ? mod : mod.rcedit || mod.default;
  await rcedit(exe, {
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    'version-string': {
      FileDescription: 'mwcode',
      ProductName: 'mwcode',
      CompanyName: 'Mindweave',
      InternalName: 'mwcode',
      OriginalFilename: 'mwcode.exe',
    },
  });
  console.log('mwcode name and icon stamped on', exe);
}

main().catch((e) => {
  // Never fail an install over this: the app runs the same, it just says "Electron" in Task Manager.
  console.warn('Could not stamp the mwcode name on electron.exe:', e.message);
});
