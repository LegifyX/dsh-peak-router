# dsh-peak-router

A provider-agnostic peak/off-peak route rule for DeepSeek Harness.

During a configured pricing window it moves live sessions to one provider/model
pair; outside the window it moves them back to another. Both sides are ordinary
`provider` / `model` ids from whatever the profile declares, so the plugin is
not tied to DeepSeek, deeprelay, or any other platform.

The switch is written with `agent.model.select()`, so each change is a durable
`model/selection` event in the session log — auditable, and never a mutation of
a request already in flight.

A browser half adds a **Peak Router** page under Settings → Web Extensions. The
page edits the same settings the profile patch declares, with the profile kept
as defaults and the page's saves stored as overrides in
`<dsh home>/dsh-peak-router.json`.

## Why

Some providers charge peak prices for part of the day. A flat-rate plan
elsewhere makes those hours the cheapest time to spend that quota instead. The
router applies that choice automatically at the boundary, and can stop when the
target's own subscription meter is nearly spent.

## Configuration

Every field has a default; only the ones you want to change need to appear.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. Live-editable from the row's settings form. |
| `peakRoutes` | `[{ provider: deeprelay, model: deeprelay/deepseek-v4.1-flash }]` | Ordered peak preference list. The first route with meter room is used; an exhausted route falls through to the next. Empty = no peak switching (main route all day). |
| `peakProvider` / `peakModel` / `peakReasoningEffort` | `deeprelay` / `deeprelay/deepseek-v4.1-flash` / `''` | Legacy single-route fields. Used only when `peakRoutes` is absent or empty. |
| `offPeakProvider` | `deepseek-account` | Provider route used outside the window. |
| `offPeakModel` | `deepseek-flash` | Model used outside the window. |
| `offPeakReasoningEffort` | `''` | Optional adapter reasoning effort. |
| `swapBack` | `true` | Move sessions back when the window ends. `false` = one-way. |
| `respectManualSelection` | `true` | Once you pick a different model in a session, that session is left alone until restart. |
| `timeZone` | `Asia/Shanghai` | IANA zone the window and holiday dates are read in. |
| `peakWindows` | `['09:00-12:00', '14:00-18:00']` | `HH:MM-HH:MM` windows. Multiple windows allowed; `22:00-02:00` crosses midnight. |
| `peakDays` | `weekdays` | `weekdays` (Mon–Fri) or `all`. |
| `holidays` | `[]` | Extra off-peak dates (`YYYY-MM-DD`) in `timeZone`. |
| `quotaAdapter` | `deeprelay` | Subscription-meter reader. `none` disables the guard. |
| `quotaProvider` | `deeprelay` | Deprecated: the guard now reads each route's own provider. |
| `quotaApiKeyEnv` | `DEEPRELAY_API_KEY` | Credential reference holding that provider's key. |
| `quotaBaseURL` | `https://api.deeprelay.ai` | API origin for the meter read. |
| `minRemainingPercent` | `1` | Skip the swap when any meter has less than this left. |

### Examples

DeepSeek peak → deeprelay flat plan (the shipped default):

```yaml
- id: dsh-peak-router
  name: dsh-peak-router
  config:
    peakProvider: deeprelay
    peakModel: deeprelay/deepseek-v4.1-flash
    offPeakProvider: deepseek-account
    offPeakModel: deepseek-flash
```

Several peak routes in preference order — deeprelay first, then a second
provider, then a third; the main route is the final fallback:

```yaml
- id: dsh-peak-router
  name: dsh-peak-router
  config:
    offPeakProvider: deepseek-account
    offPeakModel: deepseek-flash
    peakRoutes:
      - provider: deeprelay
        model: deeprelay/deepseek-v4.1-flash
      - provider: openrouter
        model: anthropic/claude-x
      - provider: zai
        model: glm-4.6
```

A completely different pair — peak to OpenRouter, off-peak to a local model:

```yaml
- id: dsh-peak-router
  name: dsh-peak-router
  config:
    peakProvider: openrouter
    peakModel: anthropic/claude-x
    offPeakProvider: llamacpp
    offPeakModel: Qwen2.5-Coder-7B-Instruct-Q5_K_M
    quotaAdapter: none
```

