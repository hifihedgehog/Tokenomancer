import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PollerOptions, SharedPoller, SharedReading, backoffMs } from '../poller';
import { UsageError, UsageResponse, fetchUsage, parseBuckets, retryAfterMs } from '../usageApi';

const MIN = 60_000;
// Generous lock staleness: fake clocks run ahead of the real mtimes on disk.
const FAST = { jitterMs: 0, statMs: 50, manualMs: 10_000, waitMs: 1_000, renameRetryMs: 5, lockStaleMs: 3_600_000 };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tk-poll-'));

function clock(start = Date.now()) {
  const c = { t: start, now: () => c.t, tick: (ms: number) => { c.t += ms; } };
  return c;
}

async function waitFor(cond: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; !cond(); await sleep(5)) if (Date.now() > end) throw new Error('timed out');
}

/** A fake endpoint: five_hour climbs by one point per call. */
function api(o: { delay?: number; fail?: () => UsageError | undefined } = {}) {
  const a = {
    calls: 0,
    fetch: async (): Promise<UsageResponse> => {
      a.calls++;
      if (o.delay) await sleep(o.delay);
      const err = o.fail?.();
      if (err) throw err;
      const raw = { five_hour: { utilization: 10 + a.calls, resets_at: '2026-10-22T15:00:00+00:00' }, extra_usage: { utilization: null } };
      return { buckets: parseBuckets(raw), raw };
    },
  };
  return a;
}

type Seen = [SharedReading, boolean][];
function poller(o: Partial<PollerOptions> & Pick<PollerOptions, 'fetch'>, seen?: Seen) {
  const p = new SharedPoller({ pollMs: () => 1000, log: () => {}, timing: FAST, ...o });
  if (seen) p.onReading((r, own) => seen.push([r, own]));
  return p;
}

/** What another window would write, the way it writes it. */
function share(dir: string, r: Partial<SharedReading> & { seq: number; t: number; backoffMs?: number }) {
  const f = { v: 1, ok: true, nextTryAt: r.t + 1000, by: 'other', buckets: { five_hour: { utilization: 40, resets_at: null } },
    pollLog: [{ t: r.t, ok: true }], backoffMs: 0, ...r };
  fs.writeFileSync(path.join(dir, 'w.tmp'), JSON.stringify(f));
  fs.renameSync(path.join(dir, 'w.tmp'), path.join(dir, 'usage.json'));
}

const seqs = (s: Seen) => s.map(([r]) => r.seq);

test('concurrent refreshes share one fetch', async () => {
  const a = api({ delay: 20 }), seen: Seen = [];
  const p = poller({ fetch: a.fetch }, seen), busyWhenDelivered: boolean[] = [];
  p.onReading(() => busyWhenDelivered.push(p.refreshing));
  const first = p.refresh(false);
  assert.equal(p.refresh(true), first);
  assert.equal(p.refreshing, true);
  await first;
  assert.equal(p.refreshing, false);
  assert.deepEqual(busyWhenDelivered, [false], 'a render triggered by the reading no longer says "Refreshing…"');
  assert.equal(a.calls, 1);
  assert.deepEqual(seen.map(([r, own]) => [r.seq, r.ok, own]), [[1, true, true]]);
  assert.deepEqual(seen[0][0].buckets, { five_hour: { utilization: 11, resets_at: '2026-10-22T15:00:00+00:00' } });
});

test('two windows on one folder: one fetch per interval, and both deliver the same seqs', async () => {
  const dir = tmp(), c = clock(), a = api({ delay: 10 });
  const sa: Seen = [], sb: Seen = [];
  const A = poller({ dir, fetch: a.fetch, now: c.now, id: 'A' }, sa);
  const B = poller({ dir, fetch: a.fetch, now: c.now, id: 'B' }, sb);
  for (let i = 0; i < 3; i++) {
    await Promise.all([A.refresh(false), B.refresh(false)]);
    await Promise.all([A.refresh(false), B.refresh(false)]); // the other window picks up the reading
    c.tick(1000);
  }
  assert.equal(a.calls, 3);
  assert.deepEqual(seqs(sa), [1, 2, 3]);
  assert.deepEqual(seqs(sb), [1, 2, 3]);
  assert.deepEqual(sa.map(([r]) => r.t), sb.map(([r]) => r.t));
  sa.forEach(([r, own], i) => {
    assert.notEqual(own, sb[i][1], 'exactly one window fetched each reading');
    assert.equal(r.by, own ? 'A' : 'B');
  });
  assert.equal(A.pollLog.length, 3);
  assert.deepEqual(B.pollLog, A.pollLog);
  assert.equal(fs.existsSync(path.join(dir, 'fetch.lock')), false);
});

