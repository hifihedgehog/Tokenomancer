// The hover's two pictures: a meter per limit and the Loupe for the binding one.
// Geometry only, no text (labels are hover text). Hover images can't read theme
// variables, so colours are baked per theme kind; High Contrast swaps fills for
// outlines and hatching so no mark relies on a tint. Pure: no vscode, no Node.

import type { LoupeVM, MeterVM, ThemeKind, Tone } from './types';

export interface Palette { accent: string; warn: string; crit: string; ink: string }

// Contrast checked against each theme's default hover background (critique P1-13).
const PALETTES: Record<ThemeKind, Palette> = {
  light: { accent: '#6A41D6', warn: '#9A6700', crit: '#B42318', ink: '#3B3B3B' },
  dark: { accent: '#B4A2FF', warn: '#CCA700', crit: '#F14C4C', ink: '#CCCCCC' },
  'hc-dark': { accent: '#CDBEFF', warn: '#FFD370', crit: '#F48771', ink: '#FFFFFF' },
  'hc-light': { accent: '#4B1FB0', warn: '#895503', crit: '#B5200D', ink: '#292929' },
};

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** The baked palette, with any hex the user set in workbench.colorCustomizations. Anything else is ignored. */
export function palette(theme: ThemeKind, overrides: Partial<Palette> = {}): Palette {
  const p = { ...PALETTES[theme] };
  for (const k of Object.keys(p) as (keyof Palette)[]) {
    const v = overrides[k];
    if (typeof v === 'string' && HEX.test(v)) p[k] = v;
  }
  return p;
}

const isHc = (t: ThemeKind) => t === 'hc-dark' || t === 'hc-light';
const f = (x: number) => String(Math.round(x * 100) / 100);
const rect = (x: number, y: number, w: number, h: number, attrs: string) =>
  w > 0 && h > 0 ? `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" ${attrs}/>` : '';
const fill = (c: string, o = 1) => (o < 1 ? `fill="${c}" fill-opacity="${o}"` : `fill="${c}"`);
/** Many same-coloured rectangles as one path: a fraction of the bytes of a <rect> each. */
const bars = (rs: [number, number, number, number][], attrs: string) =>
  rs.length ? `<path d="${rs.map(([x, y, w, h]) => `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}z`).join('')}" ${attrs}/>` : '';

/** A 45° hatch of 1 px lines every 3 px, so a projection or a loose band reads without colour. */
const hatch = (id: string, c: string, o = 1) =>
  `<pattern id="${id}" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1" height="3" ${fill(c, o)}/></pattern>`;

function svg(w: number, h: number, defs: string, body: string): string {
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;
  return `data:image/svg+xml;base64,${btoa(s)}`;
}

/** [a, b] minus the hole [h0, h1]: zero, one or two pieces. */
function cut(a: number, b: number, h0: number, h1: number): [number, number][] {
  if (h1 <= a || h0 >= b) return [[a, b]];
  return ([[a, h0], [h1, b]] as [number, number][]).filter(([x, y]) => y - x >= 0.5);
}

const toneColour = (p: Palette, t: Tone) => (t === 'crit' ? p.crit : t === 'warn' ? p.warn : p.accent);

// ───────────────────────────── meter, 96 × 10 ─────────────────────────────

/**
 * A capsule track with a hairline outline (so the 100% end is always visible), the fill, the
 * projection to reset as a hatched ghost, and the elapsed-time marker with a 1 px gap on each side
 * so it stands clear of the fill in every theme.
 */
