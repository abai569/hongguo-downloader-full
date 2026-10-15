/**
 * make-tray-icon.js —— 由应用图标生成托盘专用图标
 *
 * 直接拿 build/icon.png（256×256、深色底铺满）当托盘图标，缩到 16px 就是一团黑块。
 * 这里把深色底抠成透明，再输出 32×32 的 build/tray.png，托盘才看得清。
 *
 * 用法：npx electron scripts/make-tray-icon.js
 */
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon.png');
const OUT = path.join(ROOT, 'build', 'tray.png');
const DARK_THRESHOLD = 70;

/** 把接近纯黑（深色底）的像素变成全透明，只留音符本身 */
function stripDarkBackground(image) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  for (let i = 0; i < bitmap.length; i += 4) {
    const max = Math.max(bitmap[i], bitmap[i + 1], bitmap[i + 2]);
    if (max < DARK_THRESHOLD) {
      bitmap[i] = 0;
      bitmap[i + 1] = 0;
      bitmap[i + 2] = 0;
      bitmap[i + 3] = 0;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height });
}

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(SRC);
  if (source.isEmpty()) {
    console.error('读取失败：' + SRC);
    app.exit(1);
    return;
  }
  const size = source.getSize();
  const tray = stripDarkBackground(source).resize({ width: 32, height: 32, quality: 'best' });
  fs.writeFileSync(OUT, tray.toPNG());
  console.log(`源图 ${size.width}x${size.height} -> 托盘图 ${tray.getSize().width}x${tray.getSize().height}`);
  console.log('已写入：' + OUT);
  app.exit(0);
});
