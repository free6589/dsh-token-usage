/** Durable plugin state for the Token usage dashboard.

DSH 0.2.1 replaced `settings.register(ns, schema)` with a schema-derived Settings
form surface that belongs to the deployment profile, so a plugin no longer owns a
private settings namespace. Plugin-owned mutable state (user budgets and the
workbench ledger) therefore lives in a `ctx.storageDomain` domain: the spec below
is the single declaration of its identity, version, and record schemas.
*/

import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { MAX_ROUTE_BUDGETS, RouteBudgetSchema, type TokenUsageBudgetSettings } from './budget-settings.ts'
import { MAX_STATE_CHARS } from './workbench/schema.ts'

/** Table holding the workbench ledger blob under one fixed key. */
export const WORKBENCH_TABLE = 'workbench'
/** Sole record key of {@link WORKBENCH_TABLE}. */
export const WORKBENCH_KEY = 'state'

const budgetSchema = z.object({
  rolling30DayBudget: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  routeBudgets: z.array(RouteBudgetSchema).max(MAX_ROUTE_BUDGETS),
})

const workbenchSchema = z.object({ data: z.string().max(MAX_STATE_CHARS) })

/** The plugin's durable domain: user budgets (global slot) and the workbench blob (table). */
export const tokenUsageDomainSpec = defineDomain({
  name: 'token_usage',
  version: 1,
  global: {
    schema: budgetSchema,
    initial: { rolling30DayBudget: 0, routeBudgets: [] } satisfies TokenUsageBudgetSettings,
  },
  tables: {
    [WORKBENCH_TABLE]: domainTable(workbenchSchema),
  },
})

/** Durable state handle shared by the RPC surface and the workbench host. */
export interface TokenUsageStore {
  /** Current budgets, synchronously from the domain's in-memory state. */
  budget(): TokenUsageBudgetSettings
  /** Merge one validated patch into the budgets and persist the result. */
  updateBudget(patch: Partial<TokenUsageBudgetSettings>): Promise<void>
  /** Current workbench ledger blob; empty string when nothing was ever written. */
  workbench(): string
  /** Replace the workbench ledger blob durably. */
  setWorkbench(data: string): Promise<void>
}

/** Open the plugin domain and bind its lifetime to the plugin context. */
export async function openTokenUsageStore(ctx: Context): Promise<TokenUsageStore> {
  const domain: Domain<typeof tokenUsageDomainSpec> = await ctx.storageDomain.open(tokenUsageDomainSpec)
  ctx.effect(() => () => domain.close(), 'token usage: durable domain')
  const table = domain.table(WORKBENCH_TABLE)
  return {
    budget: () => domain.global.get(),
    async updateBudget(patch) {
      const next = { ...domain.global.get(), ...patch }
      await domain.global.set(next)
    },
    workbench: () => table.get(WORKBENCH_KEY)?.data ?? '',
    async setWorkbench(data) {
      await table.put(WORKBENCH_KEY, { data })
    },
  }
}
