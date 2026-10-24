# dsh-token-usage — DSH 0.1.2-rc.1 → 0.2.1-rc.2 API adaptation map

Target: locally installed `@deepseek-ai/dsh@0.2.1-rc.2`
(`/home/fish/.local/share/mise/installs/node/26.8.1/lib/node_modules/@deepseek-ai/dsh/`, verified `package.json` → `"version": "0.2.1-rc.2"`).

Sources of truth used below:

- Harness implementation checkout, tag `dsh-v0.2.1-rc.2`: `/home/fish/projects_mine/deepseek-harness` (read-only). Paths are relative to that root.
- Live install (the code that actually runs): the mise install above. Paths prefixed `$DSH`.
- Live profile: `DSH_HOME=/home/fish/dsh-layerfs`, so the running profile is
  `/home/fish/dsh-layerfs/profiles/web` (**not** `~/.dsh/profiles/web`).

Every claim carries `file:line`.

---

## 0. Executive summary

| # | 0.1.2-rc.1 usage | 0.2.1-rc.2 replacement |
|---|---|---|
| 1a | `ctx.settings.register(ns, schema)` for user-editable numbers | cordis `static Config` (schemastery) on the plugin entry + `constructor(ctx, config)`; the profile entry id **is** the settings namespace |
| 1b | `ctx.settings.register('token-usage-workbench', {data: string})` | `defineDomain` + `domainTable` (zod) + `ctx.storageDomain.open(spec)`; opaque blob → domain `global` or single-key table |
| 2 | — | `storage`, `storage-json`, `storage-domain` are all live in the web profile via `@deepseek-ai/dsh-base`; **only the json backend exists** (`dsh-storage-sqlite` is not installed) |
| 3 | session event `assistant/chunk` | durable `assistant/attempt` / `assistant/message` (`stream: AssistantStreamRecord[]`), plus host-side live event `agent/assistant-stream` (transient, carries `StreamChunk` incl. `{type:'usage'}`) |
| 4 | `createUserMessage({source:{kind:'plugin',plugin:…}})` | no catch-all `plugin` kind exists; declare your own kind via `interface MessageSourceMap` augmentation (base kinds: `user`, `model`, `tool`, `system-prompt`) |
| 5 | `ctx.sessions.open(id)` / `IconDataOutline16` | `ctx.uiWorkspace.openSession(id)`; icons are `IconDataOutlineRegular` / `IconDataOutlineMedium` (there is no bare `IconDataOutline` and no `IconDataOutline16`) |

---

## 1. `ctx.settings.register(ns, schema)` → two different mechanisms

### 1a. User-editable numbers (the token-usage budget) → plugin `Config`

`ctx.settings.register` does not exist in 0.2.1. The `settings` service is a *form/descriptor* layer over
**profile entry config**, not a registry of ad-hoc schemas:

- `packages/settings/settings/src/index.ts:41` — `interface Context { settings: SettingsForms }`
- `:223` — `export class SettingsForms extends Service`, `static inject = ['configEditor', 'profileContext']`
- `:266` — `configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void`
- `:302` — `describe(options?: SettingsDescribeOptions): SettingsDescriptor[]`
- `:342` — `/** Merge editable fields into an entry's config. @param ns Profile entry id. */` →
  `async update(ns: string, patch: object, expectedRevision?: number): Promise<void>`
- `:350` — `replace(ns, section, expectedRevision?)`, `:361` — `mutate(ns, ops, expectedRevision?)`

So the namespace is **the profile entry id**, and the schema is **the plugin's own cordis `Config`**.
Reference implementation of the exact pattern (a plugin with user-editable numbers):

- `packages/schedule/schedule/src/index.ts:102-105`
  ```ts
  static Config: z<Config> = z.object({
    deliveryHistoryDays: z.number().step(1).min(1).max(3650).default(30),
    deliveryHistoryRecords: z.number().step(1).min(1).max(3650).default(500),
  })
  ```
- `:119` — `constructor(ctx: Context, config: Config)`
- `:100` — `static inject = ['agents','sessions','storageDomain','sessionController','sessionPersistence']`

`z` here is **schemastery** (`@deepseek-ai/schemastery`), the cordis config dialect. It is *not* zod; zod is used
for storage record schemas (see 1b).

Migration shape for this plugin:

