// The status-bar hover (§4), as the source of a MarkdownString with supportHtml.
// It keeps to the subset VS Code 1.90 renders: table/tr/td(align), span with a
// codicon class or a colour style, img, b, small, code, br, p. Every dynamic
// string sits in a block of raw HTML and goes through htmlEscape, so each has one
// escaping context; only static text (links, the sample line) is Markdown.
// Lines are wrapped by hand to stay under ~480 px, because the hover lifts its
// 500 px cap once an image loads and long lines would reflow (critique P1-14).
// Pure: no vscode, no Node.

import { loupeAlt, meterAlt } from './present';
import { LOUPE_PAD, Palette, loupeSvg, loupeText, meterSvg, meterText, palette } from './hoverArt';
import { displayOrder, runeId } from './statusText';
import type { BucketVM, ThemeKind, ViewModel } from './types';

export const HOVER_COMMANDS = [
  'tokenomancer.openDashboard', 'tokenomancer.refresh', 'tokenomancer.showDetails', 'tokenomancer.copySummary',
  'tokenomancer.glance', 'tokenomancer.openSettings', 'tokenomancer.previewSampleData', 'tokenomancer.exitSampleData',
  'tokenomancer.showLog',
];

const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', $: '&#36;' };

/**
 * Text for raw HTML. `$` becomes an entity because VS Code turns `$(id)` into an icon across the
 * rendered HTML, attributes included (critique P0-2); newlines go because a blank line would end
 * the HTML block and drop the rest into Markdown.
 */
export const htmlEscape = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').replace(/[&<>"'$]/g, c => ENTITY[c]);

const LINE = 66;   // characters: about 430 px of the hover's proportional font

/** Splits plain text into lines of at most `width` characters (the first may be shorter), escaped, joined by <br>. */
export function wrap(text: string, width = LINE, first = width): string {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const room = lines.length ? width : first;
    if (cur && cur.length + 1 + w.length > room) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.map(htmlEscape).join('<br>');
}

const desc = (html: string) => (html ? `<span style="color:var(--vscode-descriptionForeground);">${html}</span>` : '');
const icon = (id: string, colour?: string) =>
  `<span class="codicon codicon-${id}"${colour ? ` style="color:var(--vscode-${colour});"` : ''}></span>`;
const nb = (s: string) => htmlEscape(s).replace(/ /g, '&nbsp;');   // a cell that never wraps

/** The row's shape: the attention codicon when urgent, otherwise the state's rune. */
function rowIcon(b: BucketVM, vm: ViewModel): string {
  if (b.attention >= 3) return icon('error', 'editorError-foreground');
  if (b.attention >= 2) return icon('warning', 'editorWarning-foreground');
  return icon(runeId(b.rune, vm.display.icon === 'codicon' ? 'codicon' : 'rune')!);
}

// ───────────────────────────── blocks ─────────────────────────────

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The bucket the headline's verdict is about, as present.ts headline() picks it, so the Loupe needn't repeat it. */
function headlineSubject(vm: ViewModel): BucketVM | undefined {
  if (vm.fresh.stale || vm.buckets.some(b => b.verdict === 'limited')) return undefined;
  return vm.buckets.find(b => b.verdict === 'runsOut') ?? vm.buckets.find(b => b.verdict === 'tight');
}

function headBlock(vm: ViewModel): string {
  const h = vm.headline;
  const maxAtt = Math.max(0, ...vm.buckets.map(b => b.attention));
  const cue = maxAtt >= 3 ? `${icon('error', 'editorError-foreground')}&nbsp;` : maxAtt >= 2 ? `${icon('warning', 'editorWarning-foreground')}&nbsp;` : '';
  // A headline that fits stays on one line; a longer one puts its explanation on the next.
  const oneLine = h.strong.length + 3 + h.rest.length <= LINE;
  const lines = [`${cue}<b>${htmlEscape(h.strong)}</b>${h.rest && oneLine ? ` — ${htmlEscape(h.rest)}` : ''}`];
  if (h.rest && !oneLine) lines.push(wrap(upperFirst(h.rest)));

  // With a table, the reading's age heads it; without one, only a refresh in flight is worth a line.
  if (!vm.buckets.length && vm.fresh.refreshing && vm.fresh.state !== 'starting') lines.push(desc('Refreshing…'));
  const why = shownClause(vm);
  if (why) lines.push(desc(wrap(why)));
  for (const r of vm.reasons) lines.push(desc(wrap(r)));
  return `<p>${lines.join('<br>')}</p>`;
}

