import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModel, weightedCost } from '../pricing';

test('parses current and legacy model ids', () => {
  assert.deepEqual(parseModel('claude-fable-5-1'), { family: 'fable', key: 'fable-5-1' });
  assert.deepEqual(parseModel('claude-opus-4-5-20251101'), { family: 'opus', key: 'opus-4-5' });
  assert.deepEqual(parseModel('claude-opus-4-20250514'), { family: 'opus', key: 'opus-4' });
  assert.deepEqual(parseModel('claude-sonnet-5-5[1m]'), { family: 'sonnet', key: 'sonnet-5-5' });
  assert.deepEqual(parseModel('claude-3-5-haiku-20241022'), { family: 'haiku', key: 'haiku-3-5' });
  assert.equal(parseModel('gpt-x').family, 'other');
});

test('weights tokens by model and token type', () => {
  const u = { input: 1_000_000, output: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 1_000_000 };
  assert.equal(weightedCost('claude-fable-5-1', u), 10 + 50 + 12.5 + 20 + 0.25);
  assert.equal(weightedCost('claude-opus-5-5', u), 4 + 20 + 5 + 8 + 0.2);
  // unknown future version falls back to the newest family price
  assert.equal(weightedCost('claude-sonnet-9-9', u), 2 + 10 + 2.5 + 4 + 0.1);
  assert.equal(weightedCost('mystery-model', u), 0);
  // overrides win
  assert.equal(weightedCost('claude-fable-5-1', { ...u, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, { 'fable': { input: 1, output: 1 } }), 2);
});
