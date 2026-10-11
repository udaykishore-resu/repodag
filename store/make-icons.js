/* Regenerates the extension icons and the store icon from store/icon.svg.
   The 128 px icons keep the art inside the centre 96x96 (store guideline); the small toolbar sizes use the art edge to edge. */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const ICONS = path.resolve(__dirname, '..', 'extension', 'icons');

(async () => {
  fs.mkdirSync(ICONS, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const shot = async (size, viewBox, file) => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const art = svg.replace('viewBox="0 0 128 128" width="128" height="128"', 'viewBox="' + viewBox + '" width="' + size + '" height="' + size + '"');
    await page.setContent('<!doctype html><html><body style="margin:0;background:transparent">' + art + '</body></html>');
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log('wrote', path.relative(path.resolve(__dirname, '..'), file));
  };
  await shot(128, '0 0 128 128', path.join(ICONS, 'icon128.png'));
  await shot(128, '0 0 128 128', path.join(__dirname, 'repodag-store-icon-128.png'));
  for (const size of [48, 32, 16]) await shot(size, '16 16 96 96', path.join(ICONS, 'icon' + size + '.png'));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
