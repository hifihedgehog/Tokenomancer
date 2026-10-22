import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_FIELDS, CONFIG_SCHEMA, Config, changeKind, normalizeConfig } from '../config';

const S = 'tokenomancer.';
const ENV = {};

/** Settings as VS Code would hand them over: only what the user set, plus `isSet` from inspect(). */
function cfg(user: Record<string, unknown> = {}, env: Record<string, string | undefined> = ENV): Config {
  return normalizeConfig(k => user[k], k => k in user, env);
}

const schemaDefaults = () => normalizeConfig(k => CONFIG_SCHEMA[S + k]?.default, () => false, ENV);

test('defaults', () => {
  const c = cfg();
  assert.deepEqual({ ...c, dir: undefined }, {
    decimals: 2, precision: 'adaptive', rounding: 'floor', show: 'all', customKeys: [], uncertainty: 'off',
    icon: 'rune', highlight: 'nearLimit', graphics: 'images', pollMs: 60_000, time: { hour12: undefined },
    dir: undefined, overrides: {}, clickAction: 'dashboard', alignment: 'right', priority: 100,
    alerts: { mode: 'runOut', leadMinutes: 30 },
  });
  assert.equal(c.dir, path.join(os.homedir(), '.claude'));
});

test('the schema defaults are the defaults the code uses', () => {
  assert.deepEqual(schemaDefaults(), cfg());
});

test('pollSeconds is an integer from 30 to 240; anything else is 60', () => {
  const poll = (v: unknown) => cfg({ pollSeconds: v }).pollMs / 1000;
  assert.deepEqual([NaN, 5, 999, 45.6, '90', null, Infinity].map(poll), [60, 30, 240, 46, 60, 60, 60]);
});

test('numbers are clamped integers', () => {
  assert.deepEqual([-1, 1.4, 2.6, 7, 'x'].map(v => cfg({ decimals: v }).decimals), [0, 1, 3, 3, 2]);
  assert.deepEqual([5, 45, 500, NaN].map(v => cfg({ 'alerts.leadMinutes': v }).alerts.leadMinutes), [10, 45, 180, 30]);
  assert.deepEqual([-20.4, 'high'].map(v => cfg({ 'statusBar.priority': v }).priority), [-20, 100]);
});

test('enums fall back to their default; the dropped "view" click action opens the dashboard', () => {
  const c = cfg({ 'statusBar.show': 'everything', 'statusBar.clickAction': 'view', officialRounding: 'round', 'alerts.mode': 'off', 'statusBar.alignment': 'left' });
  assert.deepEqual([c.show, c.clickAction, c.rounding, c.alerts.mode, c.alignment], ['all', 'dashboard', 'round', 'off', 'left']);
});

test('the 0.1 bucket list selects custom only while Show is unset', () => {
  const keys = ['five_hour', ' seven_day_fable ', '', 'five_hour', 7];
  assert.deepEqual([cfg({ statusBarBuckets: keys }).show, cfg({ statusBarBuckets: keys }).customKeys], ['custom', ['five_hour', 'seven_day_fable']]);
  assert.equal(cfg({ statusBarBuckets: keys, 'statusBar.show': 'binding' }).show, 'binding');
  assert.equal(cfg({ statusBarBuckets: [] }).show, 'all');
  assert.deepEqual(cfg({ statusBarBuckets: 'five_hour' }).customKeys, []);
});

test('timeFormat sets the hour cycle', () => {
  assert.deepEqual(['system', '12h', '24h', 'x'].map(v => cfg({ timeFormat: v }).time.hour12), [undefined, true, false, undefined]);
});

test('claudeDir: setting, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
  const env = { CLAUDE_CONFIG_DIR: '/env/claude' };
  assert.equal(cfg({ claudeDir: '  ~/work/.claude ' }, env).dir, path.join(os.homedir(), 'work/.claude'));
  assert.equal(cfg({ claudeDir: '~' }).dir, os.homedir());
  assert.equal(cfg({ claudeDir: '/abs' }, env).dir, '/abs');
  assert.equal(cfg({ claudeDir: '   ' }, env).dir, '/env/claude');
  assert.equal(cfg({ claudeDir: 42 }, env).dir, '/env/claude');
  assert.equal(cfg({}, {}).dir, path.join(os.homedir(), '.claude'));
});

