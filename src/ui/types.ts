// The contract between the model (extension host), the native surfaces
// (status bar, hover, glance, report) and the webview. Pure types only:
// nothing here may import vscode or Node, because the webview bundle uses it.
//
// Units: percentages are percentage points of the limit (0–100); times are epoch ms;
// money is API-equivalent USD. Strings in *.text fields are plain, unescaped text —
// every surface escapes for its own medium.

import type { Estimate } from '../estimator';

export type Kind = 'official' | 'precise' | 'anchored' | 'window-start' | 'lower-bound';
export type Family = 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku' | 'other';
export type BucketState = 'pinned' | 'exact' | 'counted' | 'loose' | 'calibrating' | 'stale' | 'limit' | 'idle' | 'reset';
export type Verdict = 'limited' | 'runsOut' | 'tight' | 'steady' | 'withheld';
export type Attention = 0 | 1 | 2 | 3;
export type FreshState = 'starting' | 'live' | 'delayed' | 'stale' | 'offline' | 'rate-limited' | 'expired' | 'auth' | 'signed-out' | 'format';
export type Rune = 'pinned' | 'loose' | 'calibrating' | 'empty';
export type Tone = 'accent' | 'warn' | 'crit';
export type ThemeKind = 'light' | 'dark' | 'hc-dark' | 'hc-light';
export type UsageErrorKind = 'no-credentials' | 'expired' | 'auth' | 'rate-limited' | 'network' | 'format';

/** How clocks are printed. `locale` undefined = the host's default. */
export interface TimeFmt { locale?: string; hour12?: boolean; timeZone?: string }

// ───────────────────────────── inputs (model.ts → buildViewModel) ─────────────────────────────

export interface UiConfig {
  decimals: number;                       // 0–3: the most decimals ever shown
  precision: 'adaptive' | 'fixed';        // adaptive: only the digits the ± supports
  rounding: 'floor' | 'round';            // how the official whole number is rounded
  show: 'all' | 'binding' | 'pair' | 'custom';
  customKeys: string[];                   // for show = custom, in the user's order
  uncertainty: 'off' | 'first' | 'every'; // ± in the status bar
  icon: 'rune' | 'codicon' | 'none';
  highlight: 'nearLimit' | 'limitOnly' | 'never';
  graphics: 'images' | 'text' | 'off';    // hover art
  pollMs: number;
  time: TimeFmt;
}

export interface BucketInput {
  key: string;
  estimate: Estimate;                     // BucketEstimator.estimate(now), unmodified
  /** The latest official reading for this key exactly as the endpoint gave it (undefined if none this session). */
  raw?: { utilization: number; resetsAt: string | null; t: number };
  armed: boolean;                         // calibration has seen its first tick (toJSON().calStart?.iFrom !== undefined)
  corrections: [string, number][];        // BucketEstimator.features(): [["fable:read", 1.11], ...]
}

export interface FreshInput {
  lastOkAt?: number;                      // request-sent time of the last applied successful reading
  error?: { kind: UsageErrorKind; message: string; code?: string };
  nextTryAt?: number;
  refreshing: boolean;
  role: 'fetcher' | 'shared' | 'solo';    // fetched the last reading itself, read another window's, or no shared folder
  claudeDir: string;                      // shown in the signed-out state
}

export interface ModelInput {
  now: number;
  cfg: UiConfig;
  buckets: BucketInput[];                 // every bucket with a time window (five_hour, seven_day, seven_day_*)
  extras: { key: string; utilization: number }[];  // windowless buckets, e.g. extra_usage
  fresh: FreshInput;
  local: LocalVM;
  sample: boolean;
}

// ───────────────────────────── view model (→ every surface) ─────────────────────────────

