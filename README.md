# Tokenomancer

*Reads the runes between the whole numbers.*

See your Claude plan usage to the decimal. Tokenomancer reads Claude Code's live token logs and calibrates them against your official 5-hour, weekly, and Fable limits, so you know exactly where you stand between whole percentages. It lives in the VS Code status bar, built for people who use Claude Code in the extension panel.

```
5h 15.43% · wk 23.18% · Fable wk 8.71%
```

Hover for the breakdown: official vs. estimated value per limit with its ± uncertainty, what 1% costs you, current pace, time to the next 1% and to 100%, reset times, and this window's tokens by type and model. Click for a full report in the Output panel.

## How it works

Claude's usage page and `/usage` only show whole percentages. This extension combines two sources:

1. **Official numbers.** Every 60 seconds it reads the same usage endpoint `/usage` uses (`api.anthropic.com/api/oauth/usage`), authenticating with the Claude Code login on this computer (`~/.claude/.credentials.json`; Keychain on macOS). The token is sent only to `api.anthropic.com`.
2. **Your tokens.** It watches Claude Code's logs in `~/.claude/projects/**/*.jsonl` and picks up each response's input, output, cache-write and cache-read tokens the moment they're written. Each request is converted to an API-equivalent cost using Anthropic's published per-model prices, so a Fable output token weighs far more than a Sonnet cache read.

Then, for each limit:

- **Calibrate.** Between two ticks of the official number (say 15% → 16% → 17%), the requests logged locally cost exactly one point. Each crossing lies somewhere inside its poll interval, so half of each end interval is counted. This deliberately uses no model, so calibration can't just confirm what it already believes. From many intervals it learns what 1% costs, plus a correction factor for each model and token type (fresh input, output, cache reads), starting from API price ratios. If the real limit counts cache reads three times heavier than API prices do, it learns that.
- **Bound.** Every official reading is a fact: *at that moment you were between 16 and 17*. Pushed forward by the predicted cost of every request since, each reading bounds where you are now. The reading just before a tick and the one just after it bracket the value tightly; intersecting all of them gives the range.
- **Estimate.** Within that range, the predicted total since the window began is the best guess, weighted by how much the model has earned trust. The hover shows the resulting ± so you can see when the last digit means something.

Per-model limits (e.g. Fable) only count that model's tokens. If the endpoint ever returns decimals itself, those are used directly.

### What the markers mean

| Shown | Meaning |
|---|---|
| `15%` | Calibrating. Needs a few 1-point changes while VS Code is open. |
| `15.43%` | Pinned between recent ticks. Most accurate. |
| `~15.43%` | Counted from the start of the window; tightens at the next tick. |
| `≈15.4%` | Usage elsewhere (another device, the Claude app) moved the number; loosely bounded until the next tick. |

### How accurate

Measured in simulation (`npm test`) against realistic Claude Code traffic, after calibration:

| Scenario | Average error | 90% of the time within |
|---|---|---|
| 60 s polling, limit weighs tokens like API prices | ±0.012 points | ±0.03 |
| 60 s polling, limit weighs tokens differently (learned) | ±0.03 | ±0.07 |
| 300 s polling | ±0.05 | ±0.15 |
| The official whole number alone | ±0.23 | ±0.45 |

So hundredths are real at the default 60-second polling when your account's weighting is close to API price ratios, and within a few hundredths when it isn't. No estimate can be finer than one request: the true value only moves when a request completes, typically by 0.01–0.1 points.

## Limits of the estimate

- **Only this computer is visible.** Chats in the Claude app, cloud sessions, and Claude Code on other machines move the official number without leaving local logs. When that happens the estimate is clamped to the official range and that interval is left out of calibration.
- **The weights start as a proxy.** Anthropic doesn't publish how plan limits weigh models and token types. Tokenomancer starts from API prices and learns corrections, but a model you rarely use gets little data and stays closer to the shared scale. You can set starting weights with `tokenomancer.priceOverrides`.
- **The usage endpoint is undocumented.** It works today and could change. If it does, the status bar shows a warning and the token counts keep working.
- **Timing.** Readings are stamped when the request is sent. If the server's count lags behind completed requests by more than a few seconds, the bounds shift slightly.
- The weekly limits tick slowly, so their calibration takes a day or two of normal use to settle.

## Settings

| Setting | Default | |
|---|---|---|
| `tokenomancer.pollSeconds` | 60 | How often to read official numbers (min 30). Faster = more precise. |
| `tokenomancer.statusBarBuckets` | `[]` | Which limits to show. Empty = 5-hour, weekly, and any Fable limit. The full report lists the keys available on your account. |
| `tokenomancer.decimals` | 2 | Decimal places. |
| `tokenomancer.officialRounding` | `floor` | Whether the official number is truncated (`floor`) or rounded (`round`). |
| `tokenomancer.claudeDir` | `""` | Claude Code config folder, if not `~/.claude`. |
| `tokenomancer.priceOverrides` | `{}` | Per-model weight overrides. |

Commands (Ctrl+Shift+P): **Refresh now**, **Show full report**, **Reset calibration**.

## Install

From a release: Extensions view → `…` menu → **Install from VSIX…** → pick `tokenomancer-0.1.0.vsix`.

From source:

```
npm install
npm run package
code --install-extension tokenomancer-0.1.0.vsix
```

## Development

```
npm run typecheck   # TypeScript
npm test            # unit tests + estimator simulation
npm run build       # bundle to dist/extension.js
```

Source layout: `pricing.ts` (weights), `logReader.ts` (incremental JSONL tailing and de-duplication), `ledger.ts` (time-indexed events), `usageApi.ts` (credentials and endpoint), `estimator.ts` (calibration, weight learning and bounds), `extension.ts` (status bar and commands).

Independent project; not affiliated with Anthropic.
