# quota-left

[中文](README.zh-CN.md)

A Claude Code mod that draws what you have left under the prompt: subscription quota, context window, prompt cache lifetime, and, on API billing, the session's cost.

```
5h    ██░░░░░░░░  23% resets in 2h13m      7d    ██████░░░░  60% resets in 3d4h
ctx   ████░░░░░░  38% 62% left (124k)      cache ███████░░░   1h expires in 42m
```

## What it shows

| Row | Meaning |
| --- | --- |
| `5h`, `7d` | Share of the 5-hour and weekly subscription quota used, and when each window resets. Pro and Max plans only. A toast warns at 90%. |
| `ctx` | Share of the context window used and what is left before auto-compaction, in percent and tokens. Counted against the auto-compact window, less its buffer, so the figures match `/context`. |
| `cache` | On Claude: the main thread's prompt cache lifetime (`5m` or `1h`) and the time until it lapses; the bar is the share of that lifetime left, and once it reads `expired` the next message writes the cache again. On a provider that caches by itself and reports no lifetime (DeepSeek): the share of the last request's input served from cache. |
| `cost` | Estimated cost of this session, on API billing only (see below). `peak` or `off` marks the current rate where prices differ by time of day. |
| `100 tok/s avg 90 tok/s` | Generation speed of the main thread: the last request with at least 32 output tokens, then the session average weighted by tokens. Timed from the first streamed token to the end, so the wait before the first token is left out. |

`/quota` prints the same figures as text. Cost and speed trail the last row, as they have no bar.

### How the cache countdown works

Claude Code does not expose a cache expiry, so the mod measures it from what each response reports. Each main-thread request is timed when it is sent, which is when the cache lifetime starts. When the response reports cache reads or writes, the countdown restarts from that moment. The lifetime comes from the response's `ephemeral_5m` and `ephemeral_1h` write counts. A read-only response keeps the last known lifetime. Background summaries can also renew the cache unseen, so the countdown errs short, never long. Subagent caches are not tracked. Where responses report cache reads but never a write or a lifetime, as DeepSeek's do, there is no expiry to count down, so the row shows the hit rate instead.

## Install

```
claude plugin marketplace add TheDeathDragon/claude-quota-left
claude plugin install quota-left@quota-left
```

Restart Claude Code. The quota and context rows appear after the first reply.

Requires a Claude Code version with hooks-module mods (2.1.316 or later is tested).

## Cost on API billing

On a Pro or Max subscription the quota rows show and cost does not. Otherwise the mod picks a price for each request by the model that answered it:

1. Prices you set in the options, for every model.
2. A built-in preset matching the model id. DeepSeek flash models (`deepseek-v4-flash`, also behind a gateway prefix such as `cs/`) are priced at CNY 0.04 per million cache-hit input tokens, 2 per million cache-miss input tokens and 8 per million output tokens, half that outside 9:00 to 12:00 and 14:00 to 18:00 on weekdays, Beijing time.
3. Otherwise Claude Code's own estimate, the figure `/cost` shows, in USD. It is left out where Claude Code priced a model it does not know.

To use your own prices, set them per million tokens at the peak rate; cache writes are billed at the cache-miss rate. Set them in `/config`, or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "quota-left@quota-left": {
      "options": {
        "currency": "$",
        "priceCacheHit": 0.3,
        "priceCacheMiss": 3,
        "priceOutput": 15
      }
    }
  }
}
```

For a provider with off-peak pricing, add the off-peak ratio, the weekday peak hours and their time zone. This example is the DeepSeek preset written out: half price outside 9:00 to 12:00 and 14:00 to 18:00, Monday to Friday, Beijing time (UTC+8), and weekends off-peak all day:

```json
"options": {
  "currency": "¥",
  "priceCacheHit": 0.04,
  "priceCacheMiss": 2,
  "priceOutput": 8,
  "offPeakRatio": 0.5,
  "peakHours": "9-12,14-18",
  "peakUtcOffset": 8
}
```

Each request is priced by the hour it was sent. Subagent requests count too. Requests priced in different currencies show one figure per currency. The figure is an estimate for this session only, not your bill.

| Option | Default | |
| --- | --- | --- |
| `cost` | `true` | Show the cost row |
| `currency` | `$` | Prefix for the amount |
| `priceCacheHit` | `0` | Cache-hit input, per million tokens; any price above 0 replaces the presets |
| `priceCacheMiss` | `0` | Cache-miss input and cache writes, per million tokens |
| `priceOutput` | `0` | Output, per million tokens |
| `offPeakRatio` | `1` | Off-peak price as a share of peak; `1` is a flat price |
| `peakHours` | empty | Weekday peak hours, e.g. `9-12,14-18` |
| `peakUtcOffset` | `8` | Time zone of `peakHours`, in hours from UTC |

## Development

```
claude plugin validate .
claude plugin test .
```

To work on a checkout, add it as a marketplace (`claude plugin marketplace add <folder>`), install from it, and run `/reload-plugins` after each edit. Claude Code writes the API types to `.claude-plugin/types/` when it loads the mod; `tsconfig.json` extends them.

## License

[MIT](LICENSE)