```ts
// src/index.ts
import { z } from '@deepseek-ai/schemastery'          // schemastery, not zod
import { Service } from '@deepseek-ai/cordis'

export const BUDGET_NAMESPACE = 'token-usage'          // == cordis.patch.yml entry id

export interface Config {
  rolling30DayBudget: number                            // 0 disables
  routeBudgets: { provider: string; model: string; rolling30DayBudget: number }[]
}

export default class TokenUsage extends Service {
  static inject = ['storageDomain', /* … */]
  static Config: z<Config> = z.object({
    rolling30DayBudget: z.number().min(0).default(0),
    routeBudgets: z.array(z.object({
      provider: z.string(),
      model: z.string(),
      rolling30DayBudget: z.number().min(1),
    })).default([]),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'tokenUsage')
    // read config here; do NOT call ctx.settings.register
  }
}
```

`cordis.patch.yml` in this workspace already inserts the entry as `id: token-usage`, so `describe()` will
report namespace `token-usage` and the Web Settings UI renders the fields from `static Config` automatically.

**When does a config edit take effect?** Settings edits are written into the profile patch and the loader
reconciles entries: the changed entry's fiber is stopped and re-created, then
`packages/boot/app-boot/src/index.ts:411` emits `'app-boot/config-reload'` (declared `:45-54`). Consequences:

- Read config **in the constructor**; the object is not mutated in place afterwards.
- Treat a config change as a plugin restart: persist nothing in memory that must survive it, and re-open the
  storage domain on every construction.
- `SettingsForms` only accepts *volatile* fields (`packages/settings/settings/src/index.ts:376-380` — `No configurable plugin entry "…"` / `Plugin entry "…" has no volatile fields` / `Config field "…" is not volatile`).

Host-side read/write from other code: `ctx.settingsController` (`packages/api/settings-controller/src/index.ts:63-66`,
`/** Host owner of the 'settings' Remote namespace. */ settingsController: SettingsController`). The Web client reaches
the same surface through the `settings` Remote namespace (`packages/client/ui-settings*`).

### 1b. Opaque durable blob (`token-usage-workbench { data: string }`) → `ctx.storageDomain`

The KV/domain stack is the only durable plugin-owned store in 0.2.1.

Facility (the service the plugin injects):

- `packages/storage/storage-domain/src/index.ts:40-44`
  ```ts
  declare module '@deepseek-ai/cordis' { interface Context { storageDomain: DomainFacility } }
  ```
- `:52` — `export const name = 'storage-domain'`; `:54` — `export const inject = ['storage']`
- `:100-109` — `async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>`

Spec builders (zod, from `zod`):

- `packages/storage/storage-domain/src/spec.ts:107` — `defineDomain<S extends DomainSpec>(spec: S): S`
- `:91` — `domainTable<K, V>(schema: ZodType<V>)`
- `:15-20` — `DomainGlobalSpec<G> { schema: ZodType<G>; initial: G }`
- `:35-72` — `DomainSpec { name, version, layout?, compatibleVersions?, invalidRecords?, global?, tables }`

Runtime handles:

- `packages/storage/storage-domain/src/domain.ts` — `DomainGlobal<G> { get(): G; set(value: G): Promise<void> }`,
  `KvTable<K, V> { get, entries, keys, size, put, delete, update }`,
  `Domain<S> { name, global, table(name), close() }`

Canonical in-tree example — `packages/schedule/schedule/src/storage.ts:57-60`:

```ts
export const scheduleDomain = defineDomain({
  name: 'schedule',
  version: 1,
  tables: { tasks: domainTable<ScheduleId, ScheduleTask>(scheduleTaskSchema) },
})
```
opened at `packages/schedule/schedule/src/index.ts:125` — `this.ready = ctx.storageDomain.open(scheduleDomain).then(…)`.

Migration shape for the workbench blob — model it as a **domain global** (one opaque JSON blob, schema must not
accept `null`; `defineDomain` rejects a nullable global schema) or, if you prefer the KV API, a single-key table:

```ts
// src/workbench/domain.ts
import { z } from 'zod'                                   // zod here, not schemastery
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const workbenchDomain = defineDomain({
  name: 'token-usage-workbench',
  version: 1,
  global: { schema: z.object({ data: z.string() }), initial: { data: '' } },
  // alternative: tables: { state: domainTable<WorkbenchKey, WorkbenchState>(stateSchema) }
})
```

