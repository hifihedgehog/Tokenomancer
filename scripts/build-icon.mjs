// Builds media/icon.png (the Marketplace icon) from media/brand/icon.svg.
// resvg renders the 128-unit SVG at 256 px; libimagequant then palettises it, which keeps the soft glow
// and gradients visually lossless while bringing the file under the Marketplace-friendly 20 KB budget.
// Usage: node scripts/build-icon.mjs [in.svg] [out.png]
import { Resvg } from '@resvg/resvg-js';
import { losslessCompressPngSync, pngQuantizeSync } from '@napi-rs/image';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = process.argv[2] ?? join(root, 'media/brand/icon.svg');
const out = process.argv[3] ?? join(root, 'media/icon.png');
const SIZE = 256, BUDGET = 20 * 1024;

const raw = new Resvg(readFileSync(src), { fitTo: { mode: 'width', value: SIZE }, shapeRendering: 2 }).render().asPng();
const png = losslessCompressPngSync(pngQuantizeSync(raw, { minQuality: 90, maxQuality: 100, speed: 1 }));
writeFileSync(out, png);
console.log(`${out}: ${SIZE}x${SIZE}, ${png.length} bytes (raw ${raw.length})`);
if (png.length > BUDGET) {
  console.error(`icon.png is over the ${BUDGET}-byte budget`);
  process.exitCode = 1;
}
