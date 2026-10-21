import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBuckets } from '../usageApi';
import { label, fmtPct } from '../format';

test('parses every bucket with a numeric utilization', () => {
  const b = parseBuckets({
    five_hour: { utilization: 15.0, resets_at: '2026-10-22T00:30:00+00:00' },
    seven_day: { utilization: 23.0, resets_at: '2026-10-26T19:00:00+00:00' },
    seven_day_fable: { utilization: 8.0, resets_at: '2026-10-26T19:00:00+00:00' },
    seven_day_opus: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    omelette_promotional: { utilization: 0.0, resets_at: null },
  });
  assert.deepEqual([...b.keys()], ['five_hour', 'seven_day', 'seven_day_fable', 'omelette_promotional']);
  assert.equal(b.get('five_hour')!.utilization, 15);
  assert.equal(b.get('omelette_promotional')!.resetsAt, null);
});

test('labels and formatting', () => {
  assert.equal(label('five_hour'), '5h');
  assert.equal(label('seven_day'), 'wk');
  assert.equal(label('seven_day_fable'), 'Fable wk');
  const base = { key: 'five_hour', official: 37, value: 37.734, samples: 5 };
  assert.equal(fmtPct({ ...base, kind: 'anchored' }, 1), '37.7%');
  assert.equal(fmtPct({ ...base, kind: 'lower-bound' }, 1), '≥37.7%');
  assert.equal(fmtPct({ ...base, kind: 'official' }, 1), '37%');
});