```ts
// in the plugin constructor
const domain = await ctx.storageDomain.open(workbenchDomain)
const raw = domain.global.get().data                        // '' on first run
await domain.global.set({ data: JSON.stringify(next) })
```

Notes carried over from the current tree:

- `src/workbench/host.ts:35` (`ctx.settings.register('token-usage-workbench', storageSchema)`) is the line to delete.
  The comment already in `src/workbench/host.ts` — *"`store` supplies the domain-backed workbench record (DSH 0.2.1 has no
  per-plugin settings namespace to hold it)"* — is the correct reading of 0.2.1.
- Bump `version` and use `compatibleVersions` / `invalidRecords` for the existing `MAX_STATE_CHARS` +
  `migrateState` logic; the domain schema validates on read, so `migrateState` stays as the pre-parse step on
  `domain.global.get().data`.

---

## 2. Is `ctx.storageDomain` actually present in the running web profile? — **Yes**, json backend only

Bundle layer that installs it — `$DSH/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`:

```
175:    # Durable KV storage: the storage hub, the json backend, and the
179:    - id: storage
180:      name: '@deepseek-ai/dsh-storage'
182:    - id: storage-json
183:      name: '@deepseek-ai/dsh-storage-json'
185:        root: !!js dshHomePath('storages')
187:    - id: storage-domain
188:      name: '@deepseek-ai/dsh-storage-domain'
        config: backend: json
```

The running profile is `/home/fish/dsh-layerfs/profiles/web` (`DSH_HOME=/home/fish/dsh-layerfs`):

- `package.json` → `dsh.profile.bundles` starts with `"@deepseek-ai/dsh-base"`, `"@deepseek-ai/dsh-web-app"`, then the
  third-party bundles (`dsh-layerfs`, `@deepseek-ai/dsh-experimental-*`, `@nanmicoder/dsh-agent-teams`,
  `dsh-infinite-gen-5`, `dsh-web-mobile`, `dsh-workspace-mover`, `dsh-delete-session`, …).
- `cordis.yml` is `[]` (comment at top: the tree is composed as bundle patches, then `cordis.patch.yml`, then `--patch` overlays).
- `cordis.patch.yml` contains **zero** `storage` lines → nothing overrides or removes the dsh-base entries.
  The `dsh-layerfs` bundle patch contains zero `storage` lines too.
- Positive runtime proof: `$DSH_HOME/storages/` holds `workspace.json` and `session_projcache/` — live domains written by the
  json backend under `dshHomePath('storages')`.

Installed storage packages, `$DSH/node_modules/@deepseek-ai/`:

| package | present |
|---|---|
| `dsh-storage` | yes |
| `dsh-storage-json` | yes |
| `dsh-storage-domain` | yes |
| `dsh-storage-sqlite` | **no** |

`dsh-base/package.json` likewise lists `dsh-storage`, `dsh-storage-domain`, `dsh-storage-json` (plus `dsh-settings`,
`dsh-config-editor`, `dsh-token-meter`, `dsh-session-projection-cache`, `dsh-session-query-sqlite`) and **not**
`dsh-storage-sqlite`. So `config: backend: json` is the only viable backend; do not write `backend: sqlite`.

Also relevant: `session-projection-cache` runs with `writeEveryEvents: 200`, `writeIntervalMs: 5000`
(`dsh-base/cordis.patch.yml:192-199`) — that is the precedent for a write-batching policy on the workbench blob.

---

## 3. `assistant/chunk` is gone → durable `assistant/attempt`, live `agent/assistant-stream`

`assistant/chunk` is **not** in `KNOWN_SESSION_EVENT_TYPES` (`packages/core/session/src/known-event-types.ts:22-80`);
the union has `assistant/attempt`, `assistant/message`, `step/start`, `step/end`, `turn/start`, `turn/end`,
`tool/call`, `tool/result`, `request/header`. `assistant/chunk` only survives inside the format-migration packages
(`v0-to-v1` / `v1-to-v2`), i.e. as historical data, not as a live type.

**Durable replacement** — `packages/core/session/src/types.ts:356`:

```ts
'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] }
```

i.e. the whole stream (including `{type:'usage'}` chunks) is persisted once, on settlement, as
`assistant/message` **or** `assistant/attempt`. `src/projection.ts:341`
(`if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage')`) must switch to reading
`event.data.stream` and filtering `record.type === 'usage'`.

