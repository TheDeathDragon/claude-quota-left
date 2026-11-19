import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionCost, TurnUsage } from 'claude-code'

import type { Cache, CacheTtl, Context, Spent, Window } from '../types'

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const CELLS = 10
const WARN_AT = 90
const TTL_MS: Record<CacheTtl, number> = { '5m': 300_000, '1h': 3_600_000 }

const limits = atom({ plugin: 'quota-left', key: 'limits' } as const, [], { shape: 'limits-1' })
const clock = atom({ plugin: 'quota-left', key: 'now' } as const, 0)
const context = atom({ plugin: 'quota-left', key: 'context' } as const, null, { shape: 'context-1' })
const cache = atom({ plugin: 'quota-left', key: 'cache' } as const, null, { shape: 'cache-2' })
const spent = atom({ plugin: 'quota-left', key: 'spent' } as const, null, { shape: 'spent-2' })
const engineCost = atom({ plugin: 'quota-left', key: 'engineCost' } as const, null)

export const formatLeft = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60

  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${mins}m`

  return `${mins}m`
}

export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const used = (w: Window): number => Math.min(100, Math.max(0, w.percentUsed))

const cells = (percent: number): number => Math.round((percent / 100) * CELLS)

export const filled = (w: Window): number => cells(used(w))

export const timeLeft = (w: Window, now: number): string | undefined => {
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN

  return Number.isNaN(at) ? undefined : `resets in ${formatLeft(at - now)}`
}

export const contextUsed = (c: Context): number | undefined =>
  c.percent === undefined ? undefined : Math.min(100, Math.max(0, c.percent))

export const contextLeft = (c: Context): string | undefined => {
  const pct = contextUsed(c)
  if (pct === undefined) return undefined
  const tokens = c.tokens === undefined ? '' : ` (${formatTokens(Math.max(0, c.window - c.tokens))})`

  return `${100 - pct}% left${tokens}`
}

export const cacheLeftMs = (c: Cache, ttl: CacheTtl, now: number): number => c.at + TTL_MS[ttl] - now

export const cacheText = (c: Cache, now: number): string => {
  if (!c.ttl) return `${c.hit}% hit rate`
  const ms = cacheLeftMs(c, c.ttl, now)

  return ms > 0 ? `expires in ${formatLeft(ms)}` : 'expired'
}

export type Pricing = {
  currency: string
  hit: number
  miss: number
  output: number
  offPeakRatio: number
  peakHours: [number, number][]
  utcOffsetMs: number
}

const FLAT_USD: Pricing = { currency: '$', hit: 0, miss: 0, output: 0, offPeakRatio: 1, peakHours: [], utcOffsetMs: 0 }

// Per-million-token prices at the peak rate, for models Claude Code cannot price itself.
// Matched against the model id each response reports, so a gateway prefix such as "cs/" still matches.
export const PRESETS: { id: string; match: RegExp; pricing: Pricing }[] = [
  {
    id: 'deepseek-flash',
    match: /deepseek.*flash/i,
    pricing: { currency: '¥', hit: 0.04, miss: 2, output: 8, offPeakRatio: 0.5, peakHours: [[9, 12], [14, 18]], utcOffsetMs: 8 * 3_600_000 },
  },
]

export const pricingOf = (o: PluginOptions): Pricing => ({
  currency: String(o.currency ?? '$'),
  hit: Number(o.priceCacheHit ?? 0),
  miss: Number(o.priceCacheMiss ?? 0),
  output: Number(o.priceOutput ?? 0),
  offPeakRatio: Number(o.offPeakRatio ?? 1),
  peakHours: String(o.peakHours ?? '')
    .split(',')
    .map(r => r.trim().split('-').map(Number) as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a < b),
  utcOffsetMs: Number(o.peakUtcOffset ?? 8) * 3_600_000,
})

const isPriced = (p: Pricing): boolean => p.hit + p.miss + p.output > 0

// Prices set in the options win over the presets, for every model.
export const pricingFor = (configured: Pricing | undefined, model: string): { source: string; pricing: Pricing } | undefined => {
  if (configured) return { source: 'config', pricing: configured }
  const preset = PRESETS.find(p => p.match.test(model))

  return preset && { source: preset.id, pricing: preset.pricing }
}

export const hasPeak = (p: Pricing): boolean => p.offPeakRatio !== 1 && p.peakHours.length > 0

// Peak is judged by the provider's wall clock (peakUtcOffset), whatever the machine's own time zone.
export const isPeak = (p: Pricing, at: number): boolean => {
  const bj = new Date(at + p.utcOffsetMs)
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = bj.getUTCHours() + bj.getUTCMinutes() / 60

  return p.peakHours.some(([a, b]) => hour >= a && hour < b)
}

// Cache writes go at the cache-miss rate with the uncached input: per-token providers rarely list a write price.
export const stepCost = (p: Pricing, u: TurnUsage, at: number): number => {
  const rate = isPeak(p, at) ? 1 : p.offPeakRatio
  const miss = u.input_tokens + u.cache_creation_input_tokens

  return ((u.cache_read_input_tokens * p.hit + miss * p.miss + u.output_tokens * p.output) / 1_000_000) * rate
}

export const formatMoney = (p: Pricing, n: number): string => `${p.currency}${n.toFixed(n >= 1 ? 2 : 4)}`

// Fixed column widths keep the bars and figures lined up across rows.
// DETAIL_W fits the longest detail, "resets in 23h59m" and "100% left (1.0M)".
const LABEL_W = 5
const VALUE_W = 4
const DETAIL_W = 16

export type Cell = { key: string; label: string; fill: number; tone: string; value: string; detail: string; detailTone?: string }

// Totals per pricing source, the last one used last: its rate is the one the peak marker shows.
export type Spend = { parts: { pricing: Pricing; total: number }[] }

export const spendFrom = (s: Spent | null, configured: Pricing | undefined): Spend | undefined => {
  if (!s) return undefined
  const priced = (source: string) => (source === 'config' ? configured : PRESETS.find(p => p.id === source)?.pricing)
  const order = [...Object.keys(s.totals).filter(k => k !== s.last), s.last]
  const parts = order.flatMap(source => {
    const pricing = priced(source)
    const total = s.totals[source]

    return pricing && total !== undefined ? [{ pricing, total }] : []
  })

  return parts.length > 0 ? { parts } : undefined
}

// Claude Code prices Claude models itself; that ledger stands in where no preset or configured price applied.
export const engineSpend = (usd: number | null): Spend | undefined =>
  usd !== null && usd > 0 ? { parts: [{ pricing: FLAT_USD, total: usd }] } : undefined

export const cellsOf = (list: Window[], ctx: Context | null, c: Cache | null, now: number): Cell[] => {
  const grid: Cell[] = list.map(w => ({
    key: w.kind,
    label: LABELS[w.kind] ?? w.kind,
    fill: used(w),
    tone: toneOf(used(w)),
    value: `${Math.round(used(w))}%`,
    detail: timeLeft(w, now) ?? '',
  }))
  const ctxUsed = ctx ? contextUsed(ctx) : undefined

  if (ctx && ctxUsed !== undefined) {
    grid.push({ key: 'ctx', label: 'ctx', fill: ctxUsed, tone: toneOf(ctxUsed), value: `${Math.round(ctxUsed)}%`, detail: contextLeft(ctx) ?? '' })
  }

  if (c?.ttl) {
    const leftPct = Math.min(100, Math.max(0, (cacheLeftMs(c, c.ttl, now) / TTL_MS[c.ttl]) * 100))
    grid.push({
      key: 'cache',
      label: 'cache',
      fill: leftPct,
      tone: toneOf(100 - leftPct),
      value: c.ttl,
      detail: cacheText(c, now),
      detailTone: leftPct > 0 ? undefined : 'warning',
    })
  } else if (c) {
    grid.push({ key: 'cache', label: 'cache', fill: c.hit, tone: toneOf(100 - c.hit), value: `${c.hit}%`, detail: 'hit rate' })
  }

  return grid
}

// Cost has no bar to fill, so it trails the last grid row instead of taking a cell of its own.
export type Tail = { tone: string; value: string; detail: string }

export const costOf = (spend: Spend | undefined, now: number): Tail | undefined => {
  const rate = spend?.parts[spend.parts.length - 1]?.pricing
  if (!spend || !rate) return undefined
  const tiered = hasPeak(rate)
  const peak = isPeak(rate, now)

  return {
    tone: !tiered ? 'subtle' : peak ? 'warning' : 'success',
    value: !tiered ? '' : peak ? 'peak' : 'off',
    detail: spend.parts.map(p => formatMoney(p.pricing, p.total)).join(' '),
  }
}

// A read renews the entry for the lifetime it was written with, so a read-only step keeps the last known TTL.
// When a step wrote both lifetimes, the 5m part lapses first and the tail misses from then on.
// A write with no lifetime reported is the API's default, five minutes.
// A provider that caches on its own (DeepSeek) reads but never writes and reports no lifetime:
// there is no countdown to give, so only the hit rate is kept.
export const nextCache = (u: TurnUsage, at: number, prev: Cache | null): Cache | null => {
  const touched = u.cache_read_input_tokens + u.cache_creation_input_tokens
  const input = u.input_tokens + touched
  if (input === 0) return prev
  const hit = Math.round((u.cache_read_input_tokens / input) * 100)
  const ttl: CacheTtl | undefined =
    (u.ephemeral_5m_input_tokens ?? 0) > 0
      ? '5m'
      : (u.ephemeral_1h_input_tokens ?? 0) > 0
        ? '1h'
        : u.cache_creation_input_tokens > 0
          ? (prev?.ttl ?? '5m')
          : prev?.ttl
  if (ttl && touched === 0) return prev

  return ttl ? { at, ttl, hit } : { at, hit }
}

const shown = (list: Window[]): Window[] => list.filter(w => w.kind in LABELS)

const toneOf = (percent: number): string => (percent < 50 ? 'success' : percent < 80 ? 'warning' : 'error')

const warned = new Set<string>()

function warn($: EngineInterface, list: Window[]) {
  for (const w of list) {
    const key = `${w.kind}@${w.resetsAt ?? ''}`

    if (used(w) >= WARN_AT && !warned.has(key)) {
      warned.add(key)
      $.ui.toast(`${LABELS[w.kind] ?? w.kind} quota: ${Math.round(used(w))}% used`, { timeoutMs: 8000 })
    }
  }
}

const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await update($, clock, () => now)
}

async function refresh($: EngineInterface, list: Window[]) {
  await update($, limits, () => list)
  await tick($)
}

// A ledger holding a model with no known price went at another model's rates: not worth showing.
export const usableUsd = (cost: SessionCost | undefined): number | null => (cost && !cost.hasUnknownPrice ? cost.usd : null)

const keepCost = ($: EngineInterface, cost: SessionCost | undefined) => update($, engineCost, () => usableUsd(cost))

const keepContext = ($: EngineInterface, c: Context) =>
  update($, context, () => ({ tokens: c.tokens, window: c.window, percent: c.percent }))

export const register: Register = (on, options) => {
  const own = pricingOf(options)
  const configured = isPriced(own) ? own : undefined
  const costOn = options.cost !== false
  // Cost shows on API billing only: a subscription reports quota windows instead.
  const spendOf = (hasQuota: boolean, s: Spent | null, usd: number | null): Spend | undefined =>
    !costOn || hasQuota ? undefined : (spendFrom(s, configured) ?? engineSpend(usd))

  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    await $.command.register({ name: 'quota', description: 'Show quota used, context left and prompt cache expiry' })
    const usage = await $.session.usage()
    await keepContext($, usage.context)
    await keepCost($, usage.cost)
    await refresh($, usage.rateLimits)
    $.clock.every(30_000, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await keepContext($, e.context)
    }

    if (e.changed.includes('cost')) {
      await keepCost($, e.cost)
    }

    if (e.changed.includes('rateLimits')) {
      await refresh($, e.rateLimits)
      warn($, e.rateLimits)
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const at = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage

    const priced = usage && costOn ? pricingFor(configured, usage.model) : undefined

    if (usage && priced) {
      const cost = stepCost(priced.pricing, usage, at)
      await update($, spent, prev => ({
        totals: { ...prev?.totals, [priced.source]: (prev?.totals[priced.source] ?? 0) + cost },
        last: priced.source,
      }))
    }

    if (usage && !e.agentId) {
      await update($, cache, prev => nextCache(usage, at, prev))
      await tick($)
    }

    return result
  })

  on('command.run', { command: 'quota' }, async $ => {
    const usage = await $.session.usage()
    await refresh($, usage.rateLimits)
    const now = await $.clock.now()
    const list = shown(usage.rateLimits)
    const lines = list.map(
      w => `${LABELS[w.kind]}  ${Math.round(used(w))}% used${timeLeft(w, now) ? `, ${timeLeft(w, now)}` : ''}`,
    )
    const ctx = contextLeft(usage.context)
    const c = await read($, cache)

    if (ctx) lines.push(`ctx  ${ctx}`)
    if (c) lines.push(c.ttl ? `cache  ${c.ttl}, ${cacheText(c, now)}` : `cache  ${c.hit}% of the last request's input was a cache hit`)
    const spend = spendOf(usage.rateLimits.length > 0, await read($, spent), usableUsd(usage.cost))
    const rate = spend?.parts[spend.parts.length - 1]?.pricing
    if (spend && rate) {
      const when = hasPeak(rate) ? `, ${isPeak(rate, now) ? 'peak' : 'off-peak'} rate now` : ''
      lines.push(`cost  ${spend.parts.map(p => formatMoney(p.pricing, p.total)).join(' ')} est.${when}`)
    }

    if (lines.length === 0) {
      return { text: 'No reading yet: figures arrive after the first reply.' }
    }

    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const all = await read($, limits)
    const list = shown(all)
    const ctx = await read($, context)
    const c = await read($, cache)
    const hint = await next(e)
    const now = await read($, clock)
    const grid = cellsOf(list, ctx, c, now)
    const tail = costOf(spendOf(all.length > 0, await read($, spent), await read($, engineCost)), now)

    if (grid.length === 0 && !tail) {
      return hint
    }

    const { Box, Text } = $.ui.resolve(e)
    const rows = grid.reduce<Cell[][]>((acc, cell, i) => (i % 2 ? acc[acc.length - 1]!.push(cell) : acc.push([cell]), acc), [])
    if (rows.length === 0) rows.push([])

    return (
      <Box flexDirection="column">
        {hint}
        <Box flexDirection="column" marginTop={1}>
          {rows.map((row, i) => (
            <Box key={row[0]?.key ?? 'tail'} flexDirection="row" columnGap={3} flexWrap="wrap">
              {row.map(cell => (
                <Box key={cell.key} flexDirection="row" columnGap={1}>
                  <Box width={LABEL_W}>
                    <Text dimColor>{cell.label}</Text>
                  </Box>
                  <Text>
                    <Text color={cell.tone}>{'█'.repeat(cells(cell.fill))}</Text>
                    <Text color="subtle">{'░'.repeat(CELLS - cells(cell.fill))}</Text>
                  </Text>
                  <Box width={VALUE_W} justifyContent="flex-end">
                    <Text color={cell.tone}>{cell.value}</Text>
                  </Box>
                  <Box width={DETAIL_W}>
                    <Text color={cell.detailTone} dimColor={!cell.detailTone}>{cell.detail}</Text>
                  </Box>
                </Box>
              ))}
              {tail && i === rows.length - 1 && (
                <Box key="cost" flexDirection="row" columnGap={1}>
                  <Text dimColor>cost</Text>
                  {tail.value !== '' && <Text color={tail.tone}>{tail.value}</Text>}
                  <Text>{tail.detail}</Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
