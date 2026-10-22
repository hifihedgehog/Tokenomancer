// When to raise a run-out (or limit) notification (§5.12): only when it changes what
// the user does next. Once per window per kind; the wrapper (alerts.ts) also
// dedupes across windows and restarts with a `<id>.fired` file. Pure: no vscode, no Node.

import { runOutClock } from './present';
import { clock, span } from './time';
import type { BucketVM, ViewModel } from './types';

const MIN = 60_000;
const SETTLE_MS = 2 * MIN;                // nothing in the first two minutes after activation
const CONFIDENT = new Set(['pinned', 'exact', 'counted']);

export interface AlertOptions { mode: 'runOut' | 'runOutAndLimit' | 'off'; leadMinutes: number; focused: boolean; activatedAt: number }
export interface Alert { id: string /* key@windowStart:kind */; message: string; key: string }

/** "28 min" in prose; longer spans as the compact "1h 12m", "1d 19h". */
const prose = (ms: number) => (ms < 59.5 * MIN ? `${Math.max(1, Math.round(ms / MIN))} min` : span(ms));

/** "5-hour", "weekly", "Fable weekly". */
const nameOf = (b: BucketVM) => b.spokenLabel.replace('five-hour', '5-hour');

/** The window's identity, to the minute, so every VS Code window derives the same id. */
function windowId(b: BucketVM): string {
  const ws = b.windowStart ?? (b.resetsAt !== undefined && b.windowMs ? b.resetsAt - b.windowMs : undefined);
  return ws === undefined ? 'unknown' : String(Math.round(ws / MIN) * MIN);
}

function runOutMessage(b: BucketVM, now: number, vm: ViewModel): string {
  const mid = runOutClock(b.key, b.pace!.runOut!.mid);
  const R = b.resetsAt!;
  const at = (t: number) => clock(t, now, vm.fmt);
  const how = b.key.startsWith('seven_day') ? 'at your average pace this week' : 'at this pace';
  const before = R - mid < 5 * MIN ? `around when it resets at ${at(R)}` : `${prose(R - mid)} before it resets at ${at(R)}`;
  return `Claude ${nameOf(b)} limit: ${how} you'll reach 100% around ${at(mid)} (in ${prose(mid - now)}), ${before}.`;
}

function limitMessage(b: BucketVM, now: number, vm: ViewModel): string {
  const R = b.resetsAt;
  const when = R !== undefined && R > now ? ` It resets at ${clock(R, now, vm.fmt)} (in ${prose(R - now)}).` : '';
  return `Claude ${nameOf(b)} limit reached.${when}`;
}

/**
 * The dedupe file for an alert id. Ids hold ':' and endpoint keys, neither safe in a Windows file
 * name, so anything outside a small set becomes '_' (distinct ids for every real key).
 */
export const firedFileName = (id: string) => `${id.replace(/[^A-Za-z0-9_@.-]/g, '_')}.fired`;

export class AlertPolicy {
  private fired = new Set<string>();
  private rearmed: string[] = [];

  /** The alerts to show now. Call on every render; an alert held back while unfocused shows on focus if still due. */
  decide(vm: ViewModel, o: AlertOptions): Alert[] {
    const now = vm.now;
    const due: Alert[] = [];
    for (const b of vm.buckets) {
      const win = `${b.key}@${windowId(b)}`, run = `${win}:runOut`;
      for (const id of this.fired) if (id.startsWith(`${b.key}@`) && !id.startsWith(`${win}:`)) this.fired.delete(id);   // a past window
      // Re-arm once a live pace no longer says "runs out" (its exit hysteresis: the middle estimate is
      // 15 min past the reset). A withheld pace (stale, loose) re-arms nothing, so a glitch can't re-fire.
      if (this.fired.has(run) && b.pace && b.verdict !== 'runsOut') { this.fired.delete(run); this.rearmed.push(run); }
      const r = b.pace?.runOut;
      if (b.verdict === 'runsOut' && r && b.resetsAt !== undefined && r.mid - now <= o.leadMinutes * MIN
        && b.value >= 60 && CONFIDENT.has(b.state) && !vm.fresh.stale) {
        due.push({ id: run, key: b.key, message: runOutMessage(b, now, vm) });
      }
      if (o.mode === 'runOutAndLimit' && b.state === 'limit') {
        due.push({ id: `${b.key}@${windowId(b)}:limit`, key: b.key, message: limitMessage(b, now, vm) });
      }
    }
    if (o.mode === 'off' || vm.sample || now - o.activatedAt < SETTLE_MS || !o.focused) return [];
    const out = due.filter(a => !this.fired.has(a.id));
    for (const a of out) this.fired.add(a.id);
    return out;
  }

  /** Ids that may fire again since the last call: alerts.ts deletes their `.fired` files. */
  takeRearmed(): string[] {
    const ids = this.rearmed;
    this.rearmed = [];
    return ids;
  }
}
