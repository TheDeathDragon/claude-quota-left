import { expect, test } from 'claude-code/testing'

import { cacheText, cellsOf, contextLeft, engineSpend, filled, formatLeft, isPeak, nextCache, pricingFor, pricingOf, spendFrom, stepCost, timeLeft, usableUsd } from './register'

const PRICING = pricingOf({ priceCacheHit: 0.04, priceCacheMiss: 2, priceOutput: 8, offPeakRatio: 0.5, peakHours: '9-12,14-18', peakUtcOffset: 8, currency: '¥' })

const HINT = {
  plugin: 'quota-left',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' },
} as const

test('countdowns read in days, hours and minutes', async () => {
  expect(formatLeft(13 * 60_000)).toBe('13m')
  expect(formatLeft((2 * 60 + 13) * 60_000)).toBe('2h13m')
  expect(formatLeft((3 * 24 + 4) * 3_600_000)).toBe('3d4h')
  expect(formatLeft(-5_000)).toBe('0m')
})

test('a bar fills with what is used', async () => {
  expect(filled({ kind: 'five_hour', percentUsed: 23.5 })).toBe(2)
  expect(filled({ kind: 'five_hour', percentUsed: 100 })).toBe(10)
  expect(timeLeft({ kind: 'seven_day', percentUsed: 1, resetsAt: '2026-11-06T12:13:00Z' }, Date.parse('2026-11-06T10:00:00Z'))).toBe('resets in 2h13m')
})

test('the bars draw under the hint line once a reading lands', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>esc to interrupt</Text>
  })
  on('clock.now', () => ({ value: Date.parse('2026-11-06T10:00:00Z') }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  const before = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await before.find({ type: 'Text', text: /█/ })).toBe(undefined)
  await before.unmount()

  await $.session.measure({
    context: { percent: 10 } as never,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 30, resetsAt: '2026-11-06T12:13:00Z' },
      { kind: 'seven_day', percentUsed: 60, resetsAt: '2026-11-09T14:00:00Z' },
    ],
    changed: ['rateLimits'],
  })

  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /esc to interrupt/ }))?.text).toBe('esc to interrupt')
  expect((await ui.find({ type: 'Text', text: /2h13m/ }))?.text).toBe('resets in 2h13m')
  expect((await ui.find({ type: 'Text', text: /3d4h/ }))?.text).toBe('resets in 3d4h')
  expect((await ui.find({ type: 'Text', text: /^30%$/ }))?.text).toBe('30%')
  expect((await ui.find({ type: 'Text', text: /^60%$/ }))?.text).toBe('60%')
  await ui.unmount()
})

test('context shows what is left of the window', async () => {
  expect(contextLeft({ tokens: 76_000, window: 200_000, percent: 38 })).toBe('62% left (124k)')
  expect(contextLeft({ window: 200_000 })).toBe(undefined)
})