A provider whose peak window is UTC-based, every day, and needs no meter check:

```yaml
- id: dsh-peak-router
  name: dsh-peak-router
  config:
    timeZone: UTC
    peakWindows: ['01:00-04:00', '06:00-10:00']
    peakDays: all
    quotaAdapter: none
```

One-way (switch at peak, never switch back):

```yaml
    swapBack: false
```

Paused:

```yaml
    enabled: false
```

## Configure in the Web UI

Open **Settings → Web Extensions → Peak Router**. The page shows the current
period, the next boundary, the live route count and the last switch, and edits:

- the enable switch (a pill toggle like the other Web Extensions pages), the
  main (off-peak) route first, then the ordered peak list, and the two
  behaviour toggles;
- the peak list is editable: **+ Add route** appends a row on a provider that
  is not in the list yet (and reports models), **−** removes a row, and
  **↑ / ↓** reorder it. With no peak rows the main route is used all day;
- under *Schedule, quota and advanced settings*: time zone, days, windows,
  holiday dates, the quota adapter, the remaining-percent floor, the quota
  credential reference and API origin.

**Save** writes the overrides and applies them immediately (no restart).
**Reset to profile defaults** deletes the override file. A provider or model
that is already persisted but missing from the catalog still appears in its
select, so an older route is never silently dropped.

## Behaviour

1. **At a boundary** the plugin computes the target route: inside a peak
   window it walks `peakRoutes` in order; otherwise it uses the main (off-peak)
   pair unless `swapBack` is false.
2. **A peak route is skipped** when its provider has a subscription meter and
   the tightest window has less than `minRemainingPercent` left. The next route
   in the list is tried; when every route is spent, the main route is used even
   if `swapBack` is false. A failed meter read is logged and that route is
   treated as available. A provider with no meter adapter (anything other than
   `deeprelay` today) is always treated as available.
3. **Each live agent** on a managed route is moved with
   `agent.model.select()`. A new agent is routed synchronously as it is created,
   so its first step already runs on the right side.
4. **Manual choices win.** If you change a session's model after the router set
   it, that session is never touched again for the rest of the process. Set
   `respectManualSelection: false` to keep enforcing the schedule.
5. **The clock** is read through `Intl` in `timeZone`, so DST and
   midnight-crossing windows are handled without offset arithmetic. The next
   boundary is armed exactly; a five-minute safety pass catches sleep/resume
   drift.

## Notes and limits

- Peak windows are a schedule, not a price feed. Public holidays must be listed
  in `holidays`; the plugin ships none.
- `quotaAdapter` currently has one implementation, `deeprelay`. Adding another
  provider is one entry in `QUOTA_ADAPTERS` in `lib/index.js`; the routing core
  never learns a provider name.
- The plugin only routes `agent` sessions through the registry. Direct
  `ctx.llm.stream()` callers (session titles, compaction) keep their own route.
- Sessions created before the plugin started are picked up by the first pass.

## Install

The package is a bundle: `dsh.bundle.patch` names `cordis.patch.yml`, which
inserts the `dsh-peak-router` row itself, and `dsh.client` declares the Web
Extensions page (`lib/client.js`). Install it like any other bundle — Plugin
Manager in the Web UI, or the same package operation from a shell:

```bash
dsh plugin --profile web add github:<owner>/dsh-peak-router#<commit>
```

then switch the `dsh-peak-router` bundle on in Settings → Plugins. Pinning the
commit keeps an update an explicit step instead of a surprise.

For work on a checkout, install the directory instead and restart:

```bash
dsh plugin --profile web add link:/path/to/dsh-peak-router
```

Restart the Host once after installing, so the patch row and the client module
manifest load. Later changes to `lib/client.js` need only a page refresh;
changes to `lib/index.js` still need a restart.

Configure it in the UI (Settings → Web Extensions → Peak Router), which stores
overrides in `<dsh home>/dsh-peak-router.json`. To ship defaults for a profile
instead, override the row by id in the profile's patch layer:

```yaml
- id: dsh-peak-router
  config:
    peakRoutes:
      - provider: deeprelay
        model: deeprelay/deepseek-v4.1-flash
    offPeakProvider: deepseek-account
    offPeakModel: deepseek-flash
```
