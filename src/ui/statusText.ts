// The status-bar item's text, screen-reader label and background (§3.3–3.5).
// Pure: no vscode, no Node. The wrapper in statusBar.ts assigns what changed.

import { STATE_WORD, runOutClock, spokenValue } from './present';
import { age, clock, spokenClock } from './time';
import type { BucketVM, Rune, UiConfig, ViewModel } from './types';

const RUNE_ID: Record<'rune' | 'codicon', Record<Rune, string>> = {
  rune: { pinned: 'tokenomancer-pinned', loose: 'tokenomancer-loose', calibrating: 'tokenomancer-calibrating', empty: 'tokenomancer-empty' },
  codicon: { pinned: 'pinned', loose: 'circle-large-outline', calibrating: 'ellipsis', empty: 'dash' },
};

/** The icon id for a state's rune: the contributed glyph, its codicon fallback, or none. */
export function runeId(rune: Rune, icon: UiConfig['icon']): string | undefined {
  return icon === 'none' ? undefined : RUNE_ID[icon][rune];
}

/** Escapes icon syntax in text that came from the endpoint, so a key can't draw an icon. */
export const noIcons = (s: string) => s.replace(/\$\(/g, '\\$(');

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The shown buckets, in display order. */
export function shownBuckets(vm: ViewModel): BucketVM[] {
  return vm.shown.map(k => vm.buckets.find(b => b.key === k)).filter((b): b is BucketVM => b !== undefined);
}

/**
 * Every bucket, in the status bar's order and then the ones it leaves out in binding order, so
 * the hover, the glance and the copied summary list limits the way the status bar does.
 */
export function displayOrder(vm: ViewModel): BucketVM[] {
  const shown = shownBuckets(vm);
  return [...shown, ...vm.buckets.filter(b => !shown.includes(b))];
}

/** The shown bucket the text speaks about first: the most urgent, ties to the one that binds first. */
export function leadOf(vm: ViewModel, shown: BucketVM[]): BucketVM {
  const order = (b: BucketVM) => vm.buckets.indexOf(b);
  return [...shown].sort((a, b) => b.attention - a.attention || order(a) - order(b))[0];
}

/** "100% ~14:35" at the pace the attention level is about: the high pace at A2, the middle at A1. */
function runOutText(b: BucketVM, now: number, vm: ViewModel): string | undefined {
  const r = b.pace?.runOut;
  if (!r || b.attention < 1) return undefined;
  return `100% ~${clock(runOutClock(b.key, b.attention >= 2 ? r.from : r.mid), now, vm.fmt)}`;
}

function attentionSuffix(b: BucketVM, vm: ViewModel): string | undefined {
  if (b.attention >= 3) return b.text.resetsAt ? `resets ${b.text.resetsAt}` : undefined;
  return runOutText(b, vm.now, vm);
}

function segment(b: BucketVM, withPm: boolean): string {
  const value = b.state === 'reset' ? 'new window' : b.text.value;
  return `${noIcons(b.short)} ${value}${withPm && b.text.pm ? ` ${b.text.pm}` : ''}`;
}

export interface StatusText { text: string; a11y: string; background?: 'warning' | 'error' }

export function statusText(vm: ViewModel): StatusText {
  const shown = shownBuckets(vm);
  if (!shown.length) return emptyStatus(vm);
  const lead = leadOf(vm, shown);
  const att = lead.attention;
  const binding = shown.find(b => b.binding) ?? shown[0];
  const rune = runeId(binding.rune, vm.display.icon);
  // Attention icons are cues, not decoration, so they show even with icon: none.
  const icon = att >= 3 ? '$(error)' : att >= 2 ? '$(warning)' : rune ? `$(${rune})` : '';

  const u = vm.display.uncertainty;
  const segments = shown.map((b, i) => segment(b, u === 'every' || (u === 'first' && i === 0)));
  const attn = attentionSuffix(lead, vm);
  // With several limits shown, the suffix names the one it is about.
  const suffix = attn ? ` · ${shown.length > 1 ? `${noIcons(lead.short)} ` : ''}${attn}`
    : vm.fresh.stale ? ` · ${vm.fresh.lastOkAt !== undefined ? age(vm.now - vm.fresh.lastOkAt, 'bar') : 'last known'}`
    : '';
  const text = `${icon ? `${icon} ` : ''}${segments.join(' · ')}${suffix}${vm.sample ? ' · sample' : ''}`;

  const hl = vm.display.highlight;
  const background = att >= 3 && hl !== 'never' ? 'error' : att === 2 && hl === 'nearLimit' ? 'warning' : undefined;
  return { text, a11y: a11yLabel(vm, lead, shown), background };
}

/** "Fable weekly: about 38.4 percent used, counted" for the limits after the first. */
function spokenShort(b: BucketVM): string {
  const name = upperFirst(b.spokenLabel);
  if (b.state === 'limit') return `${name}: limit reached`;
  if (b.state === 'reset') return `${name}: ${spokenValue(b.state, b.text.value)}`;
  return `${name}: ${spokenValue(b.state, b.text.value)}, ${STATE_WORD[b.state]}`;
}

function a11yLabel(vm: ViewModel, lead: BucketVM, shown: BucketVM[]): string {
  const parts: string[] = [];
  if (vm.sample) parts.push('Sample data, not your account.');
  if (lead.attention === 2) parts.push('Warning.');
  parts.push(`${lead.text.spokenFull}.`);
  const others = shown.filter(b => b !== lead).map(spokenShort);
  if (others.length) parts.push(`${others.join('; ')}.`);
  if (vm.display.show === 'binding' && vm.buckets.length > 1) parts.push('Shown because it binds first.');
  return parts.join(' ');
}

const SHORT_REASON: Partial<Record<ViewModel['fresh']['state'], string>> = {
  offline: "can't reach api.anthropic.com",
  'rate-limited': 'the usage endpoint is rate-limiting requests',
  auth: 'the usage endpoint refused the sign-in',
};

/** Nothing to show yet: say why in a few words; the hover has the full sentence. */
function emptyStatus(vm: ViewModel): StatusText {
  const f = vm.fresh;
  const rune = runeId('empty', vm.display.icon);
  const icon = rune ? `$(${rune}) ` : '';
  const sample = vm.sample ? ' · sample' : '';
  const said = vm.sample ? 'Sample data, not your account. ' : '';
  const next = f.nextTryAt !== undefined && f.nextTryAt > vm.now ? ` Next try at ${spokenClock(f.nextTryAt, vm.now, vm.fmt)}.` : '';
  const say = (text: string, a11y: string): StatusText => ({ text: `${icon}${text}${sample}`, a11y: `${said}${a11y}` });
  switch (f.state) {
    case 'starting': return say('Claude usage', 'Claude usage: reading your plan usage.');
    case 'signed-out': return say('Claude: not signed in', 'Claude usage: no Claude Code sign-in found on this computer. Activate for details.');
    case 'expired': return say('Claude usage', 'Claude usage: waiting for Claude Code to refresh its sign-in.');
    case 'format': return say('Claude usage · unavailable', 'Claude usage: the usage endpoint answered in an unexpected format.');
    case 'offline': case 'rate-limited': case 'auth':
      return say(`Claude usage${f.nextTryText ? ` · retry ${f.nextTryText}` : ''}`, `Claude usage: can't read plan usage yet, ${SHORT_REASON[f.state]}.${next}`);
    default: return say('Claude usage', 'Claude usage: no plan limits in the latest reading.');
  }
}