test('the cache countdown starts at the request and keeps the last lifetime on a read', async () => {
  const at = Date.parse('2026-11-06T10:00:00Z')
  const base = { input_tokens: 10, output_tokens: 5, model: 'm' }
  const wrote = nextCache({ ...base, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 }, at, null)
  expect(wrote).toEqual({ at, ttl: '1h', hit: 0 })
  const readOnly = nextCache({ ...base, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }, at + 60_000, wrote)
  expect(readOnly).toEqual({ at: at + 60_000, ttl: '1h', hit: 99 })
  expect(nextCache({ ...base, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, at + 120_000, readOnly)).toEqual(readOnly)
  expect(cacheText(readOnly!, at + 60_000 + 18 * 60_000)).toBe('expires in 42m')
  expect(cacheText(readOnly!, at + 60_000 + 3_600_000)).toBe('expired')
})

test('every cell fits the fixed columns, so the rows line up', async () => {
  const now = Date.parse('2026-11-06T10:00:00Z')
  const grid = cellsOf(
    [
      { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-11-07T09:59:00Z' },
      { kind: 'seven_day', percentUsed: 9, resetsAt: '2026-11-12T23:00:00Z' },
    ],
    { tokens: 0, window: 1_000_000, percent: 0 },
    { at: now, ttl: '1h', hit: 99 },
    now,
    { parts: [{ pricing: PRICING, total: 1234.5678 }] },
  )
  expect(grid.map(c => c.key)).toEqual(['five_hour', 'seven_day', 'ctx', 'cache', 'cost'])
  for (const c of grid) {
    expect(c.label.length <= 5).toBe(true)
    expect(c.value.length <= 4).toBe(true)
    expect(c.detail.length <= 16).toBe(true)
  }
})


test('peak follows the Beijing clock on weekdays, weekends off', async () => {
  // 2026-11-19 is a Thursday; Beijing 10:00 is 02:00 UTC.
  expect(isPeak(PRICING, Date.parse('2026-11-19T02:00:00Z'))).toBe(true)
  expect(isPeak(PRICING, Date.parse('2026-11-19T04:30:00Z'))).toBe(false)
  expect(isPeak(PRICING, Date.parse('2026-11-19T09:59:00Z'))).toBe(true)
  expect(isPeak(PRICING, Date.parse('2026-11-19T10:00:00Z'))).toBe(false)
  expect(isPeak(PRICING, Date.parse('2026-11-21T02:00:00Z'))).toBe(false)
})

test('a step costs hits, misses, writes and output at the rate of its hour', async () => {
  const u = { input_tokens: 100_000, cache_creation_input_tokens: 400_000, cache_read_input_tokens: 1_000_000, output_tokens: 250_000, model: 'm' }
  const peak = stepCost(PRICING, u, Date.parse('2026-11-19T02:00:00Z'))
  expect(Math.abs(peak - (0.04 + 0.5 * 2 + 0.25 * 8)) < 1e-9).toBe(true)
  const off = stepCost(PRICING, u, Date.parse('2026-11-21T02:00:00Z'))
  expect(Math.abs(off - peak / 2) < 1e-9).toBe(true)
})

test('the cost cell keeps the columns and says which rate is on', async () => {
  const now = Date.parse('2026-11-19T02:00:00Z')
  const [cell] = cellsOf([], null, null, now, { parts: [{ pricing: PRICING, total: 1.2345 }] })
  expect(cell).toEqual({ key: 'cost', label: 'cost', tone: 'warning', value: 'peak', detail: '¥1.23' })
  const [off] = cellsOf([], null, null, Date.parse('2026-11-21T02:00:00Z'), { parts: [{ pricing: PRICING, total: 0.01234 }] })
  expect(off!.value).toBe('off')
  expect(off!.detail).toBe('¥0.0123')
})

test('a flat price shows no peak marker and costs the same at every hour', async () => {
  const flat = pricingOf({ priceCacheHit: 0.3, priceCacheMiss: 3, priceOutput: 15 })
  const u = { input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, model: 'm' }
  expect(stepCost(flat, u, Date.parse('2026-11-19T02:00:00Z'))).toBe(3)
  expect(stepCost(flat, u, Date.parse('2026-11-21T02:00:00Z'))).toBe(3)
  const [cell] = cellsOf([], null, null, Date.parse('2026-11-19T02:00:00Z'), { parts: [{ pricing: flat, total: 3 }] })
  expect(cell!.value).toBe('')
  expect(cell!.detail).toBe('$3.00')
})

test('peak hours follow the configured UTC offset, not the machine clock', async () => {
  const utc = pricingOf({ priceCacheMiss: 2, offPeakRatio: 0.5, peakHours: '9-12', peakUtcOffset: 0 })
  expect(isPeak(utc, Date.parse('2026-11-19T10:00:00Z'))).toBe(true)
  expect(isPeak(PRICING, Date.parse('2026-11-19T10:00:00Z'))).toBe(false)
})

test('a provider that caches on its own shows the hit rate, never a made-up countdown', async () => {
  const at = Date.parse('2026-11-19T02:00:00Z')
  // As DeepSeek reports it through a gateway: reads, no writes, both lifetimes zero.
  const u = { input_tokens: 7094, cache_creation_input_tokens: 0, cache_read_input_tokens: 12288, output_tokens: 203, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0, model: 'cs/deepseek-v4-flash-vision-exp' }
  const c = nextCache(u, at, null)
  expect(c).toEqual({ at, hit: 63 })
  const [cell] = cellsOf([], null, c, at)
  expect(cell).toEqual({ key: 'cache', label: 'cache', fill: 63, tone: 'success', value: '63%', detail: 'hit rate' })
  expect(nextCache({ ...u, cache_read_input_tokens: 0 }, at + 1000, c)).toEqual({ at: at + 1000, hit: 0 })
})

test('a write with no lifetime reported counts as five minutes', async () => {
  const at = Date.parse('2026-11-19T02:00:00Z')
  const c = nextCache({ input_tokens: 10, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 1, model: 'claude-x' }, at, null)
  expect(c).toEqual({ at, ttl: '5m', hit: 0 })
})

test('DeepSeek flash is priced by its preset, with or without a gateway prefix', async () => {
  for (const model of ['deepseek-v4-flash-vision-exp', 'cs/deepseek-v4-flash-vision-exp', 'deepseek-flash']) {
    const p = pricingFor(undefined, model)
    expect(p?.source).toBe('deepseek-flash')
    expect(p?.pricing.currency).toBe('¥')
  }
  expect(pricingFor(undefined, 'claude-opus-5-5')).toBe(undefined)
  const own = pricingOf({ priceCacheMiss: 3, currency: '$' })
  expect(pricingFor(own, 'deepseek-v4-flash')?.source).toBe('config')
})

test("cost falls back to Claude Code's own ledger, unless it priced an unknown model", async () => {
  expect(usableUsd({ usd: 0.42 })).toBe(0.42)
  expect(usableUsd({ usd: 0.42, hasUnknownPrice: true })).toBe(null)
  const [cell] = cellsOf([], null, null, Date.parse('2026-11-19T02:00:00Z'), engineSpend(0.42))
  expect(cell!.detail).toBe('$0.4200')
  expect(cell!.value).toBe('')
  expect(engineSpend(null)).toBe(undefined)
})

test('totals keep one figure per pricing source, the last one setting the peak marker', async () => {
  const spend = spendFrom({ totals: { 'deepseek-flash': 1.5, config: 0.25 }, last: 'deepseek-flash' }, pricingOf({ priceCacheMiss: 3 }))
  expect(spend!.parts.map(p => p.pricing.currency)).toEqual(['$', '¥'])
  expect(spendFrom({ totals: { gone: 1 }, last: 'gone' }, undefined)).toBe(undefined)
})
