# Claude Usage Lens

A VS Code status-bar item that shows your Claude plan usage with decimals, plus live token counts, for people who use Claude Code in the VS Code extension panel.

```
5h 15.4% · wk 23.2% · Fable wk 8.7%
```

Hover for the breakdown: official vs. estimated value per limit, what 1% costs you, current pace, time to the next 1% and to 100%, reset times, and this window's tokens by type and model. Click for a full report in the Output panel.

## How it works

Claude's usage page and `/usage` only show whole percentages. This extension combines two sources:

1. **Official numbers.** Every 60 seconds it reads the same usage endpoint `/usage` uses (`api.anthropic.com/api/oauth/usage`), authenticating with the Claude Code login on this computer (`~/.claude/.credentials.json`; Keychain on macOS). The token is sent only to `api.anthropic.com`.
2. **Your tokens.** It watches Claude Code's logs in `~/.claude/projects/**/*.jsonl` and picks up each response's input, output, cache-write and cache-read tokens the moment they're written. Each request is converted to an API-equivalent cost using Anthropic's published per-model prices, so a Fable output token weighs far more than a Sonnet cache read.

Then, for each limit:

- **Calibrate.** Each time the official number moves up a point, the cost logged since the previous move is one sample of "what 1% costs". The running median of these samples is the calibration. Per-model limits (e.g. Fable) only count that model's tokens.
- **Anchor.** The moment the number changes (say to 16%), you're at ~16.0%.
- **Interpolate.** Estimate = anchor + (cost since anchor ÷ cost of 1%), clamped so it never contradicts the official number.

If the endpoint ever returns decimals itself, those are shown directly.

### What the markers mean

| Shown | Meaning |
|---|---|
| `15%` | Calibrating. Needs one or two 1-point changes while VS Code is open. |
| `15.4%` | Interpolated from a change seen live. Most accurate. |
| `~15.4%` | Counted from the start of the window; switches to the above at the next change. |
| `≥15.4%` | Only a lower bound is known (e.g. right after VS Code started). |

In simulation (`npm test`) the interpolated value stays within about ±0.03 points of the truth on average, versus ±0.25 for the whole-number reading.

## Limits of the estimate

- **Only this computer is visible.** Chats in the Claude app, cloud sessions, and Claude Code on other machines move the official number without leaving local logs. When that happens the estimate is clamped to the official range and that interval is left out of calibration.
- **The weights are a proxy.** Anthropic doesn't publish how plan limits weigh models and token types; API prices are the best public stand-in. If your model mix shifts a lot, calibration needs a few ticks to adjust. You can override weights with `claudeUsageLens.priceOverrides`.
- **The usage endpoint is undocumented.** It works today and could change. If it does, the status bar shows a warning and the token counts keep working.
- The weekly limits tick slowly, so their calibration takes a day or two of normal use to settle.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeUsageLens.pollSeconds` | 60 | How often to read official numbers (min 30). |
| `claudeUsageLens.statusBarBuckets` | `[]` | Which limits to show. Empty = 5-hour, weekly, and any Fable limit. The full report lists the keys available on your account. |
| `claudeUsageLens.decimals` | 1 | Decimal places. |
| `claudeUsageLens.officialRounding` | `floor` | Whether the official number is truncated (`floor`) or rounded (`round`). |
| `claudeUsageLens.claudeDir` | `""` | Claude Code config folder, if not `~/.claude`. |
| `claudeUsageLens.priceOverrides` | `{}` | Per-model weight overrides. |

Commands (Ctrl+Shift+P): **Refresh now**, **Show full report**, **Reset calibration**.

## Install

From a release: Extensions view → `…` menu → **Install from VSIX…** → pick `claude-usage-lens-0.1.0.vsix`.

From source:

```
npm install
npm run package
code --install-extension claude-usage-lens-0.1.0.vsix
```

## Development

```
npm run typecheck   # TypeScript
npm test            # unit tests + estimator simulation
npm run build       # bundle to dist/extension.js
```

Source layout: `pricing.ts` (weights), `logReader.ts` (incremental JSONL tailing and de-duplication), `ledger.ts` (time-indexed events), `usageApi.ts` (credentials and endpoint), `estimator.ts` (calibration and interpolation), `extension.ts` (status bar and commands).

Not affiliated with Anthropic.
