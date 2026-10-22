// The whole view as a tree, from the model and layout facts alone. No DOM access, so tests
// can render every fixture without a browser.

import { BucketVM, DetailVM, ViewModel } from '../ui/types';
import { banners, cards, header, headline } from './cards';
import { Ctx, UiState } from './ctx';
import { Child, h, rect } from './dom';
import { detail, footer, local, signedOut } from './sections';

/** The selected limit: the user's pick, else the one the detail is for, else the binding one. */
export function selected(vm: ViewModel, ui: UiState, d?: DetailVM): BucketVM | undefined {
  const by = (k?: string) => vm.buckets.find(b => b.key === k);
  return by(ui.selected) ?? by(d?.key) ?? vm.buckets.find(b => b.binding) ?? vm.buckets[0];
}

export function app(c: Ctx, said: string): Child[] {
  const vm = c.vm, out: Child[] = [
    h('svg.defs', { width: 0, height: 0 },
      h('pattern', { id: 'tk-hatch', width: 3, height: 3, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, rect('hatch', 0, 0, 1, 3))),
    h('div.sr', { role: 'status' }, said),
    header(c), banners(c),
  ];
  if (!vm.buckets.length && vm.fresh.state === 'signed-out') return [...out, signedOut(c), h('div.solo', local(vm.local), footer(c))];
  out.push(headline(c), cards(c), c.sel ? detail(c, c.sel, vm.buckets.indexOf(c.sel)) : local(vm.local));
  if (c.surface === 'view') out.push(h('button.btn.open', { onclick: () => c.run('openDashboard') }, 'Open dashboard'));
  return [...out, footer(c)];
}
