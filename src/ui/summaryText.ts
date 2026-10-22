// Copy Usage Summary: one line for the clipboard, in the status bar's order, with
// every ± (the status bar may hide it) and each state word, so a pasted number
// never claims more than it should. Pure: no vscode, no Node.

import { displayOrder } from './statusText';
import { clock } from './time';
import type { BucketVM, ViewModel } from './types';

function part(b: BucketVM): string {
  const t = b.text;
  if (b.state === 'reset') return `${b.long} new window (reset)`;
  const note = b.state === 'limit' && t.resetsAt ? `limit, resets ${t.resetsAt}` : t.state;
  return `${b.long} ${t.value}${t.pm ? ` ${t.pm}` : ''} (${note})`;
}

/** "Claude usage at 13:12 — 5-hour 44.27% ±0.02 (pinned) · Weekly 61.18% ±0.03 (pinned) · via Tokenomancer". */
export function summaryText(vm: ViewModel): string {
  const at = `Claude usage at ${clock(vm.now, vm.now, vm.fmt)}${vm.sample ? ' (sample data)' : ''}`;
  const list = displayOrder(vm);
  const body = list.length ? list.map(part).join(' · ')
    : [vm.headline.strong, vm.headline.rest].filter(Boolean).join(': ');
  const stale = vm.fresh.stale && list.length && vm.fresh.ageText ? ` · official numbers ${vm.fresh.ageText}` : '';
  return `${at} — ${body}${stale} · via Tokenomancer`;
}
