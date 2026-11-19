export type Window = { kind: string; percentUsed: number; resetsAt?: string }
/** `window` is the compaction window where known; `free` is what is left before auto-compaction, as /context's free space. */
export type Context = { tokens?: number; window: number; percent?: number; free?: number }
export type CacheTtl = '5m' | '1h'
/** `ttl` is absent where the provider reports no cache lifetime; `hit` is the last request's cache-hit share, 0 to 100. */
export type Cache = { at: number; ttl?: CacheTtl; hit: number }
/** Cost so far per pricing source (`config` or a preset id), and the source the last request went at. */
export type Spent = { totals: Record<string, number>; last: string }

declare module 'claude-code' {
  interface PluginState {
    'quota-left': {
      limits: Shaped<Window[]>
      now: number
      context: Shaped<Context | null>
      cache: Shaped<Cache | null>
      spent: Shaped<Spent | null>
      engineCost: number | null
      subscribed: boolean
    }
  }
}