export interface ViewModel {
  v: 1;
  seq: number;                            // increments per build
  now: number;
  sample: boolean;
  fmt: TimeFmt;
  rounding: 'floor' | 'round';
  pollMs: number;
  display: Pick<UiConfig, 'uncertainty' | 'icon' | 'highlight' | 'graphics' | 'show'>;
  fresh: FreshVM;
  headline: { strong: string; rest: string; tone: 'neutral' | 'warn' | 'crit' };
  reasons: string[];                      // stale/error/sign-in explanations, one sentence each
  bindingKey?: string;                    // the limit that binds first
  buckets: BucketVM[];                    // windowed buckets in binding order
  shown: string[];                        // keys the status bar shows, in display order (per display.show)
  extras: { key: string; label: string; text: string }[];   // e.g. { label: 'Extra usage', text: '12%' }
  local: LocalVM;
  notes: string[];                        // e.g. an unknown custom key
}

export interface FreshVM {
  state: FreshState;
  stale: boolean;                         // age > staleAfter: values shown as lower bounds
  lastOkAt?: number;
  ageText?: string;                       // hover style: "read 3 min ago"
  nextTryAt?: number;
  nextTryText?: string;                   // "14:32"
  reason?: string;                        // plain text
  code?: string;                          // "ENOTFOUND", "HTTP 429", …
  refreshing: boolean;
  role: 'fetcher' | 'shared' | 'solo';
}

export interface BucketVM {
  key: string;
  short: string;                          // "5h", "wk", "Fable wk"
  long: string;                           // "5-hour", "Weekly", "Fable weekly"
  spokenLabel: string;                    // "five-hour"
  kind?: Kind;
  state: BucketState;
  rune: Rune;
  official: number;                       // as the endpoint gave it
  value: number;
  sigma?: number;                         // 1σ, points
  lo?: number; hi?: number;               // proven bounds now (Estimate.lo / .hi)
  bracket?: [number, number];             // official bracket [lo, hi); absent when exact
  digits: number;                         // decimals used in text.value
  windowMs?: number;
  windowStart?: number;
  resetsAt?: number;
  elapsed?: number;                       // 0–1 share of the window gone
  pace?: PaceVM;                          // absent when withheld
  verdict: Verdict;
  attention: Attention;
  binding: boolean;                       // this is ViewModel.bindingKey
  calib: { samples: number; armed: boolean; wuPerPct?: number; spread?: number };
  meter: MeterVM;
  loupe: LoupeVM;
  text: BucketText;
}

export interface BucketText {
  value: string;                          // "61.18%" | "~38.4%" | "23.1–24.5%" | "16–17%" | "≥61.1%" | "100%" | "0%" | "—"
  pm?: string;                            // "±0.03" (pinned, exact-with-σ, counted only)
  official: string;                       // "61%"
  state: string;                          // the state word: pinned, exact, counted, loose, calibrating, last known, limit, idle, reset
  stateTip: string;                       // one-sentence explanation of the state
  caption: string;                        // Loupe caption, e.g. "Pinned between official ticks · bounds 61.15–61.22%"
  pace: string;                           // "next 1% in 25–27 min · 15.8 pts ahead of even use" or the withheld text
  verdict: string;                        // "Runs out ~Sat 13:30 — 1d 19h before reset" | "Lands ~62–71% by 15:06" | …
  resetsAt?: string;                      // "Mon 09:00"
  resetsIn?: string;                      // "3d 20h"
  spoken: string;                         // short a11y phrase
  spokenFull: string;                     // with verdict and reading age
}

export interface PaceVM {
  r15?: number;                           // %/h over the last 15 min (this computer)
  rAvg?: number;                          // %/h averaged over the window so far
  low: number; high: number;              // %/h used for the projection range
  projLow: number; projHigh: number;      // % at reset, capped at 100
  runOut?: { from: number; to: number; mid: number };     // when 100% is reached, if before reset
  nextTick?: { from: number; to: number; edge: number };  // when the official number next ticks
  evenUse: number;                        // % a perfectly even pace would have used by now
  evenGap: number;                        // value − evenUse, points
}

