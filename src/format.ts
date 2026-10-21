import { Estimate } from './estimator';

export function label(key: string): string {
  if (key === 'five_hour') return '5h';
  if (key === 'seven_day') return 'wk';
  const m = /^seven_day_(.+)$/.exec(key);
  const name = (m ? m[1] : key).replace(/_/g, ' ');
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return m ? `${cap} wk` : cap;
}

export function fmtPct(e: Estimate, decimals: number): string {
  switch (e.kind) {
    case 'official': return `${Math.round(e.official)}%`;
    case 'precise': return `${e.value.toFixed(Math.max(decimals, 1))}%`;
    case 'anchored': return `${e.value.toFixed(decimals)}%`;
    case 'window-start': return `~${e.value.toFixed(decimals)}%`;
    case 'lower-bound': return `≥${e.value.toFixed(decimals)}%`;
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

export function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(+d)) return '—';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export const fmtK = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;