**Live (non-persisted) stream — host side, this is the one to use for throughput sampling:**

- `packages/core/agent/src/runtime-types.ts:363`
  ```ts
  'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void
  ```
  documented at `:357-361`: *"Process-local assistant-stream publication. Chunk frames are transient; the loop appends one
  final v2 `assistant/message` or `assistant/attempt` with the same stream before a committed end frame."*
- `AssistantStreamFrame` — `packages/core/agent/src/runtime-types.ts:128-150`:
  `{ type:'start', attemptId, revision, turn, step }` | `{ type:'chunk', attemptId, revision, index, time, chunk: StreamChunk }`
  | `{ type:'end', attemptId, revision, index, outcome }`
- Emitted by the loop at `packages/core/agent-loop/src/agent.ts:446-452` (`live.push(chunk)` for each streamed chunk).
- `StreamChunk` — `packages/llm/llm/src/types.ts:470-482`; the token payload is
  `:476` — `{ type: 'usage'; usage: TokenUsage }`, and `:465` states *"Adapters emit usage before the terminal finish"*,
  so a listener gets live usage without waiting for the turn to settle.
- In-tree consumers to copy from: `packages/api/session-controller/src/history.ts:54` and
  `packages/bundle/headless/src/index.ts:122`.

Migration shape:

```ts
ctx.on('agent/assistant-stream', ({ agent, frame }) => {
  if (frame.type !== 'chunk') return
  if (frame.chunk.type !== 'usage') return
  sample(agent.session.id, frame.attemptId, frame.time, frame.chunk.usage)
})
```

**Client-side variant** (only if the sample must be produced in the browser): the Web transport re-publishes the same
frames as `assistant/live-chunk` — `packages/api/session-controller/src/client/contract/events.ts:7-17`:

```ts
AssistantLiveChunkEvent { type: 'assistant/live-chunk'; seq: number; time: number;
  data: { attemptId: LlmAttemptId; turn: number; step: number; chunk: StreamChunk } }
```
with `SessionEventLike = SessionEvent | AssistantLiveChunkEvent` (`:20`) and settlement entries limited to
`assistant/message` | `assistant/attempt` (`:30-33`). Producer:
`packages/api/session-controller/src/client/sessions/assistant-stream.ts:87,157` (fractional `seq` to interleave with the
durable cursor). Host wire form: `SessionAssistantStreamFrame` (`packages/api/session-controller/src/types.ts:531-562`),
delivered only when the follow request sets `assistantStream?: true` (`:505-509`, `:578-581`).

**Host-side gap to be explicit about:** there is no host API that replays a *settled* attempt's stream outside the
durable record. For throughput you therefore have exactly two sources — live `agent/assistant-stream` frames, or the
persisted `assistant/attempt` / `assistant/message` `stream` array. Do not invent a third.

---

## 4. `source: { kind: 'plugin', plugin: … }` → declare your own `MessageSourceMap` kind

There is no shared catch-all `plugin` kind in 0.2.1, by design. `packages/llm/llm/src/message.ts:84-96`:

```
 * Where a message (or injected content) came from, in the harness's own
 * vocabulary. Merge-extensible sum type — each producer declares its own
 * `kind` in its own module; there is no shared catch-all `plugin` kind.
```
```ts
export interface MessageSourceMap {
  user: { kind: 'user' }
  model: ModelMessageSource
  tool: ToolMessageSource
  'system-prompt': SystemPromptMessageSource
}
```

- Base members: `user` (`:91`), `model` (`ModelMessageSource`, `:24-27`, `kind:'model'`),
  `tool` (`ToolMessageSource`, `:29-33`, `kind:'tool'`, `callId`), `system-prompt`
  (`SystemPromptMessageSource`, `:35-39`).
- `:117` — `export type MessageSource = MessageSourceMap[keyof MessageSourceMap]`, with the note at `:116`:
  *"switch on `kind` and fall through unknowns (merge-extensible)"*.
- `createUserMessage` — `packages/llm/llm/src/message.ts:246-255`:
  ```ts
  export function createUserMessage<T extends NewUserMessage>(
    input: T & { readonly id?: never; readonly role?: never },
  ): T & Pick<UserMessage, 'id' | 'role'>
  ```
  It accepts any `source` that satisfies `MessageSource`; a user message may carry *any* producer's kind (`:88-90`).

