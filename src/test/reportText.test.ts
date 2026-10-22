import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportInput, mdCode, redact, reportMarkdown } from '../ui/reportText';
import { HOUR, LOCAL, MIN, NOW, build, demoBuckets, edgeBuckets } from './nativeFixtures';
import type { BucketInput, ViewModel } from '../ui/types';

const e = edgeBuckets();
const SECRETS = ['sk-ant-oat01-SECRET', 'eyJhbGciOiJIUzI1NiJ9.SECRET', 'ya29.SECRETSECRETSECRETSECRETSECRETSECRET0123'];

function input(vm: ViewModel, buckets: BucketInput[], o: Partial<ReportInput> = {}): ReportInput {
  return {
    vm, events: 1234, oldestEvent: NOW - 50 * HOUR, logDir: '/home/me/.claude/projects', pollMs: 60_000, role: 'fetcher', version: '0.2.0',
    pollLog: [{ t: NOW - 30 * MIN, ok: false }, { t: NOW - 20 * MIN, ok: true }, { t: NOW - 2 * HOUR, ok: false }],
    buckets: buckets.map(b => ({ key: b.key, estimate: b.estimate, samples: b.estimate.samples, wuPerPct: b.estimate.wuPerPct, corrections: b.corrections, raw: b.raw })),
    ...o,
  };
}

test('the raw response never carries credentials, wherever they are planted', () => {
  const raw = {
    five_hour: { utilization: 44, resets_at: '2026-10-22T14:06:00Z' },
    seven_day_oauth_apps: { utilization: 3, resets_at: null },
    accessToken: SECRETS[0], refresh_token: 'plain', Authorization: `Bearer ${SECRETS[1]}`, apiKey: 'k', api_key: 'k',
    nested: { deeper: [{ session_secret: 'x', note: SECRETS[1] }, SECRETS[2]], cookie: 'c', password: 'p' },
  };
  const vm = build([e.pinned5]);
  const md = reportMarkdown(input(vm, [e.pinned5], { raw }));
  for (const s of [...SECRETS, 'accessToken', 'refresh_token', 'Authorization', 'Bearer', 'session_secret', 'apiKey', 'api_key', 'cookie', 'password']) {
    assert.ok(!md.includes(s), s);
  }
  assert.ok(md.includes('"seven_day_oauth_apps"'), 'a limit named like a secret is still a limit');
  assert.ok(md.includes('- Keys returned: `five_hour`, `seven_day_oauth_apps`, `nested`'));
  assert.deepEqual(redact({ a: [1, 'x', null, { token: 1 }] }), { a: [1, 'x', null, {}] });
});

test('the sample report has every section at diagnostic precision', async () => {
  const { buckets, raw } = await demoBuckets();
  const vm = build(buckets);
  const md = reportMarkdown(input(vm, buckets, { raw }));
  for (const h of ['# Tokenomancer report — Thu, 22 Oct 2026, 13:12', '## Limits', '## Pace and projection', '## Calibration', '## This computer', '## Endpoint', '## Logs']) {
    assert.ok(md.includes(h), h);
  }
  assert.match(md, /\| 5-hour \| \d+\.\d{3}% \| \d\.\d{3} \| pinned \| \d+\.\d{3}–\d+\.\d{3} \|/);
  assert.ok(md.includes('Tokenomancer 0.2.0 · official numbers read just now · every 60 s'));
  assert.ok(md.includes('- Errors in the last hour: 1 of 2 polls · polling every 60 s'));
  assert.ok(md.includes('Events in memory: 1,234 (oldest Tue 20 Oct, 11:12) · folder: `/home/me/.claude/projects`'));
  assert.ok(md.includes('```json\n{'));
  // Three pinned limits share one explanation line.
  assert.equal(md.match(/Pinned between two official ticks/g)?.length, 1);
  assert.match(md, /\| Fable cache reads \| ×\d\.\d\d \| ([+−]\d+%|in line) \|/);
});

test('sample data, stale readings and errors are stated plainly', () => {
  const vm = build([e.pinnedWk], { sample: true, fresh: { lastOkAt: NOW - 20 * MIN, error: { kind: 'rate-limited', message: '', code: 'HTTP 429' }, nextTryAt: NOW + 5 * MIN } });
  const md = reportMarkdown(input(vm, [e.pinnedWk], { role: 'shared' }));
  assert.ok(md.includes('> Sample data, not your account.'));
  assert.ok(md.includes('sample data: yes'));
  assert.ok(md.includes('**Last known** — official numbers not updated for 20 minutes'));
  assert.ok(md.includes('Anthropic is rate-limiting the usage endpoint (HTTP 429).'));
  assert.ok(md.includes('- Backoff: next try 13:17 (in 5m)'));
  assert.ok(md.includes('- Role: another VS Code window reads the endpoint and shares it'));
});

test('with no limits yet: this computer, the endpoint and the logs', () => {
  const vm = build([], { local: { ...LOCAL, requests: 0, byFamily: [] }, fresh: { lastOkAt: undefined, error: { kind: 'no-credentials', message: '' } } });
  const md = reportMarkdown(input(vm, [], { role: 'solo' }));
  assert.ok(!md.includes('## Limits') && md.includes('## This computer') && md.includes('## Endpoint'));
  assert.ok(md.includes('- Keys returned: none yet'));
  assert.ok(md.includes('- Last success: none this session'));
});

test('paths and cells survive backticks and pipes', () => {
  assert.equal(mdCode('C:\\Users\\me\\.claude'), '`C:\\Users\\me\\.claude`');
  assert.equal(mdCode('a`b'), '``a`b``');
  assert.equal(mdCode('`x'), '`` `x ``');
  const vm = build([e.pinned5]);
  const md = reportMarkdown(input(vm, [e.pinned5], { logDir: 'C:\\Users\\me`s\\.claude', raw: { five_hour: { utilization: 44, resets_at: null }, note: '```\n| x |' } }));
  assert.ok(md.includes('``C:\\Users\\me`s\\.claude``'));
  assert.ok(md.includes('````json\n'), 'the fence outgrows any backtick run in the raw answer');
});
