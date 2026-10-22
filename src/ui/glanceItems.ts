// "Usage at a Glance": the QuickPick's title and items (§5.12). Labels, descriptions
// and details all accept $(icon) syntax, so text from the endpoint goes through
// noIcons. Pure: no vscode, no Node; glance.ts turns these into QuickPickItems.

import { displayOrder, noIcons, runeId } from './statusText';
import type { BucketVM, RunCommand, ViewModel } from './types';

export interface GlanceItem {
  label: string;
  description?: string;
  detail?: string;
  key?: string;                           // picking it opens the dashboard on this limit
  command?: RunCommand;                   // picking it runs this
  separator?: boolean;                    // a QuickPickItemKind.Separator with this label
}

const ACTIONS: GlanceItem[] = [
  { label: '$(graph-line) Open Dashboard', command: 'openDashboard' },
  { label: '$(refresh) Refresh Now', command: 'refresh' },
  { label: '$(output) Open Full Report', command: 'showDetails' },
  { label: '$(copy) Copy Usage Summary', command: 'copySummary' },
  { label: '$(gear) Settings', command: 'openSettings' },
];

function bucketIcon(b: BucketVM, vm: ViewModel): string {
  if (b.attention >= 3) return '$(error)';
  if (b.attention >= 2) return '$(warning)';
  return `$(${runeId(b.rune, vm.display.icon === 'codicon' ? 'codicon' : 'rune')})`;
}

function bucketItem(b: BucketVM, vm: ViewModel): GlanceItem {
  const t = b.text;
  const value = b.state === 'reset' ? 'new window' : `${t.value}${t.pm ? ` ${t.pm}` : ''}`;
  const official = t.official !== t.value && b.state !== 'reset' && b.state !== 'idle' ? ` · official ${t.official}` : '';
  // A withheld verdict is the pace sentence; a limit's verdict already says when it resets, and
  // "lands ~56% by 15:06" already names the reset clock.
  const resets = b.verdict === 'limited' ? ''
    : t.resetsIn ? (t.resetsAt && t.verdict.endsWith(`by ${t.resetsAt}`) ? `resets in ${t.resetsIn}` : `resets ${t.resetsAt} (in ${t.resetsIn})`)
    : t.resetsAt ? `reset at ${t.resetsAt}` : '';
  const detail = [t.verdict, resets, t.pace !== t.verdict ? t.pace : ''].filter(Boolean).join(' · ');
  return {
    label: `${bucketIcon(b, vm)} ${noIcons(b.long)}  ${value}`,
    description: `${t.state}${official}${b.binding && vm.buckets.length > 1 ? ' · binds first' : ''}`,
    detail: noIcons(detail),
    key: b.key,
  };
}

export function glance(vm: ViewModel): { title: string; items: GlanceItem[] } {
  const f = vm.fresh;
  const title = ['Claude usage', vm.sample ? 'sample data' : '', f.refreshing ? 'refreshing…' : f.ageText ?? ''].filter(Boolean).join(' · ');
  const items: GlanceItem[] = displayOrder(vm).map(b => bucketItem(b, vm));
  if (!vm.buckets.length) {
    const h = vm.headline;
    items.push({ label: `$(info) ${noIcons(h.strong)}`, detail: noIcons([h.rest, ...vm.reasons].filter(Boolean).join(' · ')) || undefined });
  }
  for (const x of vm.extras) items.push({ label: `${noIcons(x.label)}  ${x.text}`, description: 'no time window', command: 'openDashboard' });
  for (const n of vm.notes) items.push({ label: '$(info) Status bar setting', detail: noIcons(n), command: 'openSettings' });

  items.push({ label: 'Actions', separator: true });
  if (f.state === 'signed-out') items.push({ label: '$(folder) Set Claude Folder', command: 'setClaudeDir' });
  if (vm.sample) items.push({ label: '$(beaker) Exit Sample Data', command: 'exitSampleData' });
  else if (!vm.buckets.length) items.push({ label: '$(beaker) Preview with Sample Data', command: 'previewSampleData' });
  items.push(...ACTIONS);
  return { title, items };
}
