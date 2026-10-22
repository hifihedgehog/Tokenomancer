// Inline icons, so the webview ships no font. Refresh and gear are
// @vscode/codicons 0.0.35 paths (CC-BY-4.0, © Microsoft Corporation); the others are simplified
// redraws of their codicons on the same 16 grid, and the runes are Tokenomancer's own.

import { Rune } from '../ui/types';
import { h, VNode } from './dom';

const RING = 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 1 1 0 12A6 6 0 0 1 8 2z';

// Every path is filled even-odd, so a subpath inside another cuts a hole.
const PATHS = {
  refresh: 'M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z',
  copy: 'M5 4h9v11H5zm1 1v9h7V5zM2 1h9v2h-1V2H3v10h1v1H2z',
  output: 'M3 1.5 3.5 1h9l.5.5v13l-.5.5h-9l-.5-.5zM4 2v12h8V2zm1 2h6v1H5zm0 3h6v1H5zm0 3h4v1H5z',
  gear: 'M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.4v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 13.9l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2.1 4l2-2 2.1 1.4.4-2.4h2.8zm.6 7c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zM8 9c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1z',
  warning: 'M7.5 1h1l6.5 12.3-.4.7H1.4l-.4-.7zM8 2.3 2.3 13h11.4zM7.4 6h1.2v4H7.4zm0 5h1.2v1H7.4z',
  error: RING + 'M8 7.3 10 5.3l.7.7-2 2 2 2-.7.7-2-2-2 2-.7-.7 2-2-2-2 .7-.7z',
  'chevron-right': 'M5.7 3.7l.6-.7L11 8l-4.7 5-.6-.7L9.8 8z',
  'chevron-down': 'M3.7 5.7l-.7.6L8 11l5-4.7-.7-.6L8 9.8z',
  table: 'M1 2h14v12H1zm1 1v2h12V3zm0 3v3h3V6zm4 0v3h3V6zm4 0v3h4V6zm-8 4v3h3v-3zm4 0v3h3v-3zm4 0v3h4v-3z',
  beaker: 'M5.5 1h5v1H10v3.9l3.8 7.6-.7 1.5H2.9l-.7-1.5L6 5.9V2h-.5zM7 2v4.1L5.2 10h5.6L9 6.1V2z',
};

export type IconName = keyof typeof PATHS;

/** A codicon; `at` places it inside a chart's SVG instead of in the text flow. */
export function icon(name: IconName, cls = '', at?: [number, number, number]): VNode {
  const a = at ? { x: at[0], y: at[1], width: at[2], height: at[2] } : {};
  return h(at ? 'svg' : 'svg.ic', { ...a, class: cls || null, viewBox: '0 0 16 16' }, h('path', { d: PATHS[name], 'fill-rule': 'evenodd' }));
}

// The rune's centre mark, on a 16 grid: filled diamond (pinned), hollow (loose), three dots
// (calibrating; square, as at 10 px they read the same), a dash (empty). Shape carries the state, so it never depends on colour.
const MARK: Record<Rune, string> = {
  pinned: 'M8 3.2 12.8 8 8 12.8 3.2 8z',
  loose: 'M8 3.2 12.8 8 8 12.8 3.2 8zm0 2.1L5.3 8 8 10.7 10.7 8z',
  calibrating: 'M3.7 6.8h2.4v2.4H3.7zm3.1 0h2.4v2.4H6.8zm3.1 0h2.4v2.4H9.9z',
  empty: 'M4 7.25h8v1.5H4z',
};

/** The state rune. `staves` adds the two scale staves of the brand mark (header and empty states). */
export function rune(r: Rune, size: number, staves = false, cls = ''): VNode {
  return h('svg.rune', { class: cls || null, width: size, height: size, viewBox: staves ? '0 0 16 16' : '2 2 12 12' },
    staves && h('path.rs', { d: 'M1 1.5h1.5v13H1zm12.5 0H15v13h-1.5z' }),
    h('path.rm', { d: MARK[r], 'fill-rule': 'evenodd' }));
}
