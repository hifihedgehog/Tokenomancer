import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOVER_COMMANDS, hoverMarkdown, htmlEscape, wrap } from '../ui/hoverMarkdown';
import { HOUR, LOCAL, MIN, NOW, bucket, build, demoBuckets, edgeBuckets, est } from './nativeFixtures';
import type { ThemeKind, UiConfig, ViewModel } from '../ui/types';

const THEMES: ThemeKind[] = ['light', 'dark', 'hc-dark', 'hc-light'];
const e = edgeBuckets();
const nothing = { ...LOCAL, requests: 0 };
const EVIL = '$(evil) <script>alert(1)</script> | C:\\Users\\me\\.claude\\.credentials.json & "q" \'s';

/** One view model per state the hover can be in, in each graphics mode. */
function gallery(): [string, ViewModel][] {
  const out: [string, ViewModel][] = [];
  const add = (name: string, vm: (g: UiConfig['graphics']) => ViewModel) => {
    for (const g of ['images', 'text', 'off'] as const) out.push([`${name}/${g}`, vm(g)]);
  };
  const c = (g: UiConfig['graphics'], o: Partial<UiConfig> = {}) => ({ graphics: g, ...o });
  add('scenario', g => build([e.pinnedWk, e.countedFable, e.pinned5], { cfg: c(g) }));
  add('sample', g => build([e.pinnedWk, e.countedFable, e.pinned5], { cfg: c(g), sample: true }));
  add('urgent', g => build([e.urgent5, e.pinnedWk], { cfg: c(g, { show: 'binding' }) }));
  add('limit', g => build([e.limit5, e.pinnedWk], { cfg: c(g) }));
  const exactFable = bucket(est('seven_day_fable', { kind: 'precise', official: 8.71, value: 8.71, sigma: undefined, lo: undefined, hi: undefined, resetIn: 50 * HOUR }));
  add('loose', g => build([e.looseWk, e.calibrating5, exactFable], { cfg: c(g) }));
  add('calibrating', g => build([e.calibrating5], { cfg: c(g, { rounding: 'round' }) }));
  add('idle', g => build([e.idle5], { cfg: c(g) }));
  add('stale', g => build([e.pinnedWk, e.pinned5], { cfg: c(g), fresh: { lastOkAt: NOW - 20 * MIN, error: { kind: 'network', message: EVIL, code: EVIL } } }));
  add('signed-out', g => build([], { cfg: c(g), local: nothing, fresh: { lastOkAt: undefined, error: { kind: 'no-credentials', message: '' }, claudeDir: EVIL } }));
  add('starting', g => build([], { cfg: c(g), local: nothing, fresh: { lastOkAt: undefined, refreshing: true } }));
  add('extras', g => build([e.pinned5], { cfg: c(g, { show: 'custom', customKeys: ['five_hour', '$(bug)<i>x</i>'] }), extras: [{ key: '$(bug)<b>', utilization: 12 }] }));
  add('evil key', g => build([bucket(est('seven_day_$(evil)<i>x</i>|', { resetIn: 50 * HOUR }))], { cfg: c(g) }));
  return out;
}

