import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '../src/types.ts'
import {
  formatTokensPerSecond, smoothRate, THROUGHPUT_MIN_SPAN_MS, THROUGHPUT_SAMPLE_INTERVAL_MS,
  THROUGHPUT_WINDOW_MS, TokenThroughputController,
} from '../src/client/throughput-controller.ts'

/** Published values are exponentially blended at the shared five-second tau. */
const ALPHA_5S = 1 - Math.exp(-1)
/** A rate never divides by less than the warm-up span, so `delta / 10s` is the floor case. */
const SPAN_FLOOR_S = THROUGHPUT_MIN_SPAN_MS / 1_000
/** One windowed rate as the controller derives it: delta over the larger of elapsed and the span floor. */
function windowed(deltaTokens: number, elapsedMs: number): number {
  return deltaTokens / Math.max(elapsedMs / 1_000, SPAN_FLOOR_S)
}

function summary(id: string, output: number | undefined, builtInOutput?: number): SessionSummary {
  return {
    id: id as SessionSummary['id'],
    displayTitle: id,
    running: (output ?? builtInOutput ?? 0) > 0,
    blank: false,
    updatedAt: 0,
    projectionValues: {
      ...(output === undefined ? {} : { tokenUsageRecorder: {
        assistantRequests: 1,
        compactionRequests: 0,
        compactionUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usage: { uncachedInputTokens: 100, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
        models: [],
        days: [],
        modelDays: [],
      } }),
      ...(builtInOutput === undefined ? {} : {
        tokenUsage: {
          uncachedInputTokens: 1_000,
          outputTokens: builtInOutput,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
    },
  } as SessionSummary
}

function list(...summaries: SessionSummary[]): SessionListState {
  return {
    ids: summaries.map(value => value.id),
    byId: Object.fromEntries(summaries.map(value => [value.id, value])),
    current: summaries[0]?.id,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as SessionListState
}

afterEach(() => { vi.useRealTimers() })

function controllerFor(getState: () => SessionListState): TokenThroughputController {
  return new TokenThroughputController({ getSnapshot: getState, subscribe: () => () => {} })
}

describe('TokenThroughputController', () => {
  it('publishes one shared rolling output rate across sessions and prefers the recorder projection', () => {
    let state = list(summary('a', 0, 9_999), summary('b', 0))
    const controller = controllerFor(() => state)
    const listener = vi.fn()
    controller.subscribe(listener)

    controller.sample(0)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'sampling', allTokensPerSecond: 0, activeSessions: 0,
      statusBySession: { a: 'sampling', b: 'sampling' },
    })

    // The recorder projection wins over the built-in one (50, not 99_999 - 9_999).
    state = list(summary('a', 50, 99_999), summary('b', 20))
    controller.sample(5_000)
    const first = controller.getSnapshot()
    expect(first).toMatchObject({ status: 'ready', activeSessions: 2 })
    expect(first.bySession.a).toBe(windowed(50, 5_000))
    expect(first.bySession.b).toBe(windowed(20, 5_000))
    expect(first.allTokensPerSecond).toBeCloseTo(first.bySession.a + first.bySession.b, 6)

    // A second reading is blended towards its windowed value, never published raw.
    // The window baseline is still the sample at zero, so the span is 15 seconds
    // and the blend step is the full 10-second gap between samples.
    state = list(summary('a', 80), summary('b', 30))
    controller.sample(15_000)
    const second = controller.getSnapshot()
    const rawA = windowed(80, 15_000)
    const alpha10s = 1 - Math.exp(-2)
    expect(second.bySession.a).toBeCloseTo(first.bySession.a + alpha10s * (rawA - first.bySession.a), 6)
    expect(second.bySession.b).toBeCloseTo(windowed(30, 15_000), 6)
    expect(second.bySession.a).toBeLessThan(rawA)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('resets a regressed session baseline and decays the published rate', () => {
    let state = list(summary('a', 0))
    const controller = controllerFor(() => state)

    controller.sample(0)
    state = list(summary('a', 100))
    controller.sample(5_000)
    expect(controller.getSnapshot().bySession.a).toBe(windowed(100, 5_000))

    // A regressed counter starts a new epoch instead of reporting a negative rate.
    state = list(summary('a', 10))
    controller.sample(10_000)
    expect(controller.getSnapshot().bySession.a).toBe(0)
    expect(controller.getSnapshot().statusBySession.a).toBe('sampling')

    state = list(summary('a', 30))
    controller.sample(15_000)
    expect(controller.getSnapshot().bySession.a).toBe(windowed(20, 5_000))
    const settled = controller.getSnapshot().bySession.a

    // A frozen counter ages out of the window, so the rate decays towards zero.
    controller.sample(35_000)
    const decayed = controller.getSnapshot().bySession.a
    expect(decayed).toBeGreaterThan(0)
    expect(decayed).toBeLessThan(settled)

    // Nothing comparable is left inside the window: the session restarts sampling.
    controller.sample(THROUGHPUT_WINDOW_MS * 3)
    expect(controller.getSnapshot().bySession.a).toBe(0)
    expect(controller.getSnapshot().statusBySession.a).toBe('sampling')
  })

  it('starts a fresh baseline when the authoritative counter source changes', () => {
    let state = list(summary('a', undefined, 100))
    const controller = controllerFor(() => state)

    controller.sample(0)
    state = list(summary('a', 10, 110))
    controller.sample(5_000)
    expect(controller.getSnapshot().bySession.a).toBe(0)
    expect(controller.getSnapshot().statusBySession.a).toBe('sampling')

    state = list(summary('a', 30, 130))
    controller.sample(10_000)
    expect(controller.getSnapshot().bySession.a).toBe(windowed(20, 5_000))

    state = list(summary('a', undefined, 140))
    controller.sample(15_000)
    expect(controller.getSnapshot().bySession.a).toBe(0)
    expect(controller.getSnapshot().statusBySession.a).toBe('sampling')
    state = list(summary('a', undefined, 160))
    controller.sample(20_000)
    expect(controller.getSnapshot().bySession.a).toBe(windowed(20, 5_000))
  })

  it('requires a fresh per-session baseline after absence and reappearance', () => {
    let state = list(summary('a', 0))
    const controller = controllerFor(() => state)

    controller.sample(0)
    state = list()
    controller.sample(5_000)
    state = list(summary('a', 100))
    controller.sample(10_000)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'sampling',
      bySession: { a: 0 },
      statusBySession: { a: 'sampling' },
    })
    state = list(summary('a', 120))
    controller.sample(15_000)
    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().bySession.a).toBe(windowed(20, 5_000))
  })

  it('never reaches past the observation window after a suspended timer', () => {
    let state = list(summary('a', 0))
    const controller = controllerFor(() => state)

    controller.sample(0)
    state = list(summary('a', 100))
    controller.sample(THROUGHPUT_WINDOW_MS + 2_000)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'sampling',
      bySession: { a: 0 },
      statusBySession: { a: 'sampling' },
    })

    state = list(summary('a', 120))
    controller.sample(THROUGHPUT_WINDOW_MS + 7_000)
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', statusBySession: { a: 'ready' } })
    expect(controller.getSnapshot().bySession.a).toBe(windowed(20, 5_000))
  })

  it('treats ready list rows without Token projections as zero instead of blocking the aggregate', () => {
    let state = list(summary('a', 0), summary('b', undefined))
    const controller = controllerFor(() => state)

    controller.sample(0)
    state = list(summary('a', 50), summary('b', undefined))
    controller.sample(5_000)
    const snapshot = controller.getSnapshot()
    expect(snapshot).toMatchObject({ status: 'ready', statusBySession: { a: 'ready' } })
    expect(snapshot.bySession.a).toBe(windowed(50, 5_000))
    expect(snapshot.allTokensPerSecond).toBeCloseTo(snapshot.bySession.a, 6)
  })

  it('does not let hundreds of historical rows without Token projections strand global sampling', () => {
    const historical = Array.from({ length: 447 }, (_, index) => summary(`old-${index}`, undefined))
    let state = list(summary('active', 0), ...historical)
    const controller = controllerFor(() => state)

    controller.sample(0)
    state = list(summary('active', 25), ...historical)
    controller.sample(5_000)

    const snapshot = controller.getSnapshot()
    expect(snapshot).toMatchObject({ status: 'ready', activeSessions: 1, statusBySession: { active: 'ready' } })
    expect(snapshot.bySession.active).toBe(windowed(25, 5_000))
  })

  it('does not report an empty aggregate ready before session.list arrives', () => {
    const pending = { ...list(), phase: 'pending' as const }
    const controller = controllerFor(() => pending)

    controller.sample(0)
    controller.sample(5_000)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'sampling',
      allTokensPerSecond: 0,
      bySession: {},
    })
  })

  it('re-baselines instead of producing a spike when sample time regresses', () => {
    let state = list(summary('a', 0))
    const controller = controllerFor(() => state)

    controller.sample(10_000)
    state = list(summary('a', 50))
    controller.sample(15_000)
    expect(controller.getSnapshot().bySession.a).toBe(windowed(50, 5_000))
    state = list(summary('a', 100))
    controller.sample(11_000)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'sampling',
      allTokensPerSecond: 0,
      bySession: { a: 0 },
      statusBySession: { a: 'sampling' },
    })
    state = list(summary('a', 120))
    controller.sample(16_000)
    expect(controller.getSnapshot().bySession.a).toBe(windowed(20, 5_000))
  })

  it('includes a strict addressed session supplied outside session.list', () => {
    const controller = controllerFor(() => list())
    const usage = (outputTokens: number) => ({
      uncachedInputTokens: 0,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })

    let dispose = controller.setScopedCounter('child', undefined, usage(0))
    controller.sample(0)
    dispose()
    dispose = controller.setScopedCounter('child', undefined, usage(20))
    controller.sample(5_000)
    const snapshot = controller.getSnapshot()
    expect(snapshot).toMatchObject({ status: 'ready', statusBySession: { child: 'ready' } })
    expect(snapshot.bySession.child).toBe(windowed(20, 5_000))
    dispose()
  })

  it('owns and disposes its sampling timer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const controller = controllerFor(() => list(summary('a', 0)))
    const listener = vi.fn()
    controller.subscribe(listener)

    const dispose = controller.start()
    expect(listener).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(THROUGHPUT_SAMPLE_INTERVAL_MS)
    expect(listener).toHaveBeenCalledTimes(2)
    dispose()
    vi.advanceTimersByTime(THROUGHPUT_SAMPLE_INTERVAL_MS)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('blends a windowed rate with a time-aware exponential average', () => {
    expect(smoothRate(undefined, 40, 5_000)).toBe(40)
    expect(smoothRate(10, 10, 5_000)).toBe(10)
    expect(smoothRate(10, 0, 5_000)).toBeCloseTo(10 * (1 - ALPHA_5S), 6)
    expect(smoothRate(0, 100, 5_000)).toBeCloseTo(100 * ALPHA_5S, 6)
    // A shorter step moves the value less than a longer one.
    expect(smoothRate(0, 100, 1_000)).toBeLessThan(smoothRate(0, 100, 5_000))
    // A zero-length step adopts the new reading instead of dividing by zero.
    expect(smoothRate(7, 90, 0)).toBe(90)
  })

  it('turns one lump-sum settlement into an average instead of a spike', () => {
    let state = list(summary('a', 0))
    const controller = controllerFor(() => state)

    controller.sample(0)
    // One settled attempt reports all 3,000 output Tokens at a single instant.
    state = list(summary('a', 3_000))
    controller.sample(1_000)
    const lump = controller.getSnapshot().bySession.a
    // A one-second span would have published 3,000 tok/s; the span floor caps it.
    expect(lump).toBeCloseTo(3_000 / SPAN_FLOOR_S, 6)
    expect(lump).toBeLessThan(3_000)
  })

  it('converges on the true window average while output keeps flowing', () => {
    let state = list(summary('a', 0))
    const controller = controllerFor(() => state)
    controller.sample(0)
    // A steady 100 output Tokens per second for 40 seconds.
    for (let second = 1; second <= 40; second += 1) {
      state = list(summary('a', second * 100))
      controller.sample(second * 1_000)
    }
    const rate = controller.getSnapshot().bySession.a
    expect(rate).toBeGreaterThan(90)
    expect(rate).toBeLessThan(110)
  })

  it('formats dense rates without overstating low-rate precision', () => {
    expect(formatTokensPerSecond(7.56)).toBe('7.6')
    expect(formatTokensPerSecond(72.4)).toBe('72')
    expect(formatTokensPerSecond(1_250)).toBe('1.3K')
  })
})