test('price overrides keep only non-negative numbers for known fields', () => {
  const c = cfg({ priceOverrides: { 'fable-5-1': { input: 10, output: '50', cacheRead: -1, bogus: 3 }, 'opus-5': { output: 20 }, ' ': { input: 1 }, junk: 3 } });
  assert.deepEqual(c.overrides, { 'fable-5-1': { input: 10 }, 'opus-5': { output: 20 } });
  assert.deepEqual(cfg({ priceOverrides: [1] }).overrides, {});
});

test('changeKind: poll on folder or interval, recreate on placement', () => {
  const a = cfg();
  assert.deepEqual(changeKind(a, cfg({ decimals: 3 })), { poll: false, recreate: false });
  assert.deepEqual(changeKind(a, cfg({ pollSeconds: 90 })), { poll: true, recreate: false });
  assert.deepEqual(changeKind(a, cfg({ claudeDir: '/elsewhere' })), { poll: true, recreate: false });
  assert.deepEqual(changeKind(a, cfg({ 'statusBar.alignment': 'left' })), { poll: false, recreate: true });
  assert.deepEqual(changeKind(a, cfg({ 'statusBar.priority': 5 })), { poll: false, recreate: true });
});

test('no setting is another setting plus "." (VS Code would silently drop the longer one)', () => {
  const keys = Object.keys(CONFIG_SCHEMA);
  for (const a of keys) for (const b of keys) assert.ok(!b.startsWith(a + '.'), `${b} sits under ${a}`);
});

test('every Config field is read from schema keys, and every schema key is read', () => {
  const read = new Set<string>();
  normalizeConfig(k => { read.add(k); return undefined; }, () => false, ENV);
  const schemaKeys = Object.keys(CONFIG_SCHEMA).map(k => k.slice(S.length)).sort();
  assert.deepEqual([...read].sort(), schemaKeys);
  assert.deepEqual(Object.keys(CONFIG_FIELDS).sort(), Object.keys(cfg()).sort());
  assert.deepEqual([...new Set(Object.values(CONFIG_FIELDS).flat())].sort(), schemaKeys);
});

test('the schema is complete and well formed', () => {
  const machine = ['claudeDir'], application = ['pollSeconds', 'officialRounding', 'priceOverrides', 'alerts.mode', 'alerts.leadMinutes', 'timeFormat'];
  const orders = new Set<number>();
  for (const [key, s] of Object.entries(CONFIG_SCHEMA)) {
    const k = key.slice(S.length);
    assert.ok(key.startsWith(S), key);
    assert.equal(typeof s.markdownDescription, 'string', key);
    assert.ok(!('description' in s), `${key}: use markdownDescription only`);
    assert.equal(typeof s.order, 'number', key);
    assert.ok(!orders.has(s.order as number), `${key}: duplicate order`);
    orders.add(s.order as number);
    assert.equal(s.scope, machine.includes(k) ? 'machine' : application.includes(k) ? 'application' : 'window', key);
    if (Array.isArray(s.enum)) {
      assert.equal((s.enumDescriptions as string[]).length, s.enum.length, key);
      assert.ok(s.enum.includes(s.default), key);
    }
    if (s.type === 'integer') {
      assert.ok(Number.isInteger(s.default), key);
      if ('minimum' in s) assert.ok((s.default as number) >= (s.minimum as number) && (s.default as number) <= (s.maximum as number), key);
    }
    // Links like #tokenomancer.decimals# must name a real setting.
    for (const [, ref] of String(s.markdownDescription).matchAll(/#(tokenomancer\.[\w.]+)#/g)) assert.ok(ref in CONFIG_SCHEMA, `${key} links ${ref}`);
  }
  assert.deepEqual(CONFIG_SCHEMA[S + 'pollSeconds'], { ...CONFIG_SCHEMA[S + 'pollSeconds'], type: 'integer', minimum: 30, maximum: 240, default: 60 });
  const price = (CONFIG_SCHEMA[S + 'priceOverrides'] as any).additionalProperties;
  assert.deepEqual(Object.keys(price.properties), ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead']);
  assert.equal(price.additionalProperties, false);
  assert.doesNotThrow(() => JSON.stringify(CONFIG_SCHEMA));
});
