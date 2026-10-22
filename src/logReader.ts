// Reads Claude Code's transcript logs (~/.claude/projects/**/*.jsonl)
// incrementally and turns assistant responses into usage events.

import * as fs from 'fs';
import * as path from 'path';
import { Family, Price, TokenUsage, costParts, parseModel } from './pricing';

export interface UsageEvent {
  t: number; // epoch ms
  model: string;
  family: Family;
  wu: number; // weighted units (API-equivalent USD) added by this event
  parts: [number, number, number]; // wu split: [fresh input + cache writes, output, cache reads]
  tokens: TokenUsage; // tokens added by this event
  first?: boolean; // the request's first event (later ones are its streamed or resumed lines); absent = unknown
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
  private seen = new Map<string, { usage: TokenUsage; t: number; counted: boolean }>();

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
    const any = delta.input + delta.output + delta.cacheRead + delta.cacheWrite5m + delta.cacheWrite1h;
    // A request counts once, on its first line that adds anything (a leading all-zero line doesn't).
    const first = !prev?.counted;
    this.seen.set(key, { usage: maxUsage(tokens, prevUsage), t: prev?.t ?? t, counted: !first || any > 0 });
    if (any === 0) return null;

    const ov = this.overrides();
    const parts = costParts(model, delta, ov);
    const wu = parts[0] + parts[1] + parts[2];
    return { t, model, family: parseModel(model).family, wu, parts, tokens: delta, first };
  }

  prune(before: number) {
    for (const [k, v] of this.seen) if (v.t < before) this.seen.delete(k);
  }
}

interface FileCursor { offset: number; mtimeMs: number; skip?: boolean } // skip: discarding an over-long line to its end

export interface TailOptions {
  chunkBytes?: number;    // read size (default 4 MB); a longer line grows the read until its newline
  maxLineBytes?: number;  // longer lines are skipped unparsed (default 64 MB; base64 screenshots get big)
  log?: (msg: string) => void;
}

// Every usage line carries this key; lines without it (tool results, screenshots) are never decoded.
const USAGE = Buffer.from('"usage"');

/** Walks the projects folder and reads only bytes appended since the last scan. */
export class LogTailer {
  private cursors = new Map<string, FileCursor>();
  private failing = new Set<string>(); // files whose last read failed, so each failure is logged once
  readonly parser: EventParser;
  private readonly chunkBytes: number;
  private readonly maxLineBytes: number;

  constructor(private projectsDir: () => string, private horizonMs: number, overrides?: () => Record<string, Partial<Price>>,
    private readonly opts: TailOptions = {}) {
    this.parser = new EventParser(overrides);
    this.chunkBytes = Math.max(64, opts.chunkBytes ?? 4 << 20);
    this.maxLineBytes = Math.max(this.chunkBytes, opts.maxLineBytes ?? 64 << 20);
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

  /** Returns new events since the previous call. A file that can't be read never costs another file's events. */
  scan(now = Date.now()): UsageEvent[] {
    const files: string[] = [];
    this.listFiles(this.projectsDir(), files);
    const events: UsageEvent[] = [];
    const cutoff = now - this.horizonMs;

    for (const file of files) {
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { continue; } // gone since the listing
      try {
        this.scanFile(file, st, cutoff, events);
        this.failing.delete(file);
      } catch (e: any) {
        // The cursor stays after the last parsed chunk, so the rest is retried on the next scan.
        if (!this.failing.has(file)) this.opts.log?.(`Couldn't read ${file}: ${e?.message ?? e}`);
        this.failing.add(file);
      }
    }
    this.parser.prune(cutoff);
    return events;
  }

  private scanFile(file: string, st: fs.Stats, cutoff: number, out: UsageEvent[]) {
    let cur = this.cursors.get(file);
    if (!cur) {
      if (st.mtimeMs < cutoff) { // too old to matter; remember it so we skip cheaply
        this.cursors.set(file, { offset: st.size, mtimeMs: st.mtimeMs });
        return;
      }
      cur = { offset: 0, mtimeMs: 0 };
      this.cursors.set(file, cur);
    }
    if (st.size < cur.offset) { cur.offset = 0; cur.skip = false; } // truncated or replaced
    cur.mtimeMs = st.mtimeMs;
    if (st.size === cur.offset) return;
    const fd = fs.openSync(file, 'r');
    try { this.readLines(fd, file, cur, st.size, cutoff, out); } finally { fs.closeSync(fd); }
  }

  /**
   * Parses the complete lines between the cursor and `size` a chunk at a time, moving the cursor
   * only past what was parsed. A half-written last line is left for the next scan. Splitting on
   * the newline byte (not after decoding) keeps multi-byte characters intact.
   */
  private readLines(fd: number, file: string, cur: FileCursor, size: number, cutoff: number, out: UsageEvent[]) {
    let want = this.chunkBytes;
    while (cur.offset < size) {
      const len = Math.min(want, size - cur.offset);
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, cur.offset);
      if (n <= 0) return;
      const chunk = n < len ? buf.subarray(0, n) : buf;
      if (cur.skip) {
        const nl = chunk.indexOf(0x0a);
        cur.offset += nl < 0 ? n : nl + 1;
        if (nl >= 0) cur.skip = false;
        continue;
      }
      const nl = chunk.lastIndexOf(0x0a);
      if (nl >= 0) {
        this.parseChunk(chunk, nl, cutoff, out);
        cur.offset += nl + 1;
        want = this.chunkBytes;
      } else if (cur.offset + n >= size) {
        return;
      } else if (n >= this.maxLineBytes) {
        this.opts.log?.(`Skipped a log line over ${Math.round(this.maxLineBytes / 1048576)} MB in ${file}.`);
        cur.offset += n;
        cur.skip = true;
      } else {
        want = Math.min(this.maxLineBytes, want * 2); // one line is longer than the chunk: read more of it at once
      }
    }
  }

  /** Parses the lines in buf[0, end) that mention "usage", jumping straight from one to the next. */
  private parseChunk(buf: Buffer, end: number, cutoff: number, out: UsageEvent[]) {
    for (let h = buf.indexOf(USAGE); h >= 0 && h < end;) {
      const ls = buf.lastIndexOf(0x0a, h) + 1;
      const le = buf.indexOf(0x0a, h);
      const ev = this.parser.parseLine(buf.toString('utf8', ls, le).trim());
      if (ev && ev.t >= cutoff) out.push(ev);
      h = buf.indexOf(USAGE, le + 1);
    }
  }
}