export function meterSvg(m: MeterVM, theme: ThemeKind, p: Palette): string {
  const hc = isHc(theme);
  const W = 96, x0 = 1, span = 94;                      // interior of the 1 px outline
  const x = (v: number) => x0 + (span * Math.min(100, Math.max(0, v))) / 100;
  const colour = toneColour(p, m.tone);
  const parts: string[] = [];
  parts.push(`<rect x="0.5" y="2.5" width="95" height="5" rx="2.5" ${hc ? 'fill="none"' : fill(p.accent, 0.16)} stroke="${p.ink}" stroke-opacity="${hc ? 1 : 0.45}"/>`);

  const mx = m.elapsed !== undefined ? Math.round(x(m.elapsed)) - 1 : undefined;   // 2 px marker
  const hole: [number, number] = mx !== undefined ? [mx - 1, mx + 3] : [Infinity, Infinity];
  const fx = Math.max(x0 + 2, x(m.fill));                // a sliver always shows, even at 0.1%
  const pieces = (a: number, b: number, attrs: string) => cut(a, b, ...hole).map(([s, e]) => rect(s, 3, e - s, 4, attrs)).join('');
  if (m.ghost) parts.push(pieces(fx, x(m.ghost[1]), 'fill="url(#g)"'));
  parts.push(pieces(x0, fx, `${fill(colour)} rx="1"`));
  if (mx !== undefined) parts.push(rect(mx, 0, 2, 10, `${fill(p.ink)} rx="1"`));
  return svg(W, 10, m.ghost ? hatch('g', hc ? p.ink : colour, hc ? 1 : 0.85) : '', parts.join(''));
}

// ───────────────────────────── the Loupe, 300 × 16 ─────────────────────────────

/** Transparent space above and below the Loupe: it spaces the row and keeps it centred on its labels. */
export const LOUPE_PAD = 5;

/**
 * A magnified scale between official whole numbers: staves at the edges, tenth ticks, the ±1σ and
 * ±2σ bands clipped to the proven bounds, and the estimate's tick. Loose is one flat band (the
 * value is uniform between its bounds), calibrating fills the bracket, stale runs to the right end
 * with an "at least" chevron. In High Contrast, ±1σ is an outline and the wider bands are hatched.
 */
export function loupeSvg(l: LoupeVM, theme: ThemeKind, p: Palette): string {
  const W = 300, H = 16;
  const body = loupeBody(l, theme, p, W, H);
  return svg(W, H + 2 * LOUPE_PAD, body.defs, body.marks ? `<g transform="translate(0 ${LOUPE_PAD})">${body.marks}</g>` : '');
}