/** Says which limits the status bar shows when it shows fewer than the table does. */
function shownClause(vm: ViewModel): string | undefined {
  if (vm.shown.length >= vm.buckets.length || !vm.shown.length) return undefined;
  const names = vm.shown.map(k => vm.buckets.find(b => b.key === k)!.long);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  if (vm.display.show === 'binding') return `Status bar shows ${list}, the limit that binds first`;
  return `Status bar shows ${list}`;
}

const OFFICIAL_STATES = new Set(['pinned', 'exact', 'counted', 'loose', 'calibrating', 'stale']);

function tableBlock(vm: ViewModel, theme: ThemeKind, p: Palette): string {
  const g = vm.display.graphics;
  const cell = (html: string, right = false) => `<td${right ? ' align="right"' : ''}>${html}</td>`;
  const head = (s: string) => desc(`<small>${nb(s)}</small>`);
  // The header's empty corner dates every number below it.
  const f = vm.fresh;
  const read = `${f.ageText ?? 'no reading yet'}${f.refreshing ? ' · refreshing…' : ''}`;
  const rows = [[cell(head(read)), g !== 'off' ? cell('') : '', cell(head('used'), true), cell(`&ensp;${head('state · official')}`), cell(`&ensp;${head('resets in')}`, true)].join('')];
  for (const b of displayOrder(vm)) {
    const art = g === 'images' ? `<img src="${meterSvg(b.meter, theme, p)}" width="96" height="10" alt="${htmlEscape(meterAlt(b))}">`
      : g === 'text' ? `<code>${meterText(b.meter)}</code>` : '';
    const pm = b.text.pm ? `&nbsp;${desc(nb(b.text.pm))}` : '';
    // The official whole number on every row (critique P1-15), unless the value already is it.
    const official = OFFICIAL_STATES.has(b.state) && b.text.official !== b.text.value;
    const state = official ? `${b.text.state} · ${b.text.official}` : b.text.state;
    const resets = b.state === 'idle' ? '—' : b.text.resetsIn ?? '—';
    rows.push([
      cell(`${rowIcon(b, vm)}&nbsp;${nb(b.long)}`),
      art ? cell(`&ensp;${art}`) : '',
      cell(`&ensp;<b>${nb(b.text.value)}</b>${pm}`, true),
      cell(`&ensp;${desc(nb(state))}`),
      cell(`&ensp;${desc(nb(resets))}`, true),
    ].join(''));
  }
  return `<table>${rows.map(r => `<tr>${r}</tr>`).join('')}</table>`;
}