Augmentation precedent in-tree — `packages/api/session-controller/src/types.ts:412-419`:

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string; principal?: Principal }
  }
}
```

So replace all four sites (`src/trajectory-analysis.ts:112,167,366,693`, `src/usage-analysis.ts:143`) with:

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'token-usage': { kind: 'token-usage'; plugin: 'dsh-token-usage' }
  }
}
// …
createUserMessage({ content, source: { kind: 'token-usage', plugin: 'dsh-token-usage' } })
```

`ContextForm` (`:36-48`: `instructions` | `catalog` | `snapshot` | `notice` | `relay` | `recall`) and
`ContextFormed` (`:67-82`) are the orthogonal "what kind of thing is it" axis — optional, but a `notice` with a
bounded `summary` (`CONTEXT_SUMMARY_MAX_CHARS = 120`, `:103`) fits the injected analysis output best.

---

## 5. Client: `ctx.uiWorkspace.openSession` and the icon rename

### 5a. `ctx.sessions.open(id)` → `ctx.uiWorkspace.openSession(id)` — confirmed

- `packages/client/ui-conversation/src/client/apply.ts:114-116` declares the navigation capability every UI surface is
  handed: `interface WorkspaceNavigation { openSession(sessionId: SessionId): void }`, and `:440`
  `open: (id) => { workspaceNavigation.openSession(id) }`.
- Real call sites: `packages/client/ui-workspace/src/client/index.ts:157`,
  `packages/client/ui-schedule/src/client/index.ts:137`, `packages/client/ui-subagent/src/client/index.ts:62`,
  `packages/client/ui-chat/src/client/apply.ts:291`, `packages/client/ui-workflow-run/src/client/index.ts:34`.
- The `uiWorkspace` service itself is constructed at `packages/client/ui-workspace/src/client/index.ts:124`
  (`const uiWorkspace = new UiWorkspaceService(…)`), and the navigation record that injects it is
  `packages/client/ui-workspace/src/client/navigation.ts:137` (`uiWorkspace: UiWorkspace`).
