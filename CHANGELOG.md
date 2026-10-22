# Changelog

## 0.2.0

A redesign of every surface.

**Status bar**
- The number of digits now matches the uncertainty: `46.4%` rather than `46.39%` when the ± is 0.2. This replaces the old fixed decimals.
- A rune shows each limit's state: pinned, counted, loose, calibrating or no reading.
- A limit that's still calibrating shows as a range (`16–17%`), a loose one as its proven range, and a stale one as a lower bound with its age.
- Run-out warnings depend on your pace, not on fixed thresholds. Each one comes with an icon and text, so it never relies on colour alone.
- Screen-reader labels are added.

**Hover**
- Meters show the elapsed share of each window and the projected value at reset.
- A magnified scale between the whole numbers shows the estimate and its ±1σ and ±2σ bands.
- Adds the verdict, pace, the next 1%, reset times, this window's tokens by model, and action links.

**New: dashboard and Explorer view**
- Cards for each limit.
- A chart of the whole window with even-use and projection lines.
- A "between the whole numbers" chart that shows the estimate tightening at each official tick.
- Where this window's points went, by model and by token type.
- Calibration details and table views.

**New commands:** Usage at a Glance, Copy Usage Summary, Preview with Sample Data, and Open Full Report (now a read-only Markdown document).

**Shared polling across windows:** all VS Code windows share one reading of the usage endpoint, and rate limits back off together, including `retry-after: 0`.

**Alerts:** at most one notification before a limit runs out, once per window, in the focused window only.

**Look:** a new icon and status glyphs, and colours you can override in your theme.

**Fixes**
- Large histories no longer crash on load (over about 125k events).
- An unreadable log file no longer loses other files' events.
- Request counts are no longer inflated by streamed lines.
- Error text in hovers is escaped.
- A reset 6–7 days away no longer reads as today.
- Concurrent refreshes are merged into one.
- A non-numeric `pollSeconds` no longer causes a busy loop.
- `pollSeconds` above 240 is clamped; at that interval calibration was impossible.

Calibration learned by 0.1 is kept.

## 0.1.0

- First release of Tokenomancer: hundredths-level estimates with learned per-model, per-token-type weights; status-bar estimates for 5-hour, weekly and per-model limits; live token counts from Claude Code logs.
