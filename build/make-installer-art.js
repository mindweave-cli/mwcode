// Draws the installer's side picture (Welcome and Finish pages): the logo and name on the app's
// near-black, with a thin jade line, like the app itself. NSIS wants a 164x314 24-bit BMP.
// Run: npx electron build/make-installer-art.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const W = 164, H = 314;
const root = path.join(__dirname, '..');
const url = (p) => 'file:///' + path.join(root, p).replace(/\\/g, '/');

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${url('assets/fonts/fonts.css')}">
<style>
  html,body{margin:0;width:${W}px;height:${H}px;background:#080A09;overflow:hidden}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
  .mark{width:46px;height:55px;background:#EEF2EF;-webkit-mask:url(${url('assets/logo-mono.png')}) center/contain no-repeat}
  .name{font:500 24px 'Fraunces',Georgia,serif;font-variation-settings:'SOFT' 60;color:#EEF2EF;letter-spacing:-.01em}
  .line{width:34px;height:2px;border-radius:1px;background:#3DA37A}
  .sub{position:absolute;bottom:16px;left:0;right:0;text-align:center;font:500 10px 'Instrument Sans',sans-serif;color:#87928D;letter-spacing:.04em}
</style></head><body>
<div class="wrap"><div class="mark"></div><div class="name">mwcode</div><div class="line"></div></div>
<div class="sub">Open source · Apache 2.0</div>
</body></html>`;

function bmp24(bgra, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4; // BMP rows run bottom to top
    const dst = 54 + y * row;
    for (let x = 0; x < w; x++) {
      b[dst + x * 3] = bgra[src + x * 4];
      b[dst + x * 3 + 1] = bgra[src + x * 4 + 1];
      b[dst + x * 3 + 2] = bgra[src + x * 4 + 2];
    }
  }
  return b;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(r => setTimeout(r, 300)))');
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
  const s = img.getSize();
  if (s.width !== W || s.height !== H) img = img.resize({ width: W, height: H, quality: 'best' });
  fs.writeFileSync(path.join(__dirname, 'installer-sidebar.bmp'), bmp24(img.toBitmap(), W, H));
  fs.writeFileSync(path.join(__dirname, 'installer-sidebar.preview.png'), img.toPNG());
  console.log('wrote build/installer-sidebar.bmp', s);
  app.quit();
});