- `ctx.sessions` is a **host** service (it is in `packages/schedule/schedule/src/index.ts:100`'s inject list, host side);
  there is no `sessions` member on the browser-side `Context`. So the edit in `src/client/index.ts:86` is a plain
  rename with no behavioural difference:
  ```ts
  openSession: (sessionId: SessionId) => { ctx.uiWorkspace.openSession(sessionId) },
  ```

### 5b. `IconDataOutline16` → **`IconDataOutlineRegular` / `IconDataOutlineMedium`** (not a bare `IconDataOutline`)

`packages/client/ui-primitives/src/icons/index.tsx`:

- `:1024` — `const IconDataOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (…)`
- `:1032` — `export const IconDataOutlineRegular = (props: IconProps) => …` (1px stroke)
- `:1037` — `export const IconDataOutlineMedium = (props: IconProps) => …` (1.3px stroke)
- re-exported from the package barrel: `packages/client/ui-primitives/src/index.ts:113` — `export * from './icons/index.tsx'`

There is **no** `IconDataOutline16` anywhere in the 0.2.1 source (it only survives as a test stub,
`packages/client/ui-primitives/tests/stubs/ui-primitives.tsx:15`), and **no** bare `IconDataOutline` export.
`size` is still a prop (`size = 16` default on the artwork). So `src/client/TokenThroughput.tsx:2,94` becomes:

```ts
import { IconDataOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// …
<IconDataOutlineRegular size={wide ? 16 : 18} />
```

Pick `…Regular` for parity with the old 1px `16` icon; `…Medium` if the panel wants the heavier stroke.

---

## 6. Adjacent renames already visible in this tree

- `webRuntime` no longer exists on the host context; the web bundle injects `webStartup` / `webServer`
  (`/home/fish/dsh-layerfs/profiles/web/connection-overlay.yml` overrides `connection` with
  `inject: [webStartup, webServer]`).
- `ctx.tokenMeter` exists (`packages/llm/token-meter/src/index.ts:94-96`, `:111` `super(ctx, 'tokenMeter')`) but rejects
  config wholesale (`TokenMeterConfig: unknown key "…" (no settings are supported)`) — do not try to configure it.
- `dsh-session-query-sqlite` is present as a dependency of `dsh-base`, but that is the *query* index, not a storage
  backend; it does not make `backend: sqlite` available to `storage-domain`.

---

## 7. Verification performed for this document

```
cat $DSH/package.json | grep '"version"'                       # 0.2.1-rc.2
grep -n "storage" $DSH/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml
ls -d $DSH/node_modules/@deepseek-ai/dsh-storage*              # storage, -domain, -json (no sqlite)
grep -n "storage" /home/fish/dsh-layerfs/profiles/web/cordis.patch.yml   # no matches
ls /home/fish/dsh-layerfs/storages                             # workspace.json, session_projcache/
grep -rn "IconDataOutline16" /home/fish/projects_mine/deepseek-harness/packages   # only a test stub
grep -rn "interface MessageSourceMap" -A8 packages --include=*.ts                # merge-extensible kind
```

`dsh --profile web --dump-config` was attempted for a fully composed tree dump; it fails read-only in this sandbox
(`EROFS … /home/fish/dsh-layerfs/profiles/web/cordis.yml`), so composition was established from the layer files
themselves plus the live `storages/` artifacts instead.

---

## 8. Implementation status (what the code does now)

| Map row | Shipped implementation |
|---|---|
| 1a/1b | Budgets and the workbench ledger live in **one** `ctx.storageDomain` domain, declared in `src/store.ts` (`defineDomain({ name: 'token_usage', version: 1, global: budgetSchema, tables: { workbench: domainTable(workbenchSchema) } })`). `src/index.ts` opens it inside the auxiliary plugin and hands a `TokenUsageStore` to the workbench host. |
| 3 | `src/projection.ts` folds `assistant/message.usage` and, for an attempt that never surfaced a message, the last usage record inside `assistant/attempt.stream`. A legacy `assistant/chunk` event is still tolerated for logs written by an earlier release, but the plugin neither produces nor requires it. |
| 4 | `src/message-source.ts` augments `MessageSourceMap` with `{ kind: 'token-usage-plugin' }`; both analysis modules pass `TOKEN_USAGE_SOURCE`. |
| 5 | `src/client/index.ts` injects `uiWorkspace` and calls `ctx.uiWorkspace.openSession(id)`; `src/client/TokenThroughput.tsx` renders `IconDataOutlineRegular`. |
| preset | `tsdown.config.ts` calls `clientBundle(PACKAGE_ROOT, ['src/index.ts'])` (0.2.1 signature is `(packageDir, libEntry, options?)`). |

### Deviation from row 1a, and why

Row 1a recommends cordis `static Config` (schemastery) for user-editable numbers. The 30-day budgets are edited
**from the plugin's own dashboard at runtime**, and the loader reacts to a settings edit by stopping and re-creating
the entry's fiber (`app-boot/src/index.ts:411` emits `app-boot/config-reload`). Routing every budget keystroke through
a plugin restart would drop the dashboard's in-flight RPC and re-warm every session projection. The budgets therefore
live in the storage domain, which is written asynchronously without restarting anything. Deployment-level defaults are
still expressible through the profile patch if a future release wants them; the domain is the source of truth today.

### Known gap: live (pre-settlement) throughput

`agent/assistant-stream` frames are the only non-persisted live usage source (row 3), and they are host-side. The
plugin does not subscribe to them yet, so the throughput indicators advance when a call settles rather than while it
streams. Wiring them means a host subscription that forwards usage frames over the existing RPC channel; it is a
follow-up, not a 0.2.1 blocker, and the numbers shown are always settled, Provider-confirmed values.

### Install (profile is read-only inside a session)

`dsh plugin --profile web add link:<repo>` needs a writable profile. With `DSH_HOME=/home/fish/dsh-layerfs` the
running profile is `/home/fish/dsh-layerfs/profiles/web`, which is mounted read-only for anything spawned by the
running web service (`EROFS … package.json.lock`). Run the install from a shell outside that service:

```bash
cd /home/fish/projects_mine/dsh-token-usage
scripts/install-local.sh            # links node_modules, builds lib/, then
                                    # symlinks + registers the bundle in $DSH_PROFILE_DIR
# or, equivalently, with the stock CLI:
dsh plugin --profile web add link:/home/fish/projects_mine/dsh-token-usage
```

Both paths must also add `dsh-token-usage` to `dsh.profile.bundles` in the profile's `package.json` (the CLI adds the
dependency, not the bundle entry). `scripts/install-local.sh` does both and keeps a timestamped backup.