/** Hover and card meter, in % of the limit. */
export interface MeterVM {
  fill: number;                           // 0–100
  ghost?: [number, number];               // projection to reset: [value, projHigh]
  elapsed?: number;                       // 0–100 marker
  tone: Tone;
}

/** "The Loupe": a magnified scale between whole numbers. All values in %. */
export interface LoupeVM {
  mode: 'graded' | 'flat' | 'range' | 'atLeast' | 'none';
  from: number; to: number;               // the drawn range (1 or 2 brackets wide)
  edges: number[];                        // bracket edges inside [from, to]
  edgeLabels: [string, string];           // "61", "62" (round mode "60.5", "61.5")
  band1?: [number, number];               // graded: ±1σ clipped to the bounds and range
  band2?: [number, number];               // graded: ±2σ clipped; flat/range/atLeast: the one band
  tick?: number;                          // the estimate, when shown
  overL?: boolean; overR?: boolean;       // the band continues beyond the drawn range
}

export interface LocalVM {
  from: number; to: number;
  label: string;                          // "This 5-hour window here" | "The last 5 hours here"
  requests: number;
  usd: number;
  byFamily: { family: Family; usd: number; share: number }[];   // descending
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
}

// ───────────────────────────── dashboard detail (selected bucket) ─────────────────────────────

/** Numbers only; the webview formats them with time.ts and the VM's fmt. */
export interface DetailVM {
  key: string;
  window: WindowSeries;
  zoom: ZoomSeries;
  mix: MixVM;
}

export interface Series { t: number[]; v: number[]; s: number[] }    // ms, %, 1σ points

export interface Lane { from: number; to: number; lo: number; hi: number }   // an official reading run: [lo, hi) % over [from, to] ms

export interface WindowSeries {
  from: number; to: number; now: number;  // window start → reset
  lanes: Lane[];
  est: Series;                            // reconstructed from local logs, anchored at now (≤ 400 points)
  calibrated: boolean;                    // false: est is empty and only lanes draw
}

export interface ZoomSeries {
  from: number; to: number;               // the span shown (30 min – 6 h, inside the window)
  yMin: number; yMax: number;             // bracket-edge aligned
  edges: number[];
  lanes: Lane[];
  ticks: { from: number; to: number; edge: number }[];   // each official crossing: the poll interval that holds it
  polls: number[];                        // successful readings (ms)
  failed: number[];                       // failed polls (ms)
  hist: { t: number[]; v: number[]; s: number[]; lo: number[]; hi: number[]; flat: boolean[] };  // recorded estimates
}

export interface MixVM {
  unit: 'pts' | 'usd';                    // pts once calibrated
  from: number; to: number;               // the bucket's current window (this computer)
  byFamily: { family: Family; value: number; usd: number; requests: number }[];   // descending by value
  byPart: { part: 'in' | 'out' | 'read'; value: number; usd: number }[];
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  requests: number;
  usd: number;
  wuPerPct?: number;
}

/** One recorded estimate (src/ui/history.ts). */
export interface HistoryPoint { t: number; v: number; s: number; lo?: number; hi?: number; kind: Kind; official: number }

// ───────────────────────────── webview messages ─────────────────────────────

export type RunCommand = 'refresh' | 'showDetails' | 'copySummary' | 'openSettings' | 'resetCalibration'
  | 'previewSampleData' | 'exitSampleData' | 'showLog' | 'openDashboard' | 'setClaudeDir';

export type ToView =
  | { type: 'model'; vm: ViewModel; detail?: DetailVM; theme: ThemeKind }
  | { type: 'busy'; value: boolean }
  | { type: 'select'; key: string };

export type FromView =
  | { type: 'ready'; surface: 'panel' | 'view' }
  | { type: 'select'; key: string }
  | { type: 'run'; command: RunCommand }
  | { type: 'error'; message: string };
