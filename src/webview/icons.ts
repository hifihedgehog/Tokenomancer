// Inline icons, so the webview ships no font. Codicon paths are from @vscode/codicons 0.0.35
// (CC-BY-4.0, © Microsoft Corporation); the runes are Tokenomancer's own.

import { Rune } from '../ui/types';
import { h, VNode } from './dom';

// [path, evenodd, viewBox size]
const CODICONS = {
  refresh: ['M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z', 1],
  copy: ['M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7zM3 1L2 2v10l1 1V2h6.414l-1-1H3z', 1],
  output: ['M19.5 0v1.5L21 3v19.5L19.5 24h-15L3 22.5V3l1.5-1.5V0H6v1.5h3V0h1.5v1.5h3V0H15v1.5h3V0h1.5zm-15 22.5h15V3h-15v19.5zM7.5 6h9v1.5h-9V6zm9 6h-9v1.5h9V12zm-9 6h9v1.5h-9V18z', 1, 24],
  gear: ['M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.4v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 13.9l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2.1 4l2-2 2.1 1.4.4-2.4h2.8zm.6 7c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zM8 9c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1z', 0],
  warning: ['M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z', 1],
  error: ['M8.6 1c1.6.1 3.1.9 4.2 2 1.3 1.4 2 3.1 2 5.1 0 1.6-.6 3.1-1.6 4.4-1 1.2-2.4 2.1-4 2.4-1.6.3-3.2.1-4.6-.7-1.4-.8-2.5-2-3.1-3.5C.9 9.2.8 7.5 1.3 6c.5-1.6 1.4-2.9 2.8-3.8C5.4 1.3 7 .9 8.6 1zm.5 12.9c1.3-.3 2.5-1 3.4-2.1.8-1.1 1.3-2.4 1.2-3.8 0-1.6-.6-3.2-1.7-4.3-1-1-2.2-1.6-3.6-1.7-1.3-.1-2.7.2-3.8 1-1.1.8-1.9 1.9-2.3 3.3-.4 1.3-.4 2.7.2 4 .6 1.3 1.5 2.3 2.7 3 1.2.7 2.6.9 3.9.6zM7.9 7.5L10.3 5l.7.7-2.4 2.5 2.4 2.5-.7.7-2.4-2.5-2.4 2.5-.7-.7 2.4-2.5-2.4-2.5.7-.7 2.4 2.5z', 1],
  'chevron-right': ['M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z', 1],
  'chevron-down': ['M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z', 1],
  table: ['M13.5 2h-12l-.5.5v11l.5.5h12l.5-.5v-11l-.5-.5zM2 3h11v1H2V3zm7 4H6V5h3v2zm0 1v2H6V8h3zM2 5h3v2H2V5zm0 3h3v2H2V8zm0 5v-2h3v2H2zm4 0v-2h3v2H6zm7 0h-3v-2h3v2zm0-3h-3V8h3v2zm-3-3V5h3v2h-3z', 0],
  'link-external': ['M1.5 1H6v1H2v12h12v-4h1v4.5l-.5.5h-13l-.5-.5v-13l.5-.5zM15 1.5V8h-1V2.707L7.243 9.465l-.707-.708L13.293 2H8V1h6.5l.5.5z', 0],
  beaker: ['M13.893 13.558L10 6.006v-4h1v-1H9.994V1l-.456.005H5V2h1v3.952l-3.894 7.609A1 1 0 0 0 3 15.006h10a1 1 0 0 0 .893-1.448zm-7-7.15L7 6.193V2.036l2-.024v4.237l.11.215 1.827 3.542H5.049l1.844-3.598zM3 14.017l1.54-3.011h6.916l1.547 3L3 14.017z', 0],
  info: ['M8.568 1.031A6.8 6.8 0 0 1 12.76 3.05a7.06 7.06 0 0 1 .46 9.39 6.85 6.85 0 0 1-8.58 1.74 7 7 0 0 1-3.12-3.5 7.12 7.12 0 0 1-.23-4.71 7 7 0 0 1 2.77-3.79 6.8 6.8 0 0 1 4.508-1.149zM9.04 13.88a5.89 5.89 0 0 0 3.41-2.07 6.07 6.07 0 0 0-.4-8.06 5.82 5.82 0 0 0-7.43-.74 6.06 6.06 0 0 0 .5 10.29 5.81 5.81 0 0 0 3.92.58zM7.375 6h1.25V5h-1.25v1zm1.25 1v4h-1.25V7h1.25z', 1],
} as const;

export type IconName = keyof typeof CODICONS;

export function icon(name: IconName, cls = ''): VNode {
  const [d, eo, size = 16] = CODICONS[name] as readonly [string, number, number?];
  return h('svg', { class: `tk-ic ${cls}`, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d, 'fill-rule': eo ? 'evenodd' : null }));
}

/** Codicon geometry for drawing inside a chart's SVG. */
export function iconAt(name: IconName, x: number, y: number, s: number, cls: string): VNode {
  const [d, eo, size = 16] = CODICONS[name] as readonly [string, number, number?];
  return h('svg', { x, y, width: s, height: s, viewBox: `0 0 ${size} ${size}`, class: cls, 'aria-hidden': 'true' },
    h('path', { d, 'fill-rule': eo ? 'evenodd' : null }));
}

// The rune's centre mark, on a 16 grid: filled diamond (pinned), hollow (loose), three dots
// (calibrating), a dash (empty). Shape carries the state, so it never depends on colour.
function mark(r: Rune): VNode {
  switch (r) {
    case 'pinned': return h('path', { class: 'tk-rm', d: 'M8 3.2L12.8 8 8 12.8 3.2 8z' });
    case 'loose': return h('path', { class: 'tk-rm tk-rh', d: 'M8 4.3L11.7 8 8 11.7 4.3 8z' });
    case 'calibrating': return h('path', { class: 'tk-rm', d: 'M3.6 8a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0M6.7 8a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0M9.8 8a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0' });
    default: return h('rect', { class: 'tk-rm', x: 4, y: 7.25, width: 8, height: 1.5 });
  }
}

/** The state rune. `staves` adds the two scale staves of the brand mark (header and empty states). */
export function rune(r: Rune, size: number, staves = false, cls = ''): VNode {
  return h('svg', { class: `tk-rune ${cls}`, width: size, height: size, viewBox: staves ? '0 0 16 16' : '2 2 12 12', 'aria-hidden': 'true', focusable: 'false' },
    staves && h('path', { class: 'tk-rs', d: 'M1 1.5h1.5v13H1zM13.5 1.5H15v13h-1.5z' }),
    mark(r));
}
