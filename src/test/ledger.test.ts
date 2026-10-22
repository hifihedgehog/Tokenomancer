import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../ledger';
import { UsageEvent } from '../logReader';
import { Family } from '../pricing';

const Z = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
let id = 0;
const ev = (t: number, family: Family = 'fable', first?: boolean, wu = 1): UsageEvent & { id: number } =>
  ({ t, model: `claude-${family}`, family, wu, parts: [wu, 0, 0], tokens: { ...Z, input: 10, output: 1 }, first, id: id++ });
const ids = (l: Ledger) => l.eventsIn(-Infinity, Infinity).map(e => (e as any).id);

test('adds 200k events at once without overflowing the stack', () => {
  const l = new Ledger();
  const evs = Array.from({ length: 200_000 }, (_, i) => ev(i * 1000));
  assert.doesNotThrow(() => l.add(evs));
  assert.equal(l.size, 200_000);
  // and merging a large out-of-order batch into a large ledger
  assert.doesNotThrow(() => l.add(Array.from({ length: 200_000 }, (_, i) => ev(i * 1000 + 500))));
  assert.equal(l.size, 400_000);
  const ts = l.eventsIn(-Infinity, Infinity).map(e => e.t);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1]);
});

test('out-of-order batches merge exactly like a stable sort, ties keeping earlier events first', () => {
  const l = new Ledger(), ref: (UsageEvent & { id: number })[] = [];
  const batches = [[ev(10), ev(20), ev(30)], [ev(25), ev(20), ev(40)], [ev(5)], [ev(40), ev(41)], [ev(30), ev(30), ev(1)]];
  for (const b of batches) {
    l.add(b);
    ref.push(...b);
    ref.sort((a, b) => a.t - b.t); // stable
    assert.deepEqual(ids(l), ref.map(e => e.id));
  }
});

test('version, pruned, resorts and endAbs', () => {
  const l = new Ledger();
  assert.deepEqual([l.version, l.pruned, l.resorts, l.endAbs], [0, 0, 0, 0]);
  l.add([]);
  assert.equal(l.version, 0, 'an empty add changes nothing');
  l.add([ev(10), ev(20)]);
  l.add([ev(20), ev(30)]);
  assert.deepEqual([l.version, l.resorts, l.endAbs], [2, 0, 4], 'appending (ties included) is not a resort');
  l.add([ev(15)]);
  assert.deepEqual([l.version, l.resorts, l.endAbs], [3, 1, 5]);
  l.prune(5);
  assert.equal(l.version, 3, 'pruning nothing changes nothing');
  l.prune(16);
  assert.deepEqual([l.version, l.pruned, l.size, l.endAbs], [4, 2, 3, 5]);
  assert.equal(l.firstEventTime(), 20);
  assert.equal(l.lastEventTime(), 30);
  const seen: [number, number][] = [];
  l.forEachAbs(3, (e, abs) => seen.push([e.t, abs]));
  assert.deepEqual(seen, [[20, 3], [30, 4]]);
  seen.length = 0;
  l.forEachAbs(0, (e, abs) => seen.push([e.t, abs]));
  assert.deepEqual(seen.map(s => s[1]), [2, 3, 4], 'indices before the pruned front are skipped');
});

test('requests count API requests, not their streamed lines', () => {
  const l = new Ledger();
  l.add([ev(1, 'fable', true), ev(2, 'fable', false), ev(3, 'fable', false), ev(4, 'sonnet', true), ev(5, 'sonnet'), ev(6, 'haiku', true)]);
  assert.equal(l.requests(0, 10), 4, 'first: undefined (unknown) counts');
  assert.equal(l.requests(0, 10, f => f === 'fable'), 1);
  assert.equal(l.requests(2, 6), 2, '[from, to)');
  assert.equal(l.tokens(0, 10).requests, 4);
  assert.equal(l.tokens(0, 10).input, 60);
});

test('byFamily, wu and forEach take a filter', () => {
  const l = new Ledger();
  l.add([ev(1, 'fable', true, 2), ev(2, 'sonnet', true, 3), ev(3, 'fable', true, 5)]);
  assert.deepEqual([...l.byFamily(0, 10)], [['fable', 7], ['sonnet', 3]]);
  assert.deepEqual([...l.byFamily(0, 10, f => f === 'sonnet')], [['sonnet', 3]]);
  assert.equal(l.wu(0, 3, f => f === 'fable'), 2);
  const ts: number[] = [];
  l.forEach(2, 4, e => ts.push(e.t));
  assert.deepEqual(ts, [2, 3]);
  assert.equal(new Ledger().firstEventTime(), undefined);
});
