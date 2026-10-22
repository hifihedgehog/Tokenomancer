// Settings: the schema package.json contributes, and the one place raw values
// become a Config. No vscode import: the extension passes accessors, so this is
// testable and every surface sees the same clamped, validated values.

import { Price } from './pricing';
import { UiConfig } from './ui/types';
import { claudeDir } from './usageApi';

export interface Config extends UiConfig {
  dir: string;
  overrides: Record<string, Partial<Price>>;
  clickAction: 'dashboard' | 'glance' | 'report' | 'refresh';
  alignment: 'left' | 'right';
  priority: number;
  alerts: { mode: 'runOut' | 'runOutAndLimit' | 'off'; leadMinutes: number };
}

type Schema = Record<string, unknown> & { default: unknown };
const S = 'tokenomancer.';
const PRICE_FIELDS = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const;

function choice<T extends string>(order: number, options: [T, string][], def: T, markdownDescription: string, scope = 'window'): Schema {
  return {
    type: 'string', enum: options.map(o => o[0]), enumDescriptions: options.map(o => o[1]),
    default: def, markdownDescription, order, scope,
  };
}

/** `contributes.configuration.properties` for package.json, verbatim. */
export const CONFIG_SCHEMA: Record<string, Schema> = {
  [S + 'statusBar.show']: choice(1, [
    ['all', 'Every limit: 5-hour, weekly, then any model-specific weekly limits.'],
    ['binding', 'One limit: the one you will reach first.'],
    ['pair', 'The 5-hour limit, plus whichever other limit you will reach first.'],
    ['custom', 'The limits listed in Status Bar Buckets, in that order.'],
  ], 'all', 'Which limits the status bar shows. The hover always lists every limit.'),
  [S + 'statusBarBuckets']: {
    type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, default: [], order: 2, scope: 'window',
    markdownDescription: 'The limits to show when `#tokenomancer.statusBar.show#` is `custom`, by endpoint key and in order, for example `five_hour`, `seven_day`, `seven_day_fable`. The full report lists the keys your plan returns. If Show has never been set and this list is not empty, `custom` is used.',
  },
  [S + 'statusBar.uncertainty']: choice(3, [
    ['off', 'No ± in the status bar. Digits still stop where the uncertainty begins.'],
    ['first', 'Show the ± after the first limit.'],
    ['every', 'Show the ± after every limit.'],
  ], 'off', 'Whether the status bar prints the ± uncertainty. With adaptive `#tokenomancer.precision#` the digits are honest without it: `46.4%` rather than `46.39%` when the uncertainty is ±0.16. The hover, dashboard and report always show the ±.'),
  [S + 'statusBar.icon']: choice(4, [
    ['rune', "Tokenomancer's glyphs: pinned, loose, calibrating."],
    ['codicon', "Standard VS Code icons instead of Tokenomancer's glyphs."],
    ['none', 'No state icon.'],
  ], 'rune', 'The icon before the numbers. It shows how settled the first limit is, and turns into a warning or error icon near the limit.'),
  [S + 'statusBar.highlight']: choice(5, [
    ['nearLimit', 'Warning background when a limit is about to run out, error background once it has.'],
    ['limitOnly', 'Error background only once a limit is reached.'],
    ['never', 'Never change the background. The icon and text still say when a limit is near.'],
  ], 'nearLimit', 'When the status bar item gets a warning or error background.'),
  [S + 'statusBar.clickAction']: choice(6, [
    ['dashboard', 'Open the dashboard.'],
    ['glance', 'Show every limit in a quick pick.'],
    ['report', 'Open the full text report.'],
    ['refresh', 'Read the official numbers now.'],
  ], 'dashboard', 'What clicking the status bar item does.'),
  [S + 'statusBar.alignment']: choice(7, [
    ['right', 'With the language and notification items.'],
    ['left', 'With the branch and problems items.'],
  ], 'right', 'Which side of the status bar the item sits on.'),
  [S + 'statusBar.priority']: {
    type: 'integer', default: 100, order: 8, scope: 'window',
    markdownDescription: 'Position among the items on the same side of the status bar. Higher values sit further left.',
  },
  [S + 'decimals']: {
    type: 'integer', default: 2, minimum: 0, maximum: 3, order: 10, scope: 'window',
    markdownDescription: 'The most decimal places a percentage shows. With adaptive `#tokenomancer.precision#`, fewer appear when the uncertainty cannot support them.',
  },
  [S + 'precision']: choice(11, [
    ['adaptive', 'Show only the digits the ± supports.'],
    ['fixed', 'Always show the full number of decimal places.'],
  ], 'adaptive', 'How many of `#tokenomancer.decimals#` to show. Either way, readings that are out of date show as lower bounds, and limits still calibrating show as a range.'),
  [S + 'hover.graphics']: choice(12, [
    ['images', 'Meters and the magnified scale as small images.'],
    ['text', 'Meters drawn with text, for setups where hover images do not load.'],
    ['off', 'Numbers only.'],
  ], 'images', 'How the status bar hover draws each limit.'),
  [S + 'alerts.mode']: choice(20, [
    ['runOut', 'Notify once per window when, at the current pace, a limit will run out before it resets.'],
    ['runOutAndLimit', 'Also notify when a limit is reached.'],
    ['off', 'Never notify.'],
  ], 'runOut', 'When Tokenomancer shows a notification. Notifications respect Do Not Disturb and appear in one window only.', 'application'),
  [S + 'alerts.leadMinutes']: {
    type: 'integer', default: 30, minimum: 10, maximum: 180, order: 21, scope: 'application',
    markdownDescription: 'How early a run-out alert appears: once the projected time to 100% is this many minutes or less.',
  },
  [S + 'timeFormat']: choice(30, [
    ['system', "Your system's clock format."],
    ['12h', '12-hour clock, e.g. 1:30 PM.'],
    ['24h', '24-hour clock, e.g. 13:30.'],
  ], 'system', 'How clock times such as reset times are shown.', 'application'),
  [S + 'pollSeconds']: {
    type: 'integer', default: 60, minimum: 30, maximum: 240, order: 40, scope: 'application',
    markdownDescription: 'How often to read the official numbers, in seconds. Shorter intervals pin the decimals more tightly: about ±0.01–0.03 points at 60 s. Slower than 240 s cannot calibrate. Every VS Code window shares one reading, so more windows do not mean more requests.',
  },
  [S + 'officialRounding']: choice(41, [
    ['floor', '37 means 37.00–37.99.'],
    ['round', '37 means 36.50–37.49.'],
  ], 'floor', 'How the official whole-number percentage is rounded.', 'application'),
  [S + 'claudeDir']: {
    type: 'string', default: '', order: 50, scope: 'machine',
    markdownDescription: "Claude Code's config folder, which holds its login and logs. Empty uses `CLAUDE_CONFIG_DIR`, or `~/.claude`.",
  },
  [S + 'priceOverrides']: {
    type: 'object', default: {}, order: 51, scope: 'application',
    additionalProperties: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(PRICE_FIELDS.map(f => [f, { type: 'number', minimum: 0 }])),
    },
    markdownDescription: 'Per-model weights in USD per million tokens, keyed by a substring of the model id; the longest match wins. Only the ratios matter, because what 1% costs is learned from your own usage. Changes apply to log events read from now on. Example: `{"fable-5-1": {"input": 10, "output": 50, "cacheWrite5m": 12.5, "cacheWrite1h": 20, "cacheRead": 0.25}}`',
  },
};

