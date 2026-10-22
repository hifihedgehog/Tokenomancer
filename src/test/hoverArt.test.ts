import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { LOUPE_PAD, Palette, loupeSvg, loupeText, meterSvg, meterText, palette } from '../ui/hoverArt';
import { MIN, NOW, build, edgeBuckets } from './nativeFixtures';
import type { BucketVM, LoupeVM, MeterVM, ThemeKind } from '../ui/types';

const THEMES: ThemeKind[] = ['light', 'dark', 'hc-dark', 'hc-light'];
const isHc = (t: ThemeKind) => t.startsWith('hc');
const e = edgeBuckets();
const one = (b: typeof e.pinned5, o: Parameters<typeof build>[1] = {}): BucketVM => build([b], o).buckets[0];
const STATES: Record<string, BucketVM> = {
  pinned: one(e.pinnedWk), counted: one(e.countedFable), loose: one(e.looseWk), calibrating: one(e.calibrating5),
  stale: one(e.pinnedWk, { fresh: { lastOkAt: NOW - 20 * MIN } }), urgent: one(e.urgent5), limit: one(e.limit5), idle: one(e.idle5),
};
const decode = (uri: string) => {
  assert.ok(uri.startsWith('data:image/svg+xml;base64,'));
  return Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString();
};
interface Rect { x: number; y: number; w: number; h: number; fill?: string; stroke?: string; 'fill-opacity'?: string }
const rects = (svg: string): Rect[] => [...svg.replace(/<defs>.*<\/defs>/, '').matchAll(/<rect ([^>]*)\/>/g)].map(m => {
  const a: Record<string, string> = Object.fromEntries([...m[1].matchAll(/([a-z-]+)="([^"]*)"/g)].map(x => [x[1], x[2]]));
  return { ...a, x: Number(a.x ?? 0), y: Number(a.y ?? 0), w: Number(a.width), h: Number(a.height) };
});
const colours = (svg: string) => new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]+)"/g)].map(m => m[1].toUpperCase()));

// ───────────────────────────── palette and contrast ─────────────────────────────

const lum = (hex: string) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const THEME_FILES: [string, ThemeKind][] = [
  ['DefaultLightModern', 'light'], ['DefaultLight', 'light'], ['DefaultDarkModern', 'dark'], ['DefaultDark', 'dark'],
  ['DefaultHighContrast', 'hc-dark'], ['DefaultHighContrastLight', 'hc-light'],
];

