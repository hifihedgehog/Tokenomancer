// v0.1 formatting helpers, kept for the report and log lines. The display rules
// themselves (labels, digits, ±, clocks) live in src/ui/present.ts and src/ui/time.ts.

import { Estimate } from './estimator';
import { labels } from './ui/present';
import { clock } from './ui/time';
import { TimeFmt } from './ui/types';

/** Status-bar label: "5h", "wk", "Fable wk", "Apps wk". */
export function label(key: string): string {
  return labels(key).short;
}

export function fmtPct(e: Estimate, decimals: number): string {
  switch (e.kind) {
    case 'official': return `${Math.round(e.official)}%`;
    case 'precise': return `${e.value.toFixed(Math.max(decimals, 1))}%`;
    case 'anchored': return `${e.value.toFixed(decimals)}%`;
    case 'window-start': return `~${e.value.toFixed(decimals)}%`;
    case 'lower-bound': return `≈${e.value.toFixed(decimals)}%`;
  }
}

export function fmtMin(m?: number): string {
  if (m === undefined || !isFinite(m)) return '—';
  if (m < 1) return '<1 min';
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

/** "16:00" today, "Thu 09:00" this week, "Thu 29 Oct 09:00" beyond, so a reset 6–7 days away never reads as today. */
export function fmtTime(iso?: string | null, now = Date.now(), fmt: TimeFmt = {}): string {
  const t = iso ? Date.parse(iso) : NaN;
  return isNaN(t) ? '—' : clock(t, now, fmt);
}

/** Three significant figures: 950, 1.23k, 50.9k, 273k, 1.18M. Rounding never prints "1000k". */
export function fmtK(n: number): string {
  if (!isFinite(n)) return '—';
  if (Math.round(n) < 1000) return `${Math.round(n)}`;
  const sig3 = (x: number) => (x >= 99.95 ? x.toFixed(0) : x >= 9.995 ? x.toFixed(1) : x.toFixed(2));
  for (const [unit, size] of [['k', 1e3], ['M', 1e6]] as const) {
    if (n / size < 999.5) return `${sig3(n / size)}${unit}`;
  }
  return `${sig3(n / 1e9)}B`;
}

/** "±0.03", or "±<0.01" when the uncertainty is below the displayed precision. */
export function fmtSigma(sigma: number, decimals: number): string {
  const unit = Math.pow(10, -decimals);
  return sigma < unit ? `±<${unit.toFixed(decimals)}` : `±${sigma.toFixed(decimals)}`;
}