/** The settings each Config field is read from. Typed so a new field cannot be left out. */
export const CONFIG_FIELDS: { [K in keyof Config]-?: string[] } = {
  decimals: ['decimals'], precision: ['precision'], rounding: ['officialRounding'],
  show: ['statusBar.show', 'statusBarBuckets'], customKeys: ['statusBarBuckets'], uncertainty: ['statusBar.uncertainty'],
  icon: ['statusBar.icon'], highlight: ['statusBar.highlight'], graphics: ['hover.graphics'], pollMs: ['pollSeconds'],
  time: ['timeFormat'], dir: ['claudeDir'], overrides: ['priceOverrides'], clickAction: ['statusBar.clickAction'],
  alignment: ['statusBar.alignment'], priority: ['statusBar.priority'], alerts: ['alerts.mode', 'alerts.leadMinutes'],
};

function int(v: unknown, def: number, min: number, max: number): number {
  return typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
}

function overrides(v: unknown): Record<string, Partial<Price>> {
  const out: Record<string, Partial<Price>> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [model, p] of Object.entries(v)) {
    if (!model.trim() || !p || typeof p !== 'object') continue;
    const price: Partial<Price> = {};
    for (const f of PRICE_FIELDS) {
      const n = (p as Record<string, unknown>)[f];
      if (typeof n === 'number' && isFinite(n) && n >= 0) price[f] = n;
    }
    if (Object.keys(price).length) out[model] = price;
  }
  return out;
}

/**
 * Reads every setting through `get` (keys relative to the `tokenomancer` section) and
 * returns validated values. `isSet` says whether the user set a key at any level; it
 * decides whether the 0.1 `statusBarBuckets` list still picks what the status bar shows.
 */
export function normalizeConfig(get: (key: string) => unknown, isSet: (key: string) => boolean,
  env: Record<string, string | undefined> = process.env): Config {
  const pick = <T extends string>(key: string): T => {
    const s = CONFIG_SCHEMA[S + key] as { enum: T[]; default: T };
    const v = get(key);
    return s.enum.includes(v as T) ? v as T : s.default;
  };
  const raw = get('statusBarBuckets');
  const customKeys = Array.isArray(raw)
    ? [...new Set(raw.filter((k): k is string => typeof k === 'string').map(k => k.trim()).filter(Boolean))]
    : [];
  const show = isSet('statusBar.show') || !customKeys.length ? pick<Config['show']>('statusBar.show') : 'custom';
  const timeFormat = pick<'system' | '12h' | '24h'>('timeFormat');
  const dir = get('claudeDir');
  return {
    decimals: int(get('decimals'), 2, 0, 3),
    precision: pick('precision'),
    rounding: pick('officialRounding'),
    show,
    customKeys,
    uncertainty: pick('statusBar.uncertainty'),
    icon: pick('statusBar.icon'),
    highlight: pick('statusBar.highlight'),
    graphics: pick('hover.graphics'),
    pollMs: int(get('pollSeconds'), 60, 30, 240) * 1000,
    time: { hour12: timeFormat === 'system' ? undefined : timeFormat === '12h' },
    dir: claudeDir(typeof dir === 'string' ? dir : undefined, env),
    overrides: overrides(get('priceOverrides')),
    clickAction: pick('statusBar.clickAction'),
    alignment: pick('statusBar.alignment'),
    priority: int(get('statusBar.priority'), 100, -1e6, 1e6),
    alerts: { mode: pick('alerts.mode'), leadMinutes: int(get('alerts.leadMinutes'), 30, 10, 180) },
  };
}

/** What a settings change needs beyond a re-render. */
export function changeKind(prev: Config, next: Config): { poll: boolean; recreate: boolean } {
  return {
    poll: prev.dir !== next.dir || prev.pollMs !== next.pollMs,
    recreate: prev.alignment !== next.alignment || prev.priority !== next.priority,
  };
}
