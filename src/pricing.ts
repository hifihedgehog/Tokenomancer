// Per-model API prices (USD per million tokens), used as weights for
// converting raw token counts into "weighted units" (API-equivalent dollars).
// Source: https://platform.claude.com/docs/en/about-claude/pricing (Oct 2026).
// Only the *ratios* between models and token types matter for the estimator,
// because the dollars-per-1% figure is learned from your own usage.

export interface Price {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

const p = (input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number): Price => ({
  input, output, cacheWrite5m, cacheWrite1h, cacheRead,
});

// Keys are "<family>-<major>-<minor>" or "<family>-<major>".
const TABLE: Record<string, Price> = {
  'fable-5-1': p(10, 50, 12.5, 20, 0.25),
  'mythos-5-1': p(10, 50, 12.5, 20, 0.25),
  'fable-5': p(10, 50, 12.5, 20, 1),
  'mythos-5': p(10, 50, 12.5, 20, 1),
  'opus-5-5': p(4, 20, 5, 8, 0.2),
  'opus-5': p(5, 25, 6.25, 10, 0.5),
  'opus-4-8': p(5, 25, 6.25, 10, 0.5),
  'opus-4-7': p(5, 25, 6.25, 10, 0.5),
  'opus-4-6': p(5, 25, 6.25, 10, 0.5),
  'opus-4-5': p(5, 25, 6.25, 10, 0.5),
  'opus-4-1': p(15, 75, 18.75, 30, 1.5),
  'opus-4': p(15, 75, 18.75, 30, 1.5),
  'sonnet-5-5': p(2, 10, 2.5, 4, 0.1),
  'sonnet-5': p(2, 10, 2.5, 4, 0.2),
  'sonnet-4-6': p(3, 15, 3.75, 6, 0.3),
  'sonnet-4-5': p(3, 15, 3.75, 6, 0.3),
  'sonnet-4': p(3, 15, 3.75, 6, 0.3),
  'haiku-5-5': p(0.1, 0.5, 0.125, 0.2, 0.01),
  'haiku-4-5': p(1, 5, 1.25, 2, 0.1),
  'haiku-3-5': p(0.8, 4, 1, 1.6, 0.08),
};

// Haiku 5.5 charges more when a single prompt exceeds 100k tokens.
const HAIKU_55_LONG = p(0.5, 2.5, 0.625, 1, 0.05);

// Fallback when a model version isn't in the table: newest known price for the family.
const FAMILY_FALLBACK: Record<string, string> = {
  fable: 'fable-5-1',
  mythos: 'mythos-5-1',
  opus: 'opus-5-5',
  sonnet: 'sonnet-5-5',
  haiku: 'haiku-5-5',
};

export type Family = 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku' | 'other';

export interface ModelId {
  family: Family;
  key: string | null; // table key, e.g. "opus-4-5"
}

export function parseModel(model: string): ModelId {
  const m = model.toLowerCase();
  // Old naming: claude-3-5-haiku-20241022
  const old = /claude-(\d)-(\d)-(haiku|sonnet|opus)/.exec(m);
  if (old) {
    return { family: old[3] as Family, key: `${old[3]}-${old[1]}-${old[2]}` };
  }
  const fam = /(fable|mythos|opus|sonnet|haiku)/.exec(m);
  if (!fam) return { family: 'other', key: null };
  const family = fam[1] as Family;
  // Version digits after the family; a 1-2 digit minor counts, a date suffix does not.
  const ver = new RegExp(`${family}-(\\d{1,2})(?:-(\\d{1,2}))?(?=-|$|\\[|@)`).exec(m);
  if (!ver) return { family, key: null };
  const key = ver[2] !== undefined ? `${family}-${ver[1]}-${ver[2]}` : `${family}-${ver[1]}`;
  return { family, key };
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export function priceFor(model: string, usage: TokenUsage, overrides: Record<string, Partial<Price>> = {}): Price | null {
  const lower = model.toLowerCase();
  // User overrides match by substring of the model id, longest match wins.
  const ov = Object.keys(overrides)
    .filter(k => lower.includes(k.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];

  const id = parseModel(model);
  let base: Price | undefined;
  if (id.key && TABLE[id.key]) base = TABLE[id.key];
  else if (id.family !== 'other') base = TABLE[FAMILY_FALLBACK[id.family]];

  if (id.key === 'haiku-5-5' || (!id.key && id.family === 'haiku')) {
    const promptLen = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
    if (promptLen > 100_000) base = HAIKU_55_LONG;
  }

  if (ov) return { ...(base ?? p(0, 0, 0, 0, 0)), ...overrides[ov] } as Price;
  return base ?? null;
}

/** Weighted units = API-equivalent USD for this request. */
export function weightedCost(model: string, usage: TokenUsage, overrides?: Record<string, Partial<Price>>): number {
  const pr = priceFor(model, usage, overrides);
  if (!pr) return 0;
  return (
    usage.input * pr.input +
    usage.output * pr.output +
    usage.cacheWrite5m * pr.cacheWrite5m +
    usage.cacheWrite1h * pr.cacheWrite1h +
    usage.cacheRead * pr.cacheRead
  ) / 1_000_000;
}