test('running windows keep to one fetch per interval between them', async () => {
  const dir = tmp(), a = api(), ms = 120;
  const sa: Seen = [], sb: Seen = [];
  const opts = { dir, fetch: a.fetch, pollMs: () => ms, timing: { ...FAST, jitterMs: 20, lockStaleMs: 30_000 } };
  const A = poller({ ...opts, id: 'A' }, sa), B = poller({ ...opts, id: 'B' }, sb);
  A.start();
  B.start();
  await sleep(ms * 6);
  // Settle: no fetch in flight (dispose drops those) and both windows on the same reading.
  await waitFor(() => !A.refreshing && !B.refreshing && sa.at(-1)?.[0].seq === sb.at(-1)?.[0].seq);
  A.dispose();
  B.dispose();
  const fetched = [...sa, ...sb].filter(([, own]) => own).map(([r]) => r.t).sort((x, y) => x - y);
  assert.equal(fetched.length, a.calls);
  assert.ok(a.calls >= 3 && a.calls <= 8, `fetches: ${a.calls}`);
  for (let i = 1; i < fetched.length; i++) assert.ok(fetched[i] - fetched[i - 1] >= ms - ms / 10, `gap ${fetched[i] - fetched[i - 1]} ms`);
  for (const s of [sa, sb]) s.forEach(([r], i) => i && assert.ok(r.seq > s[i - 1][0].seq, 'each seq once, in order'));
});

test('a fresh lock is respected, a stale one is taken over, and only our own lock is removed', async () => {
  const dir = tmp(), c = clock(), lock = path.join(dir, 'fetch.lock');
  const a = api({ delay: 30 });
  const p = poller({ dir, fetch: a.fetch, now: c.now, id: 'P', timing: { ...FAST, lockStaleMs: 30_000 } });
  fs.writeFileSync(lock, JSON.stringify({ id: 'other' }));
  await p.refresh(false);
  assert.equal(a.calls, 0, 'another window is fetching');

  const old = (c.t - 60_000) / 1000;
  fs.utimesSync(lock, old, old);
  await p.refresh(false);
  assert.equal(a.calls, 1);
  assert.equal(fs.existsSync(lock), false, 'released after the fetch');

  // If our lock is taken over mid-fetch (a sleeping laptop), the new owner's lock stays.
  c.tick(1000);
  const run = p.refresh(false);
  await waitFor(() => a.calls === 2);
  fs.writeFileSync(lock, JSON.stringify({ id: 'other' }));
  await run;
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).id, 'other');
});

test('after taking the lock a window re-reads usage.json, since another may have just written it', async () => {
  const dir = tmp(), c = clock(), a = api(), seen: Seen = [];
  const node: typeof fs = require('fs');
  const write = node.writeFileSync;
  node.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: any[]) => {
    // The other window finishes between our first read and our lock.
    if (String(file).endsWith('fetch.lock') && !fs.existsSync(path.join(dir, 'usage.json'))) share(dir, { seq: 1, t: c.t });
    return (write as any)(file, ...rest);
  }) as typeof write;
  try {
    await poller({ dir, fetch: a.fetch, now: c.now }, seen).refresh(false);
  } finally {
    node.writeFileSync = write;
  }
  assert.equal(a.calls, 0);
  assert.deepEqual(seen.map(([r, own]) => [r.by, own]), [['other', false]]);
});

