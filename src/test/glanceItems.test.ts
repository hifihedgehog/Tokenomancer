import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glance } from '../ui/glanceItems';
import { HOUR, LOCAL, MIN, NOW, bucket, build, edgeBuckets, est } from './nativeFixtures';

const e = edgeBuckets();
const scenario = [e.pinnedWk, e.countedFable, e.pinned5];
const ACTIONS = ['$(graph-line) Open Dashboard', '$(refresh) Refresh Now', '$(output) Open Full Report', '$(copy) Copy Usage Summary', '$(gear) Settings'];

test('one item per limit in the status bar\'s order, each with ±, state, official number and verdict', () => {
  const g = glance(build(scenario));
  assert.equal(g.title, 'Claude usage · read just now');
  const limits = g.items.filter(i => i.key);
  assert.deepEqual(limits.map(i => i.key), ['five_hour', 'seven_day', 'seven_day_fable']);
  assert.deepEqual(limits[1], {
    label: '$(tokenomancer-pinned) Weekly  61.18% ±0.03',
    description: 'pinned · official 61% · binds first',
    detail: 'Runs out ~Sat 13:30 — 1d 20h before reset · resets Mon 8:12 (in 3d 20h) · next 1% in 24–25 min · 15.9 pts ahead of even use',
    key: 'seven_day',
  });
  // "Lands … by 15:06" already names the reset clock, so only the time left follows it.
  assert.equal(limits[0].detail, 'Lands ~56–71% by 15:06 · resets in 1h 54m · next 1% in ~7 min · 17.7 pts below even use');
  assert.equal(limits[2].label, '$(tokenomancer-loose) Fable weekly  ~38.4% ±0.2');
  assert.equal(limits[2].description, 'counted · official 38%');
});

test('then a separator and the actions', () => {
  const items = glance(build(scenario)).items;
  const sep = items.findIndex(i => i.separator);
  assert.equal(items[sep].label, 'Actions');
  assert.deepEqual(items.slice(sep + 1).map(i => i.label), ACTIONS);
  assert.deepEqual(items.slice(sep + 1).map(i => i.command), ['openDashboard', 'refresh', 'showDetails', 'copySummary', 'openSettings']);
});

test('loose shows its range with no ±; a limit says when it resets once; reset and idle read plainly', () => {
  const items = glance(build([e.looseWk, e.limit5, bucket(est('seven_day_fable', { resetIn: -5 * MIN }), { t: NOW - 20 * MIN })])).items;
  const by = (k: string) => items.find(i => i.key === k)!;
  assert.equal(by('seven_day').label, '$(tokenomancer-loose) Weekly  23.1–24.5%');
  assert.equal(by('seven_day').description, 'loose · official 23%');
  assert.equal(by('five_hour').label, '$(error) 5-hour  100%');
  assert.equal(by('five_hour').detail, 'Limit reached · resets 14:24 (in 1h 12m)');
  assert.equal(by('seven_day_fable').label, '$(tokenomancer-empty) Fable weekly  new window');
  assert.equal(by('seven_day_fable').description, 'reset');
});

test('attention and codicon fallbacks', () => {
  const items = glance(build([e.urgent5, e.pinnedWk], { cfg: { icon: 'codicon' } })).items;
  assert.ok(items[0].label.startsWith('$(warning) 5-hour'));
  assert.ok(items[1].label.startsWith('$(pinned) Weekly'));
});

test('sample data, refreshing and empty states', () => {
  const s = glance(build(scenario, { sample: true, fresh: { refreshing: true } }));
  assert.equal(s.title, 'Claude usage · sample data · refreshing…');
  assert.ok(s.items.some(i => i.command === 'exitSampleData'));

  const out = glance(build([], { local: { ...LOCAL, requests: 0 }, fresh: { lastOkAt: undefined, error: { kind: 'no-credentials', message: '' } } }));
  assert.equal(out.title, 'Claude usage');
  assert.equal(out.items[0].label, '$(info) No Claude Code sign-in found');
  assert.ok(out.items[0].detail!.startsWith('Looked for a Claude Code sign-in in /home/me/.claude.'));
  assert.deepEqual(out.items.filter(i => i.command === 'setClaudeDir' || i.command === 'previewSampleData').map(i => i.command), ['setClaudeDir', 'previewSampleData']);
});

test('extras and notes get their own items', () => {
  const g = glance(build([e.pinned5], { cfg: { show: 'custom', customKeys: ['five_hour', 'nope'] }, extras: [{ key: 'extra_usage', utilization: 12 }] }));
  assert.ok(g.items.some(i => i.label === 'Extra usage  12%' && i.description === 'no time window'));
  const note = g.items.find(i => i.command === 'openSettings' && i.label.startsWith('$(info)'));
  assert.ok(note && note.detail!.includes('nope'));
});

test('text from the endpoint cannot draw icons in a label, description or detail', () => {
  const g = glance(build([bucket(est('seven_day_$(bug)', { resetIn: 50 * HOUR }))], {
    cfg: { show: 'custom', customKeys: ['$(evil)'] },
    fresh: { lastOkAt: NOW - 20 * MIN, error: { kind: 'network', message: '', code: '$(evil)' } },
    extras: [{ key: '$(bug)', utilization: 1 }],
  }));
  for (const i of g.items) for (const s of [i.label, i.description ?? '', i.detail ?? '']) {
    for (const m of s.matchAll(/(^|[^\\])\$\(([^)]*)\)/g)) assert.ok(!/bug|evil/.test(m[2]), s);
  }
});
