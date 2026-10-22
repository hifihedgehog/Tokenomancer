// What every renderer receives: the model, layout facts and the few actions a view can take.

import { BucketVM, DetailVM, RunCommand, ViewModel } from '../ui/types';

export interface UiState {
  v: 1;
  selected?: string;
  tables: Record<string, boolean>;        // table twins shown, by chart id
  open: Record<string, boolean>;          // view-surface disclosures, by section id
  last?: { vm: ViewModel; detail?: DetailVM; at: number };
}

/** A chart crosshair: which chart, at what time, and whether the keyboard put it there. */
export interface Cursor { id: string; t: number; kbd: boolean }

export interface Ctx {
  vm: ViewModel;
  detail?: DetailVM;                      // the selected bucket's, when it has arrived
  sel?: BucketVM;
  surface: 'panel' | 'view';
  busy: boolean;
  sr: boolean;                            // a screen reader is active: tables open by default
  ui: UiState;
  cur?: Cursor;
  focusKey?: string;                      // the card holding the roving tabindex
  /** Measured width of the element marked data-w=id, or the fallback before first layout. */
  w(id: string, fallback: number): number;
  /** Age of the last official reading, kept current between model updates. */
  ageMs(): number | undefined;
  run(cmd: RunCommand): void;
  select(key: string): void;
  moveFocus(key: string): void;
  setCur(c: Cursor | undefined): void;
  toggle(map: 'tables' | 'open', id: string): void;
}

export const tableOpen = (c: Ctx, id: string) => c.ui.tables[id] ?? c.sr;
