import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryText } from '../ui/summaryText';
import { LOCAL, MIN, NOW, bucket, build, edgeBuckets, est } from './nativeFixtures';

const e = edgeBuckets();

test('one line in the status bar\'s order, with every ± and state word', () => {
  assert.equal(summaryText(build([e.pinnedWk, e.countedFable, e.pinned5])),
    'Claude usage at 13:12 — 5-hour 44.27% ±0.02 (pinned) · Weekly 61.18% ±0.03 (pinned) · Fable weekly ~38.4% ±0.2 (counted) · via Tokenomancer');
  // The ± is copied even when the status bar shows fewer limits or hides it.
  assert.equal(summaryText(build([e.pinnedWk, e.pinned5], { cfg: { show: 'binding', uncertainty: 'off' } })),
    'Claude usage at 13:12 — Weekly 61.18% ±0.03 (pinned) · 5-hour 44.27% ±0.02 (pinned) · via Tokenomancer');
});

test('loose copies its range, a limit its reset, a reset window says so', () => {
  assert.equal(summaryText(build([e.looseWk, e.limit5])),
    'Claude usage at 13:12 — 5-hour 100% (limit, resets 14:24) · Weekly 23.1–24.5% (loose) · via Tokenomancer');
  assert.equal(summaryText(build([bucket(est('five_hour', { resetIn: -10 * MIN }), { t: NOW - 20 * MIN })])),
    'Claude usage at 13:12 — 5-hour new window (reset) · via Tokenomancer');
});

test('sample data and stale numbers are labelled, so a pasted number never claims too much', () => {
  assert.equal(summaryText(build([e.pinnedWk], { sample: true, fresh: { lastOkAt: NOW - 20 * MIN } })),
    'Claude usage at 13:12 (sample data) — Weekly ≥61.1% (last known) · official numbers read 20 min ago · via Tokenomancer');
});

test('with no limits, the headline', () => {
  assert.equal(summaryText(build([], { local: { ...LOCAL, requests: 0 }, fresh: { lastOkAt: undefined, error: { kind: 'no-credentials', message: '' } } })),
    'Claude usage at 13:12 — No Claude Code sign-in found · via Tokenomancer');
  assert.equal(summaryText(build([], { fresh: { lastOkAt: undefined, error: { kind: 'rate-limited', message: '' }, nextTryAt: NOW + 5 * MIN } })),
    'Claude usage at 13:12 — Can\'t read plan usage yet: next try 13:17 · via Tokenomancer');
});