test('a reading requested later by another window is never overwritten by an older one', async () => {
  const dir = tmp(), c = clock(), seen: Seen = [];
  const fetch = async (): Promise<UsageResponse> => {
    share(dir, { seq: 5, t: c.t + 1 }); // our lock went stale (a sleeping laptop) and another window fetched
    return api().fetch();
  };
  await poller({ dir, fetch, now: c.now }, seen).refresh(false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')).seq, 5);
  assert.deepEqual(seen.map(([r, own]) => [r.seq, own]), [[5, false]]);
});

test('a window that is backing off follows the schedule of a newer shared reading', async () => {
  const now = Date.now(), dir = tmp(), a = api();
  share(dir, { seq: 1, t: now, ok: false, error: { kind: 'network', message: 'down' }, nextTryAt: now + 5 * MIN, backoffMs: 5 * MIN });
  const p = poller({ dir, fetch: a.fetch, pollMs: () => 100 });
  p.start();
  share(dir, { seq: 2, t: Date.now() }); // another window got through
  await waitFor(() => a.calls === 1, 1000);
  p.dispose();
});

test('a manual refresh waits for the window that is already fetching', async () => {
  const dir = tmp(), c = clock(), a = api(), lock = path.join(dir, 'fetch.lock'), seen: Seen = [];
  const p = poller({ dir, fetch: a.fetch, now: c.now }, seen);
  fs.writeFileSync(lock, JSON.stringify({ id: 'other' }));
  const run = p.refresh(true);
  await sleep(120);
  share(dir, { seq: 1, t: c.t });
  fs.unlinkSync(lock);
  await run;
  assert.equal(a.calls, 0);
  assert.deepEqual(seen.map(([r, own]) => [r.seq, r.by, own]), [[1, 'other', false]]);
});

test('backoff: 429 doubles from twice the interval even with retry-after 0; network errors from the interval', () => {
  const poll = MIN, walk = (kind: 'rate-limited' | 'network', n: number, retry?: number) => {
    const out: number[] = [];
    for (let prev = 0; out.length < n; out.push(prev)) prev = backoffMs(kind, poll, prev, retry);
    return out.map(ms => ms / MIN);
  };
  assert.deepEqual(walk('rate-limited', 6, 0), [2, 4, 8, 10, 10, 10]);
  assert.deepEqual(walk('rate-limited', 2), [2, 4]);
  assert.equal(backoffMs('rate-limited', poll, 0, 20 * MIN), 20 * MIN);
  assert.equal(backoffMs('rate-limited', poll, 0, 3 * 3600_000), 30 * MIN, 'capped at 30 min');
  assert.deepEqual(walk('network', 5), [1, 2, 4, 5, 5]);
  for (const k of ['auth', 'expired', 'no-credentials'] as const) assert.equal(backoffMs(k, poll, 8 * MIN), 0);
});

test('a 429 backs off every window, manual refreshes included, and keeps the last good time', async () => {
  const dir = tmp(), c = clock(), poll = 10_000;
  let limited = false;
  const a = api({ fail: () => limited ? new UsageError('Usage endpoint is rate limiting; backing off.', 'rate-limited', undefined, undefined, 'HTTP 429') : undefined });
  const A = poller({ dir, fetch: a.fetch, now: c.now, pollMs: () => poll, id: 'A' });
  const B = poller({ dir, fetch: a.fetch, now: c.now, pollMs: () => poll, id: 'B' });
  await A.refresh(false);
  const okAt = c.t;
  limited = true;
  c.tick(poll);
  await A.refresh(false);
  let r = A.last!;
  assert.deepEqual([r.ok, r.error?.kind, r.error?.code, r.lastOkAt], [false, 'rate-limited', 'HTTP 429', okAt]);
  assert.equal(r.nextTryAt - c.t, 2 * poll);

  c.tick(poll + 2000); // past the interval and the manual throttle, inside the backoff
  await Promise.all([A.refresh(true), B.refresh(false), B.refresh(true)]);
  assert.equal(a.calls, 2);
  assert.equal(B.last?.seq, 2, 'B applied the shared failure');

  c.tick(poll);
  await B.refresh(false);
  assert.equal(a.calls, 3);
  r = B.last!;
  assert.equal(r.nextTryAt - c.t, 4 * poll, 'doubled from the shared backoff');
  assert.equal(r.lastOkAt, okAt);

  limited = false;
  c.tick(4 * poll);
  await A.refresh(false);
  r = A.last!;
  assert.deepEqual([r.ok, r.error, r.lastOkAt, r.nextTryAt], [true, undefined, c.t, c.t + poll]);
});

test('manual refreshes are throttled to one per 10 s', async () => {
  const c = clock(), a = api(), seen: Seen = [];
  const p = poller({ fetch: a.fetch, now: c.now }, seen);
  await p.refresh(true);
  c.tick(4000);
  await p.refresh(true);
  assert.equal(a.calls, 1);
  assert.equal(seen.length, 1, 'a throttled refresh never delivers a reading twice');
  c.tick(6000);
  await p.refresh(true);
  assert.equal(a.calls, 2);
});

test('writes go through a temp file and a rename, retried while Windows holds the file', async () => {
  const dir = tmp(), c = clock(), a = api(), renames: string[] = [];
  const rename = fs.promises.rename;
  let busy = 2;
  fs.promises.rename = (async (from: fs.PathLike, to: fs.PathLike) => {
    renames.push(`${path.basename(String(from))}→${path.basename(String(to))}`);
    if (busy-- > 0) throw Object.assign(new Error('in use'), { code: 'EPERM' });
    return rename(from, to);
  }) as typeof rename;
  try {
    await poller({ dir, fetch: a.fetch, now: c.now }).refresh(false);
  } finally {
    fs.promises.rename = rename;
  }
  assert.deepEqual(renames, Array(3).fill('usage.json.tmp→usage.json'));
  assert.deepEqual(fs.readdirSync(dir), ['usage.json']);
  const f = JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
  assert.deepEqual([f.v, f.seq, f.ok, f.t, f.nextTryAt, f.backoffMs], [1, 1, true, c.t, c.t + 1000, 0]);
  assert.deepEqual(Object.keys(f.buckets), ['five_hour'], 'only keys with a numeric utilization');
  assert.deepEqual(f.raw.extra_usage, { utilization: null }, 'raw is the response verbatim');
  assert.deepEqual(f.pollLog, [{ t: c.t, ok: true }]);
});

test('without a usable folder the window polls on its own', async () => {
  const c = clock(), a = api(), seen: Seen = [];
  const p = poller({ fetch: a.fetch, now: c.now }, seen);
  assert.equal(p.solo, true);
  await p.refresh(false);
  await p.refresh(false);
  c.tick(1000);
  await p.refresh(false);
  assert.deepEqual(seen.map(([r, own]) => [r.seq, own]), [[1, true], [2, true]]);
  assert.equal(p.pollLog.length, 2);

  const file = path.join(tmp(), 'file');
  fs.writeFileSync(file, '');
  const levels: string[] = [];
  const q = poller({ dir: path.join(file, 'shared'), fetch: a.fetch, log: l => levels.push(l) });
  assert.equal(q.solo, true);
  assert.deepEqual(levels, ['warn']);
});

test('a new window delivers the shared reading at once, unless it is over 8 days old', () => {
  const now = Date.now(), never = async (): Promise<UsageResponse> => new Promise(() => {});
  const dir = tmp(), seen: Seen = [];
  share(dir, { seq: 7, t: now - MIN, lastOkAt: now - MIN });
  const p = poller({ dir, fetch: never, pollMs: () => 10 * MIN }, seen);
  p.start();
  assert.deepEqual(seen.map(([r, own]) => [r.seq, own]), [[7, false]]);
  assert.equal(p.last?.seq, 7);
  assert.deepEqual(p.pollLog, [{ t: now - MIN, ok: true }]);
  assert.equal('pollLog' in p.last!, false, 'readings carry no shared bookkeeping');
  p.dispose();

  const old = tmp(), none: Seen = [];
  share(old, { seq: 3, t: now - 9 * 24 * 60 * MIN });
  const q = poller({ dir: old, fetch: never }, none);
  q.start();
  assert.deepEqual(none, []);
  q.dispose();
});

test('watching windows deliver each new seq once and never an older reading', async () => {
  const now = Date.now(), dir = tmp(), seen: Seen = [];
  const fetch = async (): Promise<UsageResponse> => assert.fail('a fresh shared reading must not be fetched again');
  share(dir, { seq: 1, t: now });
  const p = poller({ dir, fetch, pollMs: () => 10 * MIN }, seen);
  p.start();
  share(dir, { seq: 2, t: now + 1 });
  await waitFor(() => seen.length === 2);
  share(dir, { seq: 2, t: now + 1 });
  share(dir, { seq: 3, t: now - 5000 }); // a reading requested before the one we have
  share(dir, { seq: 4, t: now + 2 });
  await waitFor(() => seen.at(-1)![0].seq === 4);
  await sleep(80);
  assert.deepEqual(seqs(seen), [1, 2, 4]);
  p.dispose();
});

test('without fs.watch the stat fallback still delivers', async () => {
  const now = Date.now(), dir = tmp(), seen: Seen = [];
  const node: typeof fs = require('fs'); // the module object itself; the import is a read-only view
  const watch = node.watch;
  node.watch = (() => { throw Object.assign(new Error('no watchers left'), { code: 'ENOSPC' }); }) as unknown as typeof fs.watch;
  let p: SharedPoller;
  try {
    p = poller({ dir, fetch: api().fetch, pollMs: () => 10 * MIN }, seen);
    share(dir, { seq: 1, t: now });
    p.start();
  } finally {
    node.watch = watch;
  }
  share(dir, { seq: 2, t: now + 1, ok: false, error: { kind: 'network', message: "Can't reach api.anthropic.com (ENOTFOUND)", code: 'ENOTFOUND' } });
  await waitFor(() => seen.length === 2);
  assert.deepEqual(seen[1][0].error?.code, 'ENOTFOUND');
  p.dispose();
});

test('dispose stops the loop and releases a held lock', async () => {
  const dir = tmp(), a = api({ delay: 50 }), seen: Seen = [];
  const p = poller({ dir, fetch: a.fetch }, seen);
  p.start();
  await waitFor(() => a.calls === 1);
  assert.equal(fs.existsSync(path.join(dir, 'fetch.lock')), true);
  p.dispose();
  assert.equal(fs.existsSync(path.join(dir, 'fetch.lock')), false);
  await sleep(80);
  assert.deepEqual(seen, [], 'a fetch finishing after dispose is dropped');
});

test('setting the clock back does not stall polling or delivery', async () => {
  const dir = tmp(), c = clock(), a = api(), seen: Seen = [];
  const p = poller({ dir, fetch: a.fetch, now: c.now }, seen);
  await p.refresh(true);
  c.tick(-2 * 3600_000);
  await p.refresh(true);
  assert.equal(a.calls, 2, 'the manual refresh after the jump was not throttled by the old time');
  await p.refresh(false);
  assert.equal(a.calls, 2);
  assert.deepEqual(seqs(seen), [1, 2]);
  share(dir, { seq: 9, t: c.t + 3600_000 }); // another window with a wrong clock
  await p.refresh(false);
  assert.deepEqual(seqs(seen), [1, 2]);
  fs.unlinkSync(path.join(dir, 'usage.json'));
  c.tick(1000);
  await p.refresh(false);
  assert.equal(p.last?.seq, 10, 'seq keeps rising when usage.json is lost');
});

test('endpoint failures carry a short code and a plain message', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } }));
  const real = globalThis.fetch;
  let reply: () => Promise<Response>;
  let headers: Record<string, string> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { headers = init?.headers as Record<string, string>; return reply(); }) as typeof fetch;
  const fail = async () => {
    try { await fetchUsage(dir); } catch (e) { const u = e as UsageError; return [u.kind, u.code, u.message, u.retryAfterMs]; }
    return assert.fail('expected an error');
  };
  try {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' });
    reply = () => Promise.reject(new TypeError('fetch failed', { cause }));
    assert.deepEqual(await fail(), ['network', 'ENOTFOUND', "Can't reach api.anthropic.com (ENOTFOUND)", undefined]);
    reply = () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    assert.deepEqual((await fail()).slice(0, 2), ['network', 'ETIMEDOUT']);
    reply = async () => new Response('', { status: 429, headers: { 'retry-after': '0' } });
    assert.deepEqual(await fail(), ['rate-limited', 'HTTP 429', 'Usage endpoint is rate limiting; backing off.', undefined]);
    reply = async () => new Response('', { status: 429, headers: { 'retry-after': '120' } });
    assert.equal((await fail())[3], 120_000);
    reply = async () => new Response('', { status: 401 });
    assert.deepEqual((await fail()).slice(0, 2), ['auth', 'HTTP 401']);
    reply = async () => new Response('', { status: 503 });
    assert.deepEqual((await fail()).slice(0, 3), ['network', 'HTTP 503', 'Usage endpoint returned HTTP 503.']);
    reply = async () => new Response(JSON.stringify({ five_hour: { utilization: 16, resets_at: null } }), { status: 200 });
    const ok = await fetchUsage(dir);
    assert.deepEqual([...ok.buckets], [['five_hour', { utilization: 16, resetsAt: null }]]);
    assert.equal(headers['User-Agent'], 'tokenomancer/0.2');
  } finally {
    globalThis.fetch = real;
  }
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.deepEqual([null, '', '0', '-3', '7', 'Thu, 22 Oct 2026 12:01:00 GMT', 'soon'].map(h => retryAfterMs(h, now)), [undefined, undefined, undefined, undefined, 7000, 60_000, undefined]);
});
