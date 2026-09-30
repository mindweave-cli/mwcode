// Builds assets/icon.ico (16–256px) and assets/icon.png from assets/logo-mono.png, painted white. Run with electron:
//   npx electron build/make-icon.js
// With --black it builds build/installer-icon.ico instead: the logo left black, for the installer and
// uninstaller windows, whose light title bar and header hide the white one.
//   npx electron build/make-icon.js --black
// With --icns it builds assets/icon.icns for macOS (16–1024px, Apple's margin), the same white logo.
//   npx electron build/make-icon.js --icns
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const BLACK = process.argv.includes('--black');
const ICNS = process.argv.includes('--icns');
app.whenReady().then(() => {
  // The one-colour logo, painted white: the same mark the app shows in its sidebar.
  const mono = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'logo-mono.png'));
  const mb = mono.toBitmap();
  // Premultiplied alpha: white at a pixel is its alpha value, so see-through pixels stay see-through.
  if (!BLACK) for (let i = 0; i < mb.length; i += 4) { mb[i] = mb[i + 1] = mb[i + 2] = mb[i + 3]; }
  const src = nativeImage.createFromBitmap(mb, mono.getSize());
  const { width, height } = src.getSize();
  const bmp = src.toBitmap(); // BGRA
  let transparent = 0;
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] < 10) transparent++;
  console.log('logo', width, 'x', height, 'transparent pixels:', Math.round((transparent / (width * height)) * 100) + '%');
  // Square canvas with the logo centred and a little breathing room, so it reads at 16px.
  const sizes = ICNS ? [16, 32, 64, 128, 256, 512, 1024] : [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs = sizes.map((s) => {
    // macOS icons keep about a tenth of the square clear on each side (Apple's icon grid).
    const pad = ICNS ? 0.1 : s <= 24 ? 0.04 : 0.08;
    const inner = Math.round(s * (1 - pad * 2));
    const scale = inner / Math.max(width, height);
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const logo = src.resize({ width: w, height: h, quality: 'best' }).toBitmap();
    const out = Buffer.alloc(s * s * 4); // transparent
    const ox = Math.floor((s - w) / 2), oy = Math.floor((s - h) / 2);
    for (let y = 0; y < h; y++) logo.copy(out, ((oy + y) * s + ox) * 4, y * w * 4, (y + 1) * w * 4);
    return { s, png: nativeImage.createFromBitmap(out, { width: s, height: s }).toPNG() };
  });
  if (ICNS) {
    // ICNS: 'icns' + total length, then one entry per size (4-letter type, length, PNG data).
    const types = { 16: ['icp4'], 32: ['icp5', 'ic11'], 64: ['icp6', 'ic12'], 128: ['ic07'], 256: ['ic08', 'ic13'], 512: ['ic09', 'ic14'], 1024: ['ic10'] };
    const entries = [];
    for (const { s: size, png } of pngs) for (const type of types[size]) {
      const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(8 + png.length, 4);
      entries.push(h, png);
    }
    const body = Buffer.concat(entries);
    const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(8 + body.length, 4);
    fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.icns'), Buffer.concat([h, body]));
    console.log('wrote assets/icon.icns', sizes.join(','));
    return app.quit();
  }
  // ICO: header, directory, then PNG images (Windows Vista+ reads PNG entries).
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const dir = pngs.map(({ s, png }) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12); offset += png.length;
    return e;
  });
  const ico = Buffer.concat([head, ...dir, ...pngs.map((p) => p.png)]);
  if (BLACK) {
    fs.writeFileSync(path.join(__dirname, 'installer-icon.ico'), ico);
    console.log('wrote build/installer-icon.ico');
    return app.quit();
  }
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'), ico);
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), pngs.find((p) => p.s === 256).png);
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon-32.png'), pngs.find((p) => p.s === 32).png);
  console.log('wrote icon.ico', sizes.join(','), 'and icon.png');
  app.quit();
});
