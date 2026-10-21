// Reads Claude Code's transcript logs (~/.claude/projects/**/*.jsonl)
// incrementally and turns assistant responses into usage events.

import * as fs from 'fs';
import * as path from 'path';
import { Family, Price, TokenUsage, parseModel, weightedCost } from './pricing';

export interface UsageEvent {
  t: number; // epoch ms
  model: string;
  family: Family;
  wu: number; // weighted units (API-equivalent USD) added by this event
  tokens: TokenUsage; // tokens added by this event
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

export function extractUsage(u: any): TokenUsage {
  const cc = u?.cache_creation;
  let w5 = num(cc?.ephemeral_5m_input_tokens);
  let w1 = num(cc?.ephemeral_1h_input_tokens);
  const total = num(u?.cache_creation_input_tokens);
  if (w5 + w1 === 0) w5 = total; // no breakdown: assume 5-minute writes
  return {
    input: num(u?.input_tokens),
    output: num(u?.output_tokens),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    cacheRead: num(u?.cache_read_input_tokens),
  };
}

function subtract(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheWrite5m: Math.max(0, a.cacheWrite5m - b.cacheWrite5m),
    cacheWrite1h: Math.max(0, a.cacheWrite1h - b.cacheWrite1h),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  };
}

function maxUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
  };
}

/**
 * Turns JSONL lines into events, de-duplicating across files.
 * The same API response can appear several times: once per content block
 * while streaming (with growing output counts), and again when a session is
 * resumed or forked into a new file. We key on message.id + requestId and
 * only count the increase over what was already seen.
 */
export class EventParser {
  private seen = new Map<string, { usage: TokenUsage; t: number }>();

  constructor(private overrides: () => Record<string, Partial<Price>> = () => ({})) {}

  parseLine(line: string): UsageEvent | null {
    if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
    let obj: any;
    try { obj = JSON.parse(line); } catch { return null; }
    if (obj?.type !== 'assistant') return null;
    const msg = obj.message;
    const usage = msg?.usage;
    const model: string = msg?.model;
    if (!usage || typeof model !== 'string' || model.startsWith('<')) return null; // skip <synthetic>
    const t = Date.parse(obj.timestamp);
    if (!isFinite(t)) return null;

    const tokens = extractUsage(usage);
    const id = msg.id ?? obj.uuid;
    const key = `${id}:${obj.requestId ?? ''}`;
    const prev = this.seen.get(key);
    const prevUsage = prev?.usage ?? ZERO;
    const delta = subtract(tokens, prevUsage);
    this.seen.set(key, { usage: maxUsage(tokens, prevUsage), t: prev?.t ?? t });

    const ov = this.overrides();
    const wu = weightedCost(model, delta, ov);
    const any = delta.input + delta.output + delta.cacheRead + delta.cacheWrite5m + delta.cacheWrite1h;
    if (any === 0) return null;
    return { t, model, family: parseModel(model).family, wu, tokens: delta };
  }

  prune(before: number) {
    for (const [k, v] of this.seen) if (v.t < before) this.seen.delete(k);
  }
}

interface FileCursor { offset: number; mtimeMs: number }

/** Walks the projects folder and reads only bytes appended since the last scan. */
export class LogTailer {
  private cursors = new Map<string, FileCursor>();
  readonly parser: EventParser;

  constructor(private projectsDir: () => string, private horizonMs: number, overrides?: () => Record<string, Partial<Price>>) {
    this.parser = new EventParser(overrides);
  }

  private listFiles(dir: string, out: string[], depth = 0) {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) this.listFiles(full, out, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }

  /** Returns new events since the previous call. */
  scan(now = Date.now()): UsageEvent[] {
    const files: string[] = [];
    this.listFiles(this.projectsDir(), files);
    const events: UsageEvent[] = [];
    const cutoff = now - this.horizonMs;

    for (const file of files) {
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { continue; }
      let cur = this.cursors.get(file);
      if (!cur) {
        if (st.mtimeMs < cutoff) { // too old to matter; remember it so we skip cheaply
          this.cursors.set(file, { offset: st.size, mtimeMs: st.mtimeMs });
          continue;
        }
        cur = { offset: 0, mtimeMs: 0 };
        this.cursors.set(file, cur);
      }
      if (st.size < cur.offset) { cur.offset = 0; } // truncated or replaced
      if (st.size === cur.offset) { cur.mtimeMs = st.mtimeMs; continue; }

      let buf: Buffer;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const len = st.size - cur.offset;
          buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, cur.offset);
        } finally { fs.closeSync(fd); }
      } catch { continue; }

      // Only consume complete lines; a half-written last line is re-read next time.
      // Splitting on the newline byte (not after decoding) keeps multi-byte characters intact.
      const lastNl = buf.lastIndexOf(0x0a);
      cur.mtimeMs = st.mtimeMs;
      if (lastNl < 0) continue;
      cur.offset += lastNl + 1;
      const lines = buf.subarray(0, lastNl).toString('utf8').split('\n');
      for (const line of lines) {
        const ev = this.parser.parseLine(line.trim());
        if (ev && ev.t >= cutoff) events.push(ev);
      }
    }
    this.parser.prune(cutoff);
    return events;
  }
}