const TAGS = new Set(['table', 'tr', 'td', 'span', 'img', 'b', 'small', 'code', 'br', 'p']);
// The 1.90 sanitizer's rules (critique P0-2): codicon classes and the style regex.
const CLASS = /^codicon codicon-[a-z-]+( codicon-modifier-[a-z-]+)?$/;
const STYLE = /^(color:(#[0-9a-fA-F]+|var\(--vscode-[a-zA-Z-]+\));)?(background-color:(#[0-9a-fA-F]+|var\(--vscode-[a-zA-Z-]+\));)?$/;
const ATTRS: Record<string, string[]> = { td: ['align'], img: ['src', 'width', 'height', 'alt'], span: ['class', 'style'] };

const blocks = (md: string) => md.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
const isHtml = (b: string) => b.startsWith('<');
const decode = (s: string) => s.replace(/&nbsp;|&ensp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#36;/g, '$').replace(/&amp;/g, '&');
const svgs = (md: string) => [...md.matchAll(/src="data:image\/svg\+xml;base64,([^"]+)"/g)].map(m => Buffer.from(m[1], 'base64').toString());

test('every tag, attribute, class and style is in the 1.90 allowlist', () => {
  for (const [name, vm] of gallery()) for (const t of THEMES) {
    const md = hoverMarkdown(vm, t);
    for (const m of md.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
      const [, close, tag, rest] = m;
      assert.ok(TAGS.has(tag), `${name}: <${tag}>`);
      if (close) { assert.equal(rest, '', `${name}: </${tag}${rest}>`); continue; }
      const attrs = [...rest.matchAll(/\s([a-z]+)="([^"]*)"/g)];
      assert.equal(rest.replace(/\s([a-z]+)="([^"]*)"/g, '').trim(), '', `${name}: stray attribute text in <${tag}${rest}>`);
      for (const [, a, v] of attrs) {
        assert.ok((ATTRS[tag] ?? []).includes(a), `${name}: <${tag} ${a}>`);
        if (a === 'class') assert.match(v, CLASS, name);
        if (a === 'style') assert.match(v, STYLE, name);
        if (a === 'src') assert.ok(v.startsWith('data:image/svg+xml;base64,'), name);
        if (a === 'align') assert.ok(v === 'right' || v === 'left', name);
      }
      if (tag === 'span') assert.ok(attrs.length >= 1, `${name}: a bare span`);
    }
    assert.ok(!/border-radius|colspan|<abbr|<details/.test(md), name);
  }
});

test('each HTML block is one line, so no blank line can end it early', () => {
  for (const [name, vm] of gallery()) {
    const md = hoverMarkdown(vm, 'dark');
    for (const b of blocks(md).filter(isHtml)) assert.ok(!b.includes('\n'), `${name}: ${b.slice(0, 80)}`);
    for (const m of md.matchAll(/<table>[\s\S]*?<\/table>/g)) assert.ok(!/\n\s*\n/.test(m[0]), name);
    assert.ok(!/<\/table>\n(?!\n)/.test(md), `${name}: a table is followed by a blank line`);
  }
});

test('every command link is enabled, and none is a workbench command', () => {
  for (const [name, vm] of gallery()) {
    const md = hoverMarkdown(vm, 'dark');
    for (const [, id] of md.matchAll(/command:([A-Za-z0-9_.-]+)/g)) assert.ok(HOVER_COMMANDS.includes(id), `${name}: ${id}`);
  }
  assert.ok(HOVER_COMMANDS.every(c => c.startsWith('tokenomancer.')));
});

test('endpoint text, paths and keys cannot inject markup or icons', () => {
  for (const [name, vm] of gallery()) for (const t of THEMES) {
    const md = hoverMarkdown(vm, t);
    assert.ok(!/<script|<i>|<\/i>|<b>&lt;|alert\(1\)<\/script>/.test(md), name);
    // Icons come only from the static Markdown lines; inside HTML every $ is an entity (critique P0-2).
    for (const b of blocks(md).filter(isHtml)) assert.ok(!b.includes('$'), `${name}: ${b.slice(0, 120)}`);
    for (const b of blocks(md).filter(b => !isHtml(b) && b !== '---')) {
      for (const [, id] of b.matchAll(/\$\(([^)]*)\)/g)) assert.ok(['beaker', 'folder', 'graph-line', 'refresh', 'output', 'copy', 'gear'].includes(id), `${name}: $(${id})`);
    }
  }
  const stale = hoverMarkdown(gallery().find(([n]) => n === 'stale/images')![1], 'dark').replace(/<br>/g, ' ');
  assert.ok(stale.includes('&#36;(evil) &lt;script&gt;alert(1)&lt;/script&gt; | C:\\Users\\me\\.claude\\.credentials.json &amp; &quot;q&quot; &#39;s'));
  const out = hoverMarkdown(gallery().find(([n]) => n === 'signed-out/images')![1], 'dark');
  assert.ok(out.includes('C:\\Users\\me\\.claude\\.credentials.json'));
});

test('htmlEscape encodes $ and collapses newlines; wrap keeps every line within its width', () => {
  assert.equal(htmlEscape(`a & <b> "c" 'd' $(e)\n\n f`), 'a &amp; &lt;b&gt; &quot;c&quot; &#39;d&#39; &#36;(e) f');
  const text = 'Anthropic is rate-limiting the usage endpoint (HTTP 429). Counting local tokens since 12:52; next try 13:17.';
  const lines = wrap(text, 40).split('<br>');
  assert.ok(lines.length > 1 && lines.every(l => decode(l).length <= 40), lines.join(' | '));
  assert.equal(lines.map(decode).join(' '), text);
  assert.ok(decode(wrap(text, 40, 20).split('<br>')[0]).length <= 20);
});

test('text lines stay under ~480 px (critique P1-14)', () => {
  for (const [name, vm] of gallery()) {
    for (const b of blocks(hoverMarkdown(vm, 'dark')).filter(b => b.startsWith('<p>'))) {
      for (const line of b.split('<br>')) {
        const text = decode(line.replace(/<[^>]+>/g, ''));
        assert.ok(text.length <= 70, `${name}: ${text.length} "${text}"`);
      }
    }
  }
});

test('sizes: each meter ≤ 1 KB, the Loupe ≤ 2 KB, the hover ≤ 16 KB', () => {
  for (const [name, vm] of gallery()) for (const t of THEMES) {
    const md = hoverMarkdown(vm, t);
    assert.ok(md.length <= 16 * 1024, `${name} ${t}: ${md.length}`);
    for (const s of svgs(md)) assert.ok(s.length <= (s.includes('width="96"') ? 1024 : 2048), `${name} ${t}: ${s.length}`);
  }
});

test('graphics: text uses only WGL4 glyphs, with no span inside code; off draws nothing', () => {
  for (const [name, vm] of gallery()) {
    const md = hoverMarkdown(vm, 'dark');
    const codes = [...md.matchAll(/<code>([\s\S]*?)<\/code>/g)].map(m => m[1]);
    if (name.endsWith('/text')) {
      assert.ok(!md.includes('<img'), name);
      for (const c of codes) assert.match(c, /^[█▌░│├┤─═♦◊┼]+$/, `${name}: ${c}`);
      if (vm.buckets.length) assert.ok(codes.length >= vm.buckets.length, name);
    } else if (name.endsWith('/off')) {
      assert.ok(!md.includes('<img') && !md.includes('<code'), name);
    } else if (vm.buckets.length) {
      assert.equal(svgs(md).length, vm.buckets.length + (vm.buckets.some(b => b.loupe.mode !== 'none') ? 1 : 0), name);
    }
  }
});

test('each row shows its official whole number beside the state (critique P1-15)', () => {
  const md = hoverMarkdown(build([e.pinnedWk, e.countedFable, e.pinned5]), 'dark');
  assert.ok(md.includes('pinned&nbsp;·&nbsp;61%'));
  assert.ok(md.includes('counted&nbsp;·&nbsp;38%'));
  assert.ok(md.includes('pinned&nbsp;·&nbsp;44%'));
  // When the value is the official number, it isn't repeated.
  const exact = hoverMarkdown(build([e.exact5]), 'dark');
  assert.ok(exact.includes('>exact</span>') && !exact.includes('exact&nbsp;·'));
});

test('layout: sample line first, headline, table, Loupe of the first limit with one, local usage, actions', () => {
  const vm = build([e.pinnedWk, e.countedFable, e.pinned5], { sample: true });
  const bs = blocks(hoverMarkdown(vm, 'dark'));
  assert.ok(bs[0].startsWith('$(beaker) Sample data — not your account'));
  assert.equal(bs[1], '<p><b>Weekly runs out ~Sat 13:30</b><br>1d 20h before it resets, at your average pace this week</p>');
  assert.ok(bs[2].startsWith('<table><tr><td><span style="color:var(--vscode-descriptionForeground);"><small>read&nbsp;just&nbsp;now</small>'));
  assert.ok(bs[3].startsWith('<table><tr><td>Weekly</td><td align="right">&ensp;61</td>'));
  assert.ok(bs[3].includes('alt="Weekly between 61 and 62 percent: estimate 61.18, plus or minus 0.03, pinned."'));
  // The headline already carries the verdict, so the Loupe's lines don't repeat it.
  assert.ok(bs[4].includes('Pinned between official ticks · bounds 61.15–61.22%') && !bs[4].includes('Runs out'));
  assert.equal(bs[5], '---');
  assert.ok(bs[6].includes('This 5-hour window here</b> · 412 requests · &#36;23.17 API-equivalent'));
  assert.ok(bs[6].includes('Fable 82% · Sonnet 15% · Haiku 3%'));
  assert.equal(bs[bs.length - 2], '---');
  assert.ok(bs[bs.length - 1].startsWith('[$(graph-line) Dashboard](command:tokenomancer.openDashboard)'));
});

test('rows follow the status bar: shown limits first, with a note when it shows fewer', () => {
  const md = hoverMarkdown(build([e.pinnedWk, e.countedFable, e.pinned5], { cfg: { show: 'binding' } }), 'dark');
  assert.ok(md.includes('Status bar shows Weekly, the limit that binds first'));
  const rows = [...md.matchAll(/&nbsp;(5-hour|Weekly|Fable&nbsp;weekly)<\/td>/g)].map(m => m[1]);
  assert.deepEqual(rows, ['Weekly', 'Fable&nbsp;weekly', '5-hour']);
  const all = hoverMarkdown(build([e.pinnedWk, e.countedFable, e.pinned5]), 'dark');
  assert.deepEqual([...all.matchAll(/&nbsp;(5-hour|Weekly|Fable&nbsp;weekly)<\/td>/g)].map(m => m[1]), ['5-hour', 'Weekly', 'Fable&nbsp;weekly']);
  assert.ok(!all.includes('Status bar shows'));
});

test('urgent rows carry the attention codicon, not colour alone', () => {
  const md = hoverMarkdown(build([e.urgent5, e.pinnedWk]), 'dark');
  assert.ok(md.includes('<span class="codicon codicon-warning" style="color:var(--vscode-editorWarning-foreground);"></span>&nbsp;5-hour'));
  const lim = hoverMarkdown(build([e.limit5, e.pinnedWk]), 'dark');
  assert.ok(lim.includes('<span class="codicon codicon-error" style="color:var(--vscode-editorError-foreground);"></span>&nbsp;5-hour'));
  assert.ok(lim.includes('<b>5-hour limit reached</b> — resets 14:24 (in 1h 12m)'));
});

test('signed out: the reason, the sample and folder links, and no table', () => {
  const md = hoverMarkdown(build([], { local: nothing, fresh: { lastOkAt: undefined, error: { kind: 'no-credentials', message: '' } } }), 'dark');
  assert.ok(md.startsWith('<p><b>No Claude Code sign-in found</b><br>'));
  assert.ok(md.includes('Looked for a Claude Code sign-in in /home/me/.claude.'));
  assert.ok(md.includes('[$(beaker) Preview with sample data](command:tokenomancer.previewSampleData)'));
  assert.ok(md.includes('command:tokenomancer.openSettings?%5B%22tokenomancer.claudeDir%22%5D'));
  assert.ok(!md.includes('<table'));
});

test('the real sample data renders within budget in every theme', async () => {
  const { buckets } = await demoBuckets();
  const vm = build(buckets);
  for (const t of THEMES) {
    const md = hoverMarkdown(vm, t);
    assert.ok(md.length < 10 * 1024, `${t}: ${md.length}`);
    assert.equal(svgs(md).length, vm.buckets.length + 1);
  }
  assert.notEqual(hoverMarkdown(vm, 'dark'), hoverMarkdown(vm, 'light'));
  assert.notEqual(hoverMarkdown(vm, 'dark', { accent: '#FF0000' }), hoverMarkdown(vm, 'dark'));
});
