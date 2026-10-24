/** Model-call attribution for the messages this plugin submits.

DSH 0.2.1 removed the catch-all `plugin` message source kind: `MessageSourceMap`
is merge-extensible and every producer declares its own `kind`. This module owns
the one kind this plugin needs so the analysis calls stay attributable in the
session log without impersonating a user or tool message.
*/

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A prompt this plugin submitted on the user's behalf (aggregate evidence only). */
    'token-usage-plugin': { kind: 'token-usage-plugin' }
  }
}

/** Source attached to every model call this plugin makes. */
export const TOKEN_USAGE_MESSAGE_SOURCE = { kind: 'token-usage-plugin' } as const
