// Reads the official utilization numbers from the same endpoint Claude Code's
// /usage command uses. This endpoint is undocumented and may change.
// Your login token is read locally and sent only to api.anthropic.com.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { Reading } from './estimator';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export interface UsageResponse {
  buckets: Map<string, Reading>;
  raw: unknown;
}

export class UsageError extends Error {
  constructor(message: string, readonly kind: 'no-credentials' | 'expired' | 'auth' | 'rate-limited' | 'network' | 'format', readonly retryAfterMs?: number, readonly raw?: unknown,
    /** Short machine-readable cause for the UI: "ENOTFOUND", "HTTP 429", … */
    readonly code?: string) {
    super(message);
  }
}

export function claudeDir(override?: string, env: Record<string, string | undefined> = process.env): string {
  if (override && override.trim()) return override.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

interface Creds { accessToken: string; expiresAt?: number }

function fromJson(text: string): Creds | null {
  try {
    const j = JSON.parse(text);
    const o = j?.claudeAiOauth ?? j;
    if (typeof o?.accessToken === 'string') return { accessToken: o.accessToken, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined };
  } catch { /* fallthrough */ }
  return null;
}

function keychain(): Promise<Creds | null> {
  return new Promise(resolve => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : fromJson(stdout.trim()));
    });
  });
}

/** Re-read every time: Claude Code refreshes the token in place. */
export async function readCredentials(dir: string): Promise<Creds> {
  const file = path.join(dir, '.credentials.json');
  let creds: Creds | null = null;
  try { creds = fromJson(fs.readFileSync(file, 'utf8')); } catch { /* not there */ }
  if (!creds && process.platform === 'darwin') creds = await keychain();
  if (!creds) throw new UsageError(`No Claude Code login found (looked for ${file}). Sign in to Claude Code first.`, 'no-credentials');
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    throw new UsageError('Claude Code login token has expired. Send any message in Claude Code and it will refresh.', 'expired');
  }
  return creds;
}

/** Any top-level object with a numeric `utilization` is a limit bucket. */
export function parseBuckets(json: any): Map<string, Reading> {
  const out = new Map<string, Reading>();
  if (!json || typeof json !== 'object') return out;
  for (const [k, v] of Object.entries(json)) {
    const u = (v as any)?.utilization;
    if (typeof u === 'number' && isFinite(u)) {
      const r = (v as any)?.resets_at;
      out.set(k, { utilization: u, resetsAt: typeof r === 'string' ? r : null });
    }
  }
  return out;
}

/** The error code behind a failed fetch(): undici puts it on `cause`, sometimes inside an AggregateError. */
export function networkCode(e: any): string | undefined {
  const c = e?.cause;
  const code = c?.code ?? c?.errors?.find((x: any) => x?.code)?.code;
  if (typeof code === 'string' && code) return code;
  if (e?.name === 'TimeoutError' || c?.name === 'TimeoutError') return 'ETIMEDOUT';
  return undefined;
}

/** Retry-After as delta-seconds or an HTTP date; undefined when absent or not in the future. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header?.trim()) return undefined;
  const s = Number(header);
  const ms = isFinite(s) ? s * 1000 : Date.parse(header) - now;
  return isFinite(ms) && ms > 0 ? ms : undefined;
}

export async function fetchUsage(dir: string): Promise<UsageResponse> {
  const creds = await readCredentials(dir);
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': 'tokenomancer/0.2',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: any) {
    const code = networkCode(e);
    const msg = code ? `Can't reach api.anthropic.com (${code})` : `Can't reach api.anthropic.com: ${e?.message ?? e}`;
    throw new UsageError(msg, 'network', undefined, undefined, code);
  }
  const code = `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) {
    throw new UsageError(`Usage endpoint refused the login token (HTTP ${res.status}). Send a message in Claude Code to refresh it.`, 'auth', undefined, undefined, code);
  }
  if (res.status === 429) {
    throw new UsageError('Usage endpoint is rate limiting; backing off.', 'rate-limited', retryAfterMs(res.headers.get('retry-after')), undefined, code);
  }
  if (!res.ok) throw new UsageError(`Usage endpoint returned HTTP ${res.status}.`, 'network', undefined, undefined, code);
  let json: unknown;
  try { json = await res.json(); } catch { throw new UsageError('Usage endpoint returned something other than JSON.', 'format'); }
  const buckets = parseBuckets(json);
  if (!buckets.size) throw new UsageError('Usage response had no limit buckets; the endpoint format may have changed.', 'format', undefined, json);
  return { buckets, raw: json };
}
