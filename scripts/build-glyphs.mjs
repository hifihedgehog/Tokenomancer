// Builds media/tokenomancer-glyphs.woff from media/glyphs/*.svg for `contributes.icons`.
// The glyphs are drawn on the codicon grid: 16 units, the em box is the glyph box (ascent = em, descent 0),
// so they centre exactly like built-in codicons in the status bar.
// Usage: node scripts/build-glyphs.mjs [glyphDir] [out.woff]
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont';
import svg2ttf from 'svg2ttf';
import ttf2woff from 'ttf2woff';
import { createReadStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dir = process.argv[2] ?? join(root, 'media/glyphs');
const out = process.argv[3] ?? join(root, 'media/tokenomancer-glyphs.woff');

// Code points are part of the manifest (`fontCharacter`), so they are fixed here, never derived from file order.
const GLYPHS = { pinned: 0xe001, loose: 0xe002, calibrating: 0xe003, empty: 0xe004 };

function svgFont() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const font = new SVGIcons2SVGFontStream({ fontName: 'tokenomancer-glyphs', fontHeight: 1000, ascent: 1000, descent: 0, normalize: false, round: 1e3 });
    font.on('data', c => chunks.push(c)).on('end', () => resolve(chunks.join(''))).on('error', reject);
    for (const [name, code] of Object.entries(GLYPHS)) {
      const glyph = createReadStream(join(dir, `${name}.svg`));
      glyph.metadata = { name: `tokenomancer-${name}`, unicode: [String.fromCodePoint(code)] };
      font.write(glyph);
    }
    font.end();
  });
}

// A fixed timestamp keeps the committed font byte-identical across rebuilds.
const ttf = svg2ttf(await svgFont(), { ts: 1792540800, version: '1.0', description: 'Tokenomancer status glyphs', url: 'https://github.com/hifihedgehog/Tokenomancer' });
const woff = Buffer.from(ttf2woff(new Uint8Array(ttf.buffer)).buffer);
writeFileSync(out, woff);
console.log(`${out}: ${woff.length} bytes, ${Object.keys(GLYPHS).length} glyphs`);
