import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TokenUsageBudgetSettings } from '../src/budget-settings.ts'
import type { TokenUsageStore } from '../src/store.ts'

/** In-memory stand-in for the plugin's durable domain, matching `TokenUsageStore`. */
export function fakeStore(initial = '', failWrites = false) {
  let data = initial
  let budget: TokenUsageBudgetSettings = { rolling30DayBudget: 0, routeBudgets: [] }
  const setWorkbench = vi.fn(async (next: string) => {
    if (failWrites) throw new Error('disk unavailable')
    data = next
  })
  const store: TokenUsageStore = {
    budget: () => budget,
    updateBudget: vi.fn(async (patch: Partial<TokenUsageBudgetSettings>) => { budget = { ...budget, ...patch } }),
    workbench: () => data,
    setWorkbench,
  }
  return { store, stored: () => data, setWorkbench }
}

/** In-memory stand-in for `ctx.storageDomain`, opening one fake domain per spec. */
export function fakeStorageDomain(options: { data?: string, budget?: TokenUsageBudgetSettings, failWrites?: boolean } = {}) {
  let data = options.data ?? ''
  let budget = options.budget ?? { rolling30DayBudget: 0, routeBudgets: [] }
  const put = vi.fn(async (_key: string, record: { data: string }) => {
    if (options.failWrites === true) throw new Error('disk unavailable')
    data = record.data
  })
  const domain = {
    name: 'token_usage',
    global: {
      get: () => budget,
      set: vi.fn(async (next: TokenUsageBudgetSettings) => { budget = next }),
    },
    table: () => ({ get: () => (data === '' ? undefined : { data }), put }),
    close: vi.fn(async () => {}),
  }
  return {
    service: { open: vi.fn(async () => domain) } as unknown as Context['storageDomain'],
    domain,
    put,
    stored: () => data,
    budget: () => budget,
  }
}

/** Adapt a test-owned read/write pair (and its spies) into a `TokenUsageStore`. */
export function storeFrom(handlers: { read: () => string, write: (data: string) => Promise<unknown> }): TokenUsageStore {
  return {
    budget: () => ({ rolling30DayBudget: 0, routeBudgets: [] }),
    updateBudget: async () => {},
    workbench: () => handlers.read(),
    setWorkbench: async (data: string) => { await handlers.write(data) },
  }
}