test('every mark colour has at least 3:1 contrast with each default theme\'s hover background', () => {
  const dir = path.join(__dirname, '../../test/fixtures/themes');
  for (const [file, kind] of THEME_FILES) {
    const style: string = JSON.parse(fs.readFileSync(path.join(dir, `${file}.json`), 'utf8')).htmlStyle;
    const bg = style.match(/--vscode-editorHoverWidget-background: (#[0-9a-fA-F]{6})/)![1];
    const p = palette(kind);
    for (const k of ['accent', 'warn', 'crit', 'ink'] as const) {
      assert.ok(contrast(p[k], bg) >= 3, `${file} ${k} ${p[k]} on ${bg}: ${contrast(p[k], bg).toFixed(2)}`);
    }
  }
});

test('palette overrides take a hex colour and ignore anything else', () => {
  assert.equal(palette('dark', { accent: '#FF0000' }).accent, '#FF0000');
  assert.equal(palette('dark', { accent: '#f00' }).accent, '#f00');
  for (const bad of ['red', 'var(--x)', '#12345', '#GGGGGG', '#B4A2FF"/><script>', '' as string]) {
    assert.equal(palette('dark', { accent: bad }).accent, palette('dark').accent, bad);
  }
  assert.notDeepEqual(palette('light'), palette('dark'));
});

// ───────────────────────────── meter ─────────────────────────────

test('meter: outlined track, fill split around the elapsed marker, hatched projection in every theme', () => {
  for (const t of THEMES) for (const [name, b] of Object.entries(STATES)) {
    const p = palette(t);
    const svg = decode(meterSvg(b.meter, t, p));
    assert.ok(svg.length <= 1024, `${name} ${t}: ${svg.length} B`);
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="96" height="10" viewBox="0 0 96 10">/);
    const rs = rects(svg);
    const track = rs[0];
    assert.equal(track.stroke, p.ink, `${name} ${t}: the track has an outline`);
    assert.equal(track.fill, isHc(t) ? 'none' : p.accent, `${name} ${t}`);
    const marker = rs.find(r => r.y === 0 && r.h === 10);
    assert.equal(marker !== undefined, b.meter.elapsed !== undefined, name);
    if (marker) {
      // A 1 px gap on each side of the marker, so it never relies on contrast with the fill (critique P1-13).
      for (const r of rs.filter(r => r.y === 3)) assert.ok(r.x + r.w <= marker.x - 1 || r.x >= marker.x + marker.w + 1, `${name} ${t}: ${r.x}+${r.w} vs ${marker.x}`);
    }
    const tone = b.meter.tone === 'crit' ? p.crit : b.meter.tone === 'warn' ? p.warn : p.accent;
    assert.ok(rs.some(r => r.y === 3 && r.fill === tone), `${name} ${t}: fill in its tone`);
    assert.equal(svg.includes('url(#g)'), b.meter.ghost !== undefined && b.meter.ghost[1] > b.meter.ghost[0] + 0.5, `${name} ${t}: ghost`);
    for (const c of colours(svg)) assert.ok(Object.values(p).map(x => x.toUpperCase()).includes(c), `${name} ${t}: ${c}`);
  }
});

test('meter: a sliver always shows, the fill never passes 100, and the tone follows attention', () => {
  const m = (o: Partial<MeterVM>): MeterVM => ({ fill: 0.1, tone: 'accent', ...o });
  const fillOf = (svg: string) => rects(svg).filter(r => r.y === 3 && r.fill !== 'url(#g)');
  const p = palette('dark');
  assert.ok(fillOf(decode(meterSvg(m({}), 'dark', p)))[0].w >= 2);
  const full = fillOf(decode(meterSvg(m({ fill: 130 }), 'dark', p)));
  assert.equal(full[0].x + full[0].w, 95);
  assert.equal(STATES.urgent.meter.tone, 'warn');
  assert.equal(STATES.limit.meter.tone, 'crit');
  assert.ok(decode(meterSvg(STATES.limit.meter, 'dark', p)).includes(`fill="${p.crit}"`));
});

// ───────────────────────────── the Loupe ─────────────────────────────

test('Loupe: each state draws its own shape in every theme', () => {
  for (const t of THEMES) {
    const p = palette(t), hc = isHc(t);
    const svg = (b: BucketVM) => decode(loupeSvg(b.loupe, t, p));
    for (const [name, b] of Object.entries(STATES)) {
      const s = svg(b);
      assert.ok(s.length <= 2048, `${name} ${t}: ${s.length} B`);
      assert.ok(s.includes(`height="${16 + 2 * LOUPE_PAD}"`), name);
      for (const c of colours(s)) assert.ok(Object.values(p).map(x => x.toUpperCase()).includes(c), `${name} ${t}: ${c}`);
    }
    const tick = (s: string) => rects(s).find(r => r.y === 0 && r.h === 16 && r.fill === p.ink && r['fill-opacity'] !== '0.85');

    const pinned = svg(STATES.pinned);
    assert.equal(STATES.pinned.loupe.mode, 'graded');
    assert.equal(tick(pinned)?.w, 2, `${t}: the estimate's tick`);
    if (hc) {
      assert.ok(pinned.includes(`fill="none" stroke="${p.ink}"`), `${t}: ±1σ is an outline`);
      assert.ok(pinned.includes('url(#h)'), `${t}: ±2σ is hatched`);
    } else {
      assert.ok(pinned.includes('fill-opacity="0.45"') && pinned.includes('fill-opacity="0.22"'), `${t}: two graded bands`);
    }

    const loose = svg(STATES.loose);
    assert.equal(STATES.loose.loupe.mode, 'flat');
    assert.equal(tick(loose)?.w, 1);
    assert.ok(hc ? loose.includes('url(#h)') : loose.includes('fill-opacity="0.35"'), `${t}: one flat band`);

    const cal = svg(STATES.calibrating);
    assert.equal(STATES.calibrating.loupe.mode, 'range');
    assert.equal(tick(cal), undefined, `${t}: calibrating has no tick`);

    const stale = svg(STATES.stale);
    assert.equal(STATES.stale.loupe.mode, 'atLeast');
    assert.equal(tick(stale), undefined);
    assert.ok(stale.includes('<path d="M291 4l5 4-5 4z"'), `${t}: the "at least" chevron`);
    const band = rects(stale).find(r => r.y === 2 && r.h === 12)!;
    assert.ok(band.x + band.w >= 298, `${t}: the band runs to the right end`);

    assert.ok(!svg(STATES.limit).includes('<rect') && !svg(STATES.idle).includes('<rect'), `${t}: nothing to magnify`);
  }
});

test('Loupe: staves at the bracket edges, tenth ticks between, chevrons when the band runs past', () => {
  const l: LoupeVM = { mode: 'graded', from: 23, to: 25, edges: [23, 24, 25], edgeLabels: ['23', '25'], band1: [23.4, 24.2], band2: [23, 25], tick: 23.8, overL: true, overR: true };
  const s = decode(loupeSvg(l, 'dark', palette('dark')));
  const staves = s.match(/<path d="([^"]*)" fill="#CCCCCC" fill-opacity="0.85"\/>/)![1];
  assert.equal(staves, 'M0 0h2v16h-2zM150 0h1v16h-1zM298 0h2v16h-2z');
  const ticks = s.match(/<path d="([^"]*)" fill="#CCCCCC" fill-opacity="0.35"\/>/)![1].split('z').filter(Boolean);
  assert.equal(ticks.length, 18);
  assert.ok(s.includes('M291 4l5 4-5 4z') && s.includes('M9 4L4 8l5 4z'));
});

// ───────────────────────────── text fallbacks ─────────────────────────────

test('text meter: 12 cells of WGL4 blocks, a half cell and the elapsed bar', () => {
  assert.equal(meterText({ fill: 50, elapsed: 75, tone: 'accent' }), '██████░░░│░░');
  assert.equal(meterText({ fill: 46.4, tone: 'accent' }), '█████▌░░░░░░');
  assert.equal(meterText({ fill: 100, elapsed: 100, tone: 'crit' }), '███████████│');
  assert.equal(meterText({ fill: 0, tone: 'accent' }), '░░░░░░░░░░░░');
});

test('text Loupe: staves, the band, the estimate; a flat diamond for loose; shade for calibrating', () => {
  for (const b of Object.values(STATES)) assert.match(loupeText(b.loupe), /^├[─═░┼♦◊]{20}┤$/);
  assert.ok(loupeText(STATES.pinned.loupe).includes('♦'));
  assert.ok(loupeText(STATES.loose.loupe).includes('◊'));
  assert.equal(loupeText(STATES.calibrating.loupe), `├${'░'.repeat(20)}┤`);
  assert.ok(loupeText(STATES.stale.loupe).endsWith('═┤'));
});

test('the palette type is the four baked tokens', () => {
  const keys: (keyof Palette)[] = ['accent', 'warn', 'crit', 'ink'];
  for (const t of THEMES) assert.deepEqual(Object.keys(palette(t)).sort(), [...keys].sort());
});