/** The Loupe for the first limit (binding order) that has one, then its caption, verdict and pace. */
function loupeBlocks(vm: ViewModel, theme: ThemeKind, p: Palette): string[] {
  const b = vm.buckets.find(x => x.loupe.mode !== 'none');
  if (!b) return [];
  const l = b.loupe, g = vm.display.graphics;
  const out: string[] = [];
  const [lo, hi] = l.edgeLabels.map(htmlEscape);
  if (g === 'images') {
    const img = `<img src="${loupeSvg(l, theme, p)}" width="300" height="${16 + 2 * LOUPE_PAD}" alt="${htmlEscape(loupeAlt(b))}">`;
    out.push(`<table><tr><td>${nb(b.long)}</td><td align="right">&ensp;${lo}</td><td>&ensp;${img}&ensp;</td><td>${hi}</td></tr></table>`);
  } else if (g === 'text') {
    out.push(`<p>${nb(b.long)}&ensp;${lo}&nbsp;<code>${loupeText(l)}</code>&nbsp;${hi}</p>`);
  }
  const lines = [g === 'off' ? `<b>${htmlEscape(b.long)}</b> · ${wrap(b.text.caption, LINE, LINE - b.long.length - 3)}` : desc(wrap(b.text.caption))];
  // Say each thing once: a withheld verdict is the pace sentence, and the headline may carry either.
  const said = [vm.headline.rest];
  if (b.text.verdict && b !== headlineSubject(vm) && !said.some(x => same(x, b.text.verdict))) lines.push(desc(wrap(b.text.verdict)));
  said.push(b.text.verdict);
  if (b.text.pace && !said.some(x => same(x, b.text.pace))) lines.push(desc(wrap(b.text.pace)));
  out.push(`<p>${lines.join('<br>')}</p>`);
  return out;
}

const FAMILY_NAME: Record<string, string> = { fable: 'Fable', mythos: 'Mythos', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other' };

function localBlock(vm: ViewModel): string {
  const l = vm.local;
  if (!l.requests) return `<p><b>${htmlEscape(l.label)}</b> · ${desc('no Claude Code requests yet')}</p>`;
  const req = `${l.requests.toLocaleString('en-US')} ${l.requests === 1 ? 'request' : 'requests'}`;
  const lines = [`<b>${htmlEscape(l.label)}</b> · ${htmlEscape(`${req} · $${l.usd.toFixed(2)} API-equivalent`)}`];
  const fams = l.byFamily.filter(x => x.share >= 0.005).map(x => `${FAMILY_NAME[x.family] ?? x.family} ${Math.round(x.share * 100)}%`);
  // Token counts by type live in the dashboard and the report; the hover keeps to two lines here.
  if (fams.length) lines.push(desc(wrap(fams.join(' · '))));
  return `<p>${lines.join('<br>')}</p>`;
}

function notesBlock(vm: ViewModel): string | undefined {
  const lines = [...vm.extras.map(x => `${x.label}: ${x.text}`), ...vm.notes].map(s => desc(wrap(s)));
  return lines.length ? `<p>${lines.join('<br>')}</p>` : undefined;
}

const SAMPLE = '$(beaker) Sample data — not your account · [Exit sample data](command:tokenomancer.exitSampleData)';
const SIGN_IN = '[$(beaker) Preview with sample data](command:tokenomancer.previewSampleData) · '
  + '[$(folder) Set Claude folder](command:tokenomancer.openSettings?%5B%22tokenomancer.claudeDir%22%5D)';
const ACTIONS = '[$(graph-line) Dashboard](command:tokenomancer.openDashboard) · [$(refresh) Refresh](command:tokenomancer.refresh) · '
  + '[$(output) Report](command:tokenomancer.showDetails) · [$(copy) Copy](command:tokenomancer.copySummary) · '
  + '[$(gear)](command:tokenomancer.openSettings "Settings")';

/** The hover's Markdown source. `theme` picks the baked art palette; `overrides` are the user's hex colours. */
export function hoverMarkdown(vm: ViewModel, theme: ThemeKind, overrides?: Partial<Palette>): string {
  const p = palette(theme, overrides);
  const blocks: string[] = [];
  if (vm.sample) blocks.push(SAMPLE);
  blocks.push(headBlock(vm));
  if (vm.fresh.state === 'signed-out') blocks.push(SIGN_IN);
  if (vm.buckets.length) {
    blocks.push(tableBlock(vm, theme, p));
    blocks.push(...loupeBlocks(vm, theme, p));
  }
  if (vm.buckets.length || vm.local.requests) blocks.push('---', localBlock(vm));
  const notes = notesBlock(vm);
  if (notes) blocks.push(notes);
  blocks.push('---', ACTIONS);
  return `${blocks.join('\n\n')}\n`;
}
