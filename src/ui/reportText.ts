// The full report (§5.12): a read-only Markdown document with every number at
// diagnostic precision, the calibration, this computer's usage, the endpoint's raw
// answer and the log folder. It never contains credentials. Pure: no vscode, no Node.

import type { Estimate } from '../estimator';
import { labels, keyOrder, num } from './present';
import { displayOrder } from './statusText';
import { clock, span } from './time';
import type { BucketVM, TimeFmt, ViewModel } from './types';

export interface ReportInput {
  vm: ViewModel;
  buckets: {
    key: string; estimate?: Estimate; samples: number; wuPerPct?: number; corrections: [string, number][];
    raw?: { utilization: number; resetsAt: string | null; t: number };
  }[];
  raw?: unknown;                          // the endpoint's last answer, verbatim
  events: number;                         // log events in memory
  oldestEvent?: number;
  logDir: string;
  pollLog: { t: number; ok: boolean }[];
  pollMs: number;
  role: 'fetcher' | 'shared' | 'solo';
  version: string;
}

const HOUR = 3_600_000;

// ───────────────────────────── Markdown helpers ─────────────────────────────

/** A table cell: one line, pipes escaped. */
const cell = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '\\|');
const row = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;

/** Inline code that survives backticks in the text, e.g. a Windows path. */
export function mdCode(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map(x => x.length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** A fenced block longer than any backtick run inside it. */
function fenced(lang: string, s: string): string {
  const longest = Math.max(2, ...(s.match(/`+/g) ?? []).map(x => x.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${s}\n${fence}`;
}

// ───────────────────────────── credentials ─────────────────────────────

const SECRET_KEY = /token|secret|auth|cookie|password|credential|api[-_]?key/i;
const BUCKET_KEY = /^(five_hour|seven_day)/;          // "seven_day_oauth_apps" is a limit, not a secret
const SECRET_VALUE = /^(sk-ant-|eyJ|Bearer )|^[A-Za-z0-9+/_.=-]{40,}$/;

/** A copy with anything credential-like removed: keys named like secrets, and values shaped like tokens. */
export function redact(x: unknown, depth = 0): unknown {
  if (depth > 8) return '[…]';
  if (typeof x === 'string') return SECRET_VALUE.test(x) ? '[redacted]' : x;
  if (Array.isArray(x)) return x.map(v => redact(v, depth + 1));
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) {
      if (SECRET_KEY.test(k) && !BUCKET_KEY.test(k)) continue;
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return x;
}

// ───────────────────────────── formats ─────────────────────────────

function dateTime(t: number, fmt: TimeFmt, year: boolean): string {
  const o: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: fmt.timeZone };
  if (year) o.year = 'numeric';
  if (fmt.hour12 !== undefined) o.hour12 = fmt.hour12;
  try { return new Intl.DateTimeFormat(fmt.locale, o).format(t); } catch { return new Date(t).toISOString(); }
}

const pct3 = (x?: number) => (x === undefined ? '—' : `${x.toFixed(3)}%`);
const usd = (x?: number) => (x === undefined ? '—' : `$${x.toFixed(x < 10 ? 3 : 2)}`);
const rate = (x?: number) => (x === undefined ? '—' : `${x.toFixed(2)} %/h`);
const ROLE: Record<ReportInput['role'], string> = {
  fetcher: 'this window reads the endpoint and shares it with other windows',
  shared: 'another VS Code window reads the endpoint and shares it',
  solo: 'this window reads the endpoint (no shared folder)',
};
const PART: Record<string, string> = { in: 'input and cache writes', out: 'output', read: 'cache reads' };
const FAMILY: Record<string, string> = { fable: 'Fable', mythos: 'Mythos', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other models' };

/** "fable:read" → "Fable cache reads". */
function featureName(f: string): string {
  const [fam, part] = f.split(':');
  return `${FAMILY[fam] ?? fam} ${PART[part] ?? part ?? ''}`.trim();
}

/** A learned factor against API price ratios: "+11%", "−7%", "in line". */
function factorMeaning(g: number): string {
  const p = Math.round((g - 1) * 100);
  return p === 0 ? 'in line' : `${p > 0 ? '+' : '−'}${Math.abs(p)}%`;
}

// ───────────────────────────── sections ─────────────────────────────

type In = ReportInput['buckets'][number];

function limits(r: ReportInput, list: BucketVM[], inputs: Map<string, In>): string[] {
  const { vm } = r;
  const out = ['## Limits', '', '3 decimals: diagnostic precision; the status bar shows only the digits the ± supports.', ''];
  out.push(row(['Limit', 'Estimate', '±1σ', 'State', 'Bounds', 'Official', 'Resets', '1% ≈', 'Samples', 'Model error']));
  out.push('|---|---:|---:|---|---|---:|---|---:|---:|---:|');
  for (const b of list) {
    const e = inputs.get(b.key)?.estimate;
    const lo = e?.lo ?? b.lo, hi = e?.hi ?? b.hi, sigma = e?.sigma ?? b.sigma, spread = e?.spread ?? b.calib.spread;
    out.push(row([
      b.long, pct3(e?.value ?? b.value), sigma !== undefined ? sigma.toFixed(3) : '—', b.text.state,
      lo !== undefined && hi !== undefined ? `${lo.toFixed(3)}–${hi.toFixed(3)}` : '—',
      `${num(b.official, 3)}%`, b.resetsAt !== undefined ? dateTime(b.resetsAt, vm.fmt, false) : '—',
      usd(inputs.get(b.key)?.wuPerPct ?? b.calib.wuPerPct), String(inputs.get(b.key)?.samples ?? b.calib.samples),
      spread !== undefined ? `±${Math.round(spread * 100)}%` : '—',
    ]));
  }
  // One line per distinct explanation, so three pinned limits don't repeat the same sentence.
  const tips = new Map<string, string[]>();
  for (const b of list) tips.set(b.text.stateTip, [...(tips.get(b.text.stateTip) ?? []), b.long]);
  out.push('');
  for (const [tip, names] of tips) out.push(`- **${names.join(', ')}**: ${tip}`);
  if (vm.extras.length) out.push('', `No time window: ${vm.extras.map(x => `${x.label} ${x.text}`).join(' · ')}.`);
  for (const n of vm.notes) out.push('', `> ${n}`);
  return out;
}

function pace(r: ReportInput, list: BucketVM[]): string[] {
  const { vm } = r;
  const at = (t: number) => clock(t, vm.now, vm.fmt);
  const out = ['## Pace and projection', ''];
  out.push(row(['Limit', '15-min pace here', 'Window average', 'Lands at reset', 'Runs out', 'Next 1%', 'Even use', 'Verdict']));
  out.push('|---|---:|---:|---|---|---|---|---|');
  for (const b of list) {
    const p = b.pace;
    if (!p) { out.push(row([b.long, '—', '—', '—', '—', '—', '—', b.text.verdict || b.text.state])); continue; }
    const lands = Math.round(p.projLow) === Math.round(p.projHigh) ? `${num(p.projLow, 1)}%` : `${num(p.projLow, 1)}–${num(p.projHigh, 1)}%`;
    const runOut = p.runOut ? `~${at(p.runOut.mid)} (${at(p.runOut.from)}–${at(p.runOut.to)})` : '—';
    const next = p.nextTick ? `${span(p.nextTick.from - vm.now)}–${span(p.nextTick.to - vm.now)} (to ${num(p.nextTick.edge, 1)}%)` : '—';
    const even = `${num(p.evenUse, 1)}% (${p.evenGap >= 0 ? '+' : '−'}${num(Math.abs(p.evenGap), 1)} pts)`;
    out.push(row([b.long, rate(p.r15), rate(p.rAvg), lands, runOut, next, even, b.text.verdict]));
  }
  return out;
}

function calibration(r: ReportInput, list: BucketVM[], inputs: Map<string, In>): string[] {
  // Factors are relative to the user's own mix, not absolute (critique P1-16), so the report says so once.
  const out = ['## Calibration', '', 'Factors say how much more or less each kind of token counts than API price ratios predict, '
    + 'relative to the rest of your mix; 1% ≈ is the API-equivalent cost of one point.', ''];
  for (const b of list) {
    const i = inputs.get(b.key);
    const samples = i?.samples ?? b.calib.samples;
    const ticks = samples > 0 ? `${samples} ${samples === 1 ? 'interval' : 'intervals'} between ticks learned`
      : b.calib.armed ? 'one tick seen; decimals appear after the next' : 'waiting for two ticks while you use Claude Code here';
    const wpp = i?.wuPerPct ?? b.calib.wuPerPct;
    out.push(`**${b.long}** · ${ticks}${wpp !== undefined ? ` · 1% ≈ ${usd(wpp)} API-equivalent` : ''}`
      + `${b.calib.spread !== undefined ? ` · model error ±${Math.round(b.calib.spread * 100)}% per point` : ''}`, '');
    const corr = (i?.corrections ?? []).filter(([, g]) => isFinite(g));
    if (corr.length) {
      out.push(row(['Tokens', 'Factor', 'vs API price ratios']), '|---|---:|---:|');
      for (const [f, g] of corr) out.push(row([featureName(f), `×${g.toFixed(2)}`, factorMeaning(g)]));
      out.push('');
    }
  }
  return out;
}

function computer(r: ReportInput): string[] {
  const { vm } = r, l = vm.local;
  const out = ['## This computer', ''];
  const range = `${dateTime(l.from, vm.fmt, false)} → ${clock(l.to, vm.now, vm.fmt)}`;
  out.push(`**${l.label}** (${range}): ${l.requests} requests · ${usd(l.usd)} API-equivalent`, '');
  if (l.byFamily.length) {
    out.push(row(['Model', 'API-equivalent', 'Share']), '|---|---:|---:|');
    for (const f of l.byFamily) out.push(row([FAMILY[f.family] ?? f.family, usd(f.usd), `${Math.round(f.share * 100)}%`]));
    out.push('');
  }
  const t = l.tokens;
  out.push(`Tokens: input ${t.input.toLocaleString('en-US')} · output ${t.output.toLocaleString('en-US')} · `
    + `cache write ${t.cacheWrite.toLocaleString('en-US')} · cache read ${t.cacheRead.toLocaleString('en-US')}`);
  return out;
}

function endpoint(r: ReportInput): string[] {
  const { vm } = r, f = vm.fresh, now = vm.now;
  const out = ['## Endpoint', ''];
  const raw = r.raw && typeof r.raw === 'object' && !Array.isArray(r.raw) ? r.raw as Record<string, unknown> : undefined;
  const keys = raw ? Object.keys(raw).filter(k => !SECRET_KEY.test(k) || BUCKET_KEY.test(k)).sort(keyOrder)
    .map(k => (raw[k] === null ? `${k} (null)` : k)) : r.buckets.map(b => b.key);
  out.push(`- Keys returned: ${keys.length ? keys.map(mdCode).join(', ') : 'none yet'}`);
  out.push(`- Last success: ${f.lastOkAt !== undefined ? `${dateTime(f.lastOkAt, vm.fmt, false)} (${f.ageText})` : 'none this session'}`);
  const hour = r.pollLog.filter(p => p.t >= now - HOUR);
  out.push(`- Errors in the last hour: ${hour.filter(p => !p.ok).length} of ${hour.length} polls · polling every ${Math.round(r.pollMs / 1000)} s`);
  out.push(`- Backoff: ${f.nextTryAt !== undefined && f.nextTryAt > now ? `next try ${clock(f.nextTryAt, now, vm.fmt)} (in ${span(f.nextTryAt - now)})` : 'none'}`);
  out.push(`- Role: ${ROLE[r.role]}`);
  if (f.reason) out.push(`- Status: ${f.reason}${f.code && !f.reason.includes(f.code) ? ` (${f.code})` : ''}`);
  for (const b of r.buckets) {
    if (b.raw) out.push(`- ${labels(b.key).long}: ${num(b.raw.utilization, 3)}%, resets_at ${b.raw.resetsAt ?? 'null'}, read ${clock(b.raw.t, now, vm.fmt)}`);
  }
  if (r.raw !== undefined) out.push('', 'Raw response, credentials removed:', '', fenced('json', JSON.stringify(redact(r.raw), null, 2) ?? 'null'));
  return out;
}

function logs(r: ReportInput): string[] {
  const oldest = r.oldestEvent !== undefined ? ` (oldest ${dateTime(r.oldestEvent, r.vm.fmt, false)})` : '';
  return ['## Logs', '', `Events in memory: ${r.events.toLocaleString('en-US')}${oldest} · folder: ${mdCode(r.logDir)}`];
}

/** The report's Markdown. */
export function reportMarkdown(r: ReportInput): string {
  const { vm } = r;
  const list = displayOrder(vm);
  const inputs = new Map(r.buckets.map(b => [b.key, b]));
  const f = vm.fresh;
  const fresh = f.ageText ? `official numbers ${f.ageText}` : 'no official reading yet this session';
  const head = [
    `# Tokenomancer report — ${dateTime(vm.now, vm.fmt, true)}`, '',
    `Tokenomancer ${r.version} · ${fresh} · every ${Math.round(r.pollMs / 1000)} s · ${ROLE[r.role]} · sample data: ${vm.sample ? 'yes' : 'no'}`,
  ];
  if (vm.sample) head.push('', '> Sample data, not your account. Nothing here reflects your real usage.');
  head.push('', `**${vm.headline.strong}**${vm.headline.rest ? ` — ${vm.headline.rest}` : ''}`);
  for (const reason of vm.reasons) head.push('', reason);
  const sections = list.length
    ? [limits(r, list, inputs), pace(r, list), calibration(r, list, inputs), computer(r), endpoint(r), logs(r)]
    : [computer(r), endpoint(r), logs(r)];
  return `${[head, ...sections].map(s => s.join('\n')).join('\n\n')}\n`;
}
