import { z } from 'zod'

/** Namespace reported in budget RPC errors. */
export const TOKEN_USAGE_SETTINGS_NAMESPACE = 'token-usage'

/** Upper bound on exact-route budget rules a profile may persist. */
export const MAX_ROUTE_BUDGETS = 64

/** One exact-route rule, validated at the durable boundary. */
export const RouteBudgetSchema = z.object({
  provider: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  rolling30DayBudget: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})

/** One exact provider/model rolling-window Token budget. */
export interface TokenUsageRouteBudget {
  provider: string
  model: string
  /** Zero is never persisted; removing a rule disables its budget. */
  rolling30DayBudget: number
}

/** Persisted global and route-scoped rolling-window Token budgets. */
export interface TokenUsageBudgetSettings {
  /** Zero disables the global budget. */
  rolling30DayBudget: number
  /** Exact-route budgets evaluated only when date-by-model coverage is complete. */
  routeBudgets: TokenUsageRouteBudget[]
}