function loupeBody(l: LoupeVM, theme: ThemeKind, p: Palette, W: number, H: number): { defs: string; marks: string } {
  const hc = isHc(theme);
  if (l.mode === 'none') return { defs: '', marks: '' };
  const range = Math.max(1e-9, l.to - l.from);
  const x = (v: number) => 1 + (298 * (Math.min(l.to, Math.max(l.from, v)) - l.from)) / range;
  const px = (v: number) => Math.round(x(v));
  // A w-pixel-wide mark centred on v, on whole pixels so a 1 px stave doesn't blur across two.
  const at = (v: number, w: number) => Math.min(W - w, Math.max(0, px(v) - Math.floor(w / 2)));
  const back: string[] = [], scale: string[] = [], front: string[] = [];
  const hatched = 'fill="url(#h)"';
  const band = (b: [number, number] | undefined, y: number, h: number, attrs: string) => {
    if (!b) return;
    // Whole pixels, rounded outward: crisp edges that never draw a band narrower than it is.
    const a = Math.floor(x(b[0])), z = Math.max(Math.ceil(x(b[1])), a + 1);
    back.push(rect(a, y, z - a, h, attrs));
  };

  switch (l.mode) {
    case 'graded':
      band(l.band2, 4, 8, hc ? hatched : fill(p.accent, 0.22));
      if (hc && l.band1) {
        const a = Math.floor(x(l.band1[0])), z = Math.max(Math.ceil(x(l.band1[1])), a + 2);
        back.push(rect(a + 0.5, 2.5, z - a - 1, 11, `fill="none" stroke="${p.ink}"`));
      } else band(l.band1, 2, 12, fill(p.accent, 0.45));
      break;
    case 'flat':
      band(l.band2, 2, 12, hc ? hatched : fill(p.accent, 0.35));
      break;
    case 'range':
      band(l.band2, 2, 12, hc ? hatched : fill(p.accent, 0.22));
      break;
    case 'atLeast':
      if (l.band2) band([l.band2[0], l.to], 2, 12, hc ? hatched : fill(p.accent, 0.22));
      break;
  }

  scale.push(rect(2, 7.5, 296, 1, fill(p.ink, 0.25)));
  const ticks: [number, number, number, number][] = [];
  const tenths = Math.round(range * 10);
  for (let i = 1; i < tenths; i++) {
    const v = l.from + i / 10;
    if (l.edges.some(e => Math.abs(e - v) < 1e-6)) continue;
    const centre = i % 10 === 5;
    ticks.push([px(v), centre ? 4 : 6, 1, centre ? 8 : 4]);
  }
  scale.push(bars(ticks, fill(p.ink, 0.35)));
  scale.push(bars(l.edges.map(e => {
    const w = Math.abs(e - l.from) < 1e-6 || Math.abs(e - l.to) < 1e-6 ? 2 : 1;
    return [at(e, w), 0, w, H];
  }), fill(p.ink, 0.85)));

  if (l.tick !== undefined && (l.mode === 'graded' || l.mode === 'flat')) {
    const w = l.mode === 'flat' ? 1 : 2;
    front.push(rect(at(l.tick, w), 0, w, H, fill(p.ink, l.mode === 'flat' ? 0.7 : 1)));
  }
  // Chevrons say the band carries on past the drawn range ("at least" for stale).
  const chevron = (right: boolean) => right
    ? `<path d="M291 4l5 4-5 4z" ${fill(p.accent)}/>`
    : `<path d="M9 4L4 8l5 4z" ${fill(p.accent)}/>`;
  if (l.overR || l.mode === 'atLeast') front.push(chevron(true));
  if (l.overL) front.push(chevron(false));

  return { defs: hc && l.band2 ? hatch('h', p.ink) : '', marks: back.join('') + scale.join('') + front.join('') };
}

// ───────────────────────────── text fallbacks (graphics: text) ─────────────────────────────
// WGL4 glyphs only, so Consolas and the common Linux monospace fonts all have them.

/** "████▌░│░░░░░": fill, a half cell, empty cells, and the elapsed cell as a bar. */
export function meterText(m: MeterVM, cells = 12): string {
  const n = (m.fill / 100) * cells;
  const full = Math.min(cells, Math.floor(n + 1e-9));
  const out = [...'█'.repeat(full) + (n - full >= 0.5 && full < cells ? '▌' : '')];
  while (out.length < cells) out.push('░');
  if (m.elapsed !== undefined) out[Math.min(cells - 1, Math.floor((m.elapsed / 100) * cells))] = '│';
  return out.join('');
}

/** "├────═══♦═══──────┤": staves, the band (±2σ, the loose bounds or "at least"), the estimate. */
export function loupeText(l: LoupeVM, cells = 20): string {
  const range = Math.max(1e-9, l.to - l.from);
  const at = (v: number) => Math.min(cells - 1, Math.max(0, Math.floor(((v - l.from) / range) * cells)));
  const out = Array<string>(cells).fill(l.mode === 'range' ? '░' : '─');
  const b = l.mode === 'atLeast' && l.band2 ? [l.band2[0], l.to] : l.mode === 'range' ? undefined : l.band2;
  if (b) for (let i = at(b[0]); i <= at(b[1] - 1e-9); i++) out[i] = '═';
  for (const e of l.edges.slice(1, -1)) out[at(e)] = '┼';
  if (l.tick !== undefined && (l.mode === 'graded' || l.mode === 'flat')) out[at(l.tick)] = l.mode === 'flat' ? '◊' : '♦';
  return `├${out.join('')}┤`;
}
