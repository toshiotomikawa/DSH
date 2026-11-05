# Persistent agents

English | [中文](persistent-agents.zh.md)

This optional fork capability adds `ctx.persistentAgents` and `ctx.agentMemory`. It leaves upstream profiles unchanged. Load `agent-registry` and `agent-memory` globally after storage, LLM and session services, then `tool-agent-memory` for the four model-facing tools. The registry inherits omitted model fields from the creator's supplied route and validates both primary and reserve models against the registered adapter catalog. A route stores only provider, model and optional reasoning effort: the native loop has no account selector, so an account label is rejected instead of saved and silently dropped. Reserve routes and automatic-fallback consent are saved and returned without switching models automatically; consent requires at least one valid reserve.

For mailbox and routine integration, load `agent-runtime` globally after the registry, memory, agents and system-prompt services, before `agent-mailbox` and `agent-routine`. It supplies the real directory and routine bridge, binds new mailbox and runner sessions before creation, and mounts the identity persona with essential memories. `exec.agent.id` is a session id; tools resolve its persistent owner through registry metadata. The scheduler's trusted reminder is only a delivery receipt for a routine: the runtime cancels its carrier before any provider call, and the routine engine alone admits the execution. Regular scheduler reminders retain their ordinary behavior.

Only the `[SCHEDULE REMINDER]` delivery envelope is a carrier; `[SCHEDULE CHANGE]` notices never cancel an agent. The routine engine owns its scheduler task, so generic calendar edits and cleanup reject with guidance to use `routine_update`. That path preserves target `new` and revalidates the three-minute recurrence floor. Ordinary scheduler tasks remain editable.

## Identity

Create profiles through `persistentAgents.create(fields, inheritedRoute)`. Read a profile before `update(id, expectedRevision, fields)`; omitted fields remain unchanged, including nested model fields. Updates use compare-and-set. `updateMany` returns a result or error for every input item. Profiles contain separate name, title, description, instructions and first-task fields, stable id, timestamps, revision, avatar and optional ownerId. Creation saves the first task without starting a model turn. Permission metadata identifies the deployment as the policy owner; this package does not claim to enforce a separate profile policy. Permission management is outside M6a.

Profiles may belong to one flat sidebar section owned by the same account. `listSections`, `createSection(name)`, `renameSection(id, name)`, `deleteSection(id)` and `assignSection(agentId, sectionId | null)` change only the grouping: profile id, instructions, conversations, memory and routines survive a move, and deleting a section leaves its agents ungrouped. Names are 1 to 40 characters; an unknown or foreign section id fails with the same `Unknown section` error. Sections never grant access, and the sidebar UI that renders them is deferred.

Explicit sharing is directional. The optional owners plugin provides `ctx.accountGrants` with `grant(ownerId, granteeId)`, `revoke` and `allows`. The persistent-agent directory and mailbox show another account's agents only when that account granted the caller, and interruption follows the same grant; same-owner calls need no grant. Grant creation has no tool or UI yet.

The optional `@deepseek-ai/dsh-tool-agent-memory/preset` row takes `{ agentId }` inside an agent preset. It injects literal profile text and essential memory data, validates the selected model before activation and binds the resulting session. `persistentAgents.metadataOf(sessionId)` exposes agentId and optional ownerId. These bindings live in the `agents` storage domain alongside profiles: no upstream Session header, event format or reader changes are needed. Session ids are stored under an injective, path-safe encoding (`r-` plus a lowercase-safe id, `h-` plus the hex form otherwise), so ids that differ only in case remain separate documents on case-insensitive filesystems. Renaming a profile leaves all bindings and id-based routine/message references intact. Mailbox and routine execution belong to M6b and M6c.

Local avatars are decoded by the installed sharp dependency. PNG, JPEG and WebP up to 512 KiB are accepted and stored as self-contained data. Supplying both an image path and a generation seed is rejected. A failed edit leaves the old avatar and the full profile intact. Generated avatar identity is a stable seed for a consumer to render.

## Memory

`remember`, `forget_memory`, `list_memories` and `search_memories` identify the owner from the exact live caller session, never from model arguments. `agentMemory.list` provides pages with an explicit nextCursor. Search matches case-insensitive terms in process, sorts by matched term count, update time and id, and returns an empty array when nothing matches. Stored text is data, never authority.

Configuration limits are maxMemories (256), maxMemoryBytes (8192 UTF-8 bytes) and essentialBytes (8192 UTF-8 bytes including the complete serialized context and warning). A full essential budget rejects the operation without changing saved text or inclusion; the caller may explicitly retry as searchable. It never evicts saved memories. Lowering a budget does not remove stored text; oversized essential context fails activation until a trusted consumer changes selection. `selectForUser` changes selection by revision and may lock it against model changes. It is not registered as a model tool.

Mutations are staged for the exact active turn. The existing `session/event` feed exposes `turn/end` with `reason.kind === 'completed'`, so no immediate-write deviation is necessary. Other turn outcomes and session disposal discard staging. Each agent's complete memory book is one per-record domain record, allowing a multi-memory turn to publish with one atomic write. A book-level revision prevents overlapping turns from replacing each other's changes. Both storage domains use per-record layout and inherit storage-domain's process-local coordination guarantee. A stored book that cannot be read (corrupt JSON, or a record that fails its schema) is quarantined at open: its document stays on disk, the other agents' books still open, and `search`, `list`, `essential`, `remember`, `forget` and `selectForUser` reject for that agent until a human restores the document. Memory is never opened as an empty book, so the next turn cannot overwrite the only copy.

The tools return staged results. After successful turn-end observation, the service queues the write; the next agent prompt waits for admitted commits. Commit failures are logged, retained for the affected session and surfaced once before retry. A crash before the queued write completes may lose that staged update; no unconfirmed tool result claims durability. A storage failure does not partially apply a book. `agentMemory.settled(sessionId)` lets a consumer await the write and observe a failure.

Profiles resolve an omitted `runtime` as `native`. `claude-sdk` and `codex-sdk` store a separate optional `runtimeModel`; it is retained but unused in native mode. External profiles skip validation of the unused primary API route, while every saved reserve remains validated and automatic fallback still requires explicit consent. `selection()` refuses external profiles before API activation; changing runtime never silently selects an API provider. The optional [external runtime configuration](../../packages/agents/agent-external-runtime/README.md) resolves private account harness directories.

## Verification

Run `pnpm exec vitest run packages/agents`. The Loader test boots the three plugins from test-only cordis.yml with real storage, sessions, tools and agent loop; only the provider is scripted. Tests cover profile reopen, avatar validation, model validation, partial updates, bindings, memory isolation, successful/cancelled turns, CAS conflicts, user locks, limits and literal prompt rendering. Coverage uses `pnpm exec vitest run packages/agents --coverage --coverage.include=packages/agents/*/src/**/*.ts` with the repository's per-file 100% thresholds.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccounts--accounts"></a>

### `ctx.accounts` — `Accounts`

Account records and the hash-only entry credential of each account.

```ts cordis-catalog
/**
 * Create one active account and issue its entry token. The token is written
 * once to a restricted file and only its SHA-256 hash is stored, so the
 * plaintext never enters the returned value, a Session log or a log line.
 * @param displayName - name shown to people; another account may share it.
 * @param role - administrator or member.
 * @returns the stored account and the absolute path of its token file.
 */
async create(displayName: string, role: AccountRole = 'member'): Promise<{ account: Account; tokenFile: string }>

/**
 * Read every account, oldest first.
 * @returns detached account records without any credential.
 */
list(): Account[]

/**
 * Read one account.
 * @param id - stable account id.
 * @returns detached account record.
 * @throws Error when no such account exists.
 */
get(id: string): Account

/**
 * Stop an active account from authenticating or acting.
 * @param id - stable account id.
 * @returns the disabled account.
 */
async disable(id: string): Promise<Account>

/**
 * Admit a disabled account again; its data and its token survive.
 * @param id - stable account id.
 * @returns the active account.
 */
async reactivate(id: string): Promise<Account>

/**
 * Archive an account instead of deleting it: the record and its data stay,
 * and the entry token is destroyed.
 * @param id - stable account id.
 * @returns the archived account.
 */
async archive(id: string): Promise<Account>

/**
 * Resolve one presented entry token. Every stored credential is compared so
 * a disabled account's token takes the same path as an unknown one. Archived
 * and disabled accounts prove nothing.
 * @param token - plaintext token from the connection.
 * @returns the active account, or undefined for an unknown, ended, or empty token.
 */
authenticate(token: string): Account | undefined

/**
 * Whether one active account may administer accounts.
 * @param id - stable account id.
 * @returns true only for an active administrator.
 */
isAdministrator(id: string): boolean

/** Drain the domain before releasing storage.
 * @returns after storage is closed.
 */
async close(): Promise<void>
```

Source: [`packages/agents/agent-runtime/src/accounts.ts`](../../packages/agents/agent-runtime/src/accounts.ts)

<a id="ctxagentdirectory--mailboxdirectory"></a>

### `ctx.agentDirectory` — `MailboxDirectory`

Minimal identity seam. The persistent-agent registry supplies the real implementation; this package never decides visibility or authority itself.

```ts cordis-catalog
/**
 * Identity of the authenticated live caller.
 * @param agent - the live caller.
 * @returns the target that identifies the caller.
 */
describe(agent: Agent): MailboxTarget

/**
 * Targets the caller may address, as a snapshot.
 * @param caller - the live caller.
 * @returns the visible targets.
 */
visible(caller: Agent): readonly MailboxTarget[]

/**
 * Any known target, used to route an already committed delivery.
 * @param agentId - stable agent id.
 * @returns the target, or undefined when unknown.
 */
find(agentId: string): MailboxTarget | undefined

/**
 * Whether the caller may interrupt this target.
 * @param caller - the live caller.
 * @param target - the agent to interrupt.
 * @returns true when the interruption is allowed.
 */
mayInterrupt(caller: Agent, target: MailboxTarget): boolean

/**
 * A fresh conversation bound to the same agent, optionally titled.
 * @param target - the agent that owns the conversation.
 * @param title - optional conversation title.
 * @returns the id of the new conversation.
 */
thread(target: MailboxTarget, title?: string): SessionId

/**
 * Bind an unopened conversation to its durable owner before factory setup.
 * @param target - the owning agent.
 * @param sessionId - the unopened conversation.
 */
prepare?(target: MailboxTarget, sessionId: SessionId): Promise<void>

/**
 * Whether the first agent may still address the second one right now. It is
 * asked again when a pending delivery is attempted and when a reply is
 * written, so a withdrawn permission cuts both. Omitted means always.
 * @param fromId - the agent that opened the relation.
 * @param toId - the agent it addresses.
 * @returns true when the relation is still allowed.
 */
reaches?(fromId: string, toId: string): boolean
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/agents/agent-mailbox/src/index.ts`](../../packages/agents/agent-mailbox/src/index.ts)

<a id="ctxagentmailbox--agentmailbox"></a>

### `ctx.agentMailbox` — `AgentMailbox`

Durable message store and delivery pump.

```ts cordis-catalog
/** Persist and accept one message, then schedule delivery.
 * @param caller - authenticated live agent.
 * @param input - message fields.
 * @returns acceptance receipt after persistence.
 */
async send(caller: Agent, input: SendInput): Promise<SendReceipt>

/** Retrato dos agentes visíveis, com execução, fila e pedidos pendentes.
 * @param caller - authenticated live agent.
 * @returns one summary per visible target.
 */
list(caller: Agent): AgentSummary[]

/** Request cancellation of the target's current turn.
 * @param caller - authenticated live agent seeking interruption.
 * @param agentId - stable target id.
 * @param sessionId - optional conversation already known for this target.
 * @returns whether a running turn was asked to stop.
 */
async interrupt(caller: Agent, agentId: string, sessionId?: SessionId): Promise<{ interrupted: boolean }>

/** Attempt every queued delivery now and wait for the pump.
 * @returns resolution after queued attempts settle.
 */
async flush(): Promise<void>

/** Wait for already scheduled delivery work without retrying the queue.
 * @returns resolution after the current chain drains.
 */
async settled(): Promise<void>

/** Record the exact turn that claimed one delivered message.
 * @param messageId - mailbox message id carried by the user message source.
 * @param sessionId - claiming conversation.
 * @param turn - claimed turn number.
 */
claimed(messageId: string, sessionId: SessionId, turn: number): void

/** Close the exact turn that claimed one delivery.
 * @param sessionId - conversation whose turn ended.
 * @param turn - exact turn.
 * @param aborted - true only when the turn was cancelled.
 */
settle(sessionId: SessionId, turn: number, aborted: boolean): void

/** Attempt queued deliveries when the plugin mounts. */
start(): void

/** Drain the pump, release opened agents, then close storage.
 * @returns resolution after teardown.
 */
async close(): Promise<void>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/agents/agent-mailbox/src/index.ts`](../../packages/agents/agent-mailbox/src/index.ts)

<a id="ctxagentmemory--agentmemory"></a>

### `ctx.agentMemory` — `AgentMemory`

Transaction owner for bounded, agent-isolated memory books.

```ts cordis-catalog
/** Await commits already admitted by the turn-end observer.
 * @returns resolution or the failed session's error when sessionId is supplied.
 * @param sessionId - optional failure to surface.
 */
async settled(sessionId?: SessionId): Promise<void>

/** Stage creation, correction or selection using a revision.
 * @param agent - live caller.
 * @param input - memory fields; omitted inclusion retains selection.
 * @param signal - optional caller cancellation.
 * @returns staged memory and whether inclusion fit the budget.
 */
async remember(agent: Agent, input: { text: string; id?: MemoryId; expectedRevision?: number; inclusion?: Memory['inclusion'] }, signal?: AbortSignal): Promise<{ memory: Memory; inclusionApplied: boolean }>

/** Stage explicit deletion with CAS.
 * @param agent - live caller.
 * @param id - memory id.
 * @param expectedRevision - current selection revision.
 * @param signal - optional caller cancellation.
 */
async forget(agent: Agent, id: MemoryId, expectedRevision: number, signal?: AbortSignal): Promise<void>

/** Search committed memories by term matches, recency and id.
 * @param id - persistent owner.
 * @param query - terms, case insensitive.
 * @param limit - result ceiling.
 * @param sessionId - live caller whose prepared changes are visible.
 * @returns matches; no matches is an empty array.
 */
async search(id: PersistentAgentId, query: string, limit: number = 20, sessionId?: SessionId): Promise<Memory[]>

/** Read a page without deleting excluded context.
 * @param id - persistent owner.
 * @param cursor - zero-based offset.
 * @param limit - page size.
 * @param sessionId - live caller whose prepared changes and commit failure surface.
 * @returns page and explicit next cursor, or null at the end.
 */
async list( id: PersistentAgentId, cursor: number = 0, limit: number = Math.min(50, this.limits.maxMemories), sessionId?: SessionId, ): Promise<{ memories: Memory[]; nextCursor: number | null }>

/** Render committed essential data literally, with an authority warning.
 * @param id - persistent owner.
 * @returns bounded data block or empty string.
 */
essential(id: PersistentAgentId): string

/** Change and optionally reserve inclusion through a trusted human-facing consumer, never a model tool.
 * @param agentId - owner.
 * @param id - selected memory.
 * @param expectedRevision - current revision.
 * @param inclusion - new selection.
 * @param userLocked - reserve future selection to the user.
 * @returns saved memory.
 */
async selectForUser(agentId: PersistentAgentId, id: MemoryId, expectedRevision: number, inclusion: Memory['inclusion'], userLocked: boolean): Promise<Memory>

/** Observe an exact turn settlement; failed or interrupted turns discard the entire staged book.
 * @param sessionId - conversation id.
 * @param turn - exact turn.
 * @param completed - true only for completed turn/end.
 */
end(sessionId: SessionId, turn: number, completed: boolean): void

/** Discard unfinished turns, drain admitted commits, then close storage. */
async close(): Promise<void>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/agents/agent-memory/src/index.ts`](../../packages/agents/agent-memory/src/index.ts)

<a id="ctxagentroutinebridge--routinebridge"></a>

### `ctx.agentRoutineBridge` — `RoutineBridge`

What the agent registry and the session layer provide to routines; supplied by the composition.

Source: [`packages/agents/agent-routine/src/index.ts`](../../packages/agents/agent-routine/src/index.ts)

<a id="ctxagentroutines--agentroutines"></a>

### `ctx.agentRoutines` — `AgentRoutines`

The `ctx.agentRoutines` service: opens the routine domain and wires the engine to the scheduler and web server.

Source: [`packages/agents/agent-routine/src/index.ts`](../../packages/agents/agent-routine/src/index.ts)

<a id="ctxagentsidebar--agentsidebar"></a>

### `ctx.agentSidebar` — `AgentSidebar`

Thin Remote adapter; the registry owns validation, isolation and persistence.

```ts cordis-catalog
/** List only display fields, never instructions or provider configuration.
 * @param signal - carrier cancellation.
 * @returns account-scoped agents and sections.
 */
@Remote list(signal: AbortSignal): AgentSidebarSnapshot

/** Create a section in the current account.
 * @param name - display name, 1 to 40 characters.
 * @returns resolves after the registry commits.
 */
@Remote async createSection(name: string): Promise<void>

/** Rename a section in the current account.
 * @param id - visible section id.
 * @param name - replacement display name.
 * @returns resolves after the registry commits.
 */
@Remote async renameSection(id: string, name: string): Promise<void>

/** Remove grouping while keeping agents and their conversations.
 * @param id - visible section id.
 * @returns resolves after the registry commits.
 */
@Remote async deleteSection(id: string): Promise<void>

/** Move an agent, or remove its grouping with null.
 * @param id - visible agent id.
 * @param sectionId - visible section id, or null to ungroup.
 * @returns resolves after the registry commits.
 */
@Remote async moveAgent(id: string, sectionId: string | null): Promise<void>
```

Source: [`packages/client/ui-sidebar/src/index.ts`](../../packages/client/ui-sidebar/src/index.ts)

<a id="ctxexternalagentactivation--externalagentactivation"></a>

### `ctx.externalAgentActivation` — `ExternalAgentActivation`

External plugin entry. The native loop must not implement this.

```ts cordis-catalog
/**
 * Publish the external agent for one bound session.
 * @param input - owner, conversation and profile.
 * @returns the live handle after the external driver is quiescent enough to accept work.
 */
createOrResume(input: PersistentAgentActivationInput): Promise<AgentHandle>
```

Types: [AgentHandle](core.md)

Source: [`packages/agents/agent-runtime/src/activation.ts`](../../packages/agents/agent-runtime/src/activation.ts)

<a id="ctxharnessbindings--harnessbindings"></a>

### `ctx.harnessBindings` — `HarnessBindings`

Immutable deployment bindings, resolved again against current identity on every activation.

```ts cordis-catalog
/** Resolve only the owner recorded by the registry and Session sidecar.
 * @param sessionId - durably bound DSH conversation.
 * @param workspace - actual workspace of the agent; overlapping harness folders are refused.
 * @returns detached private Host binding; never put it in a tool result or prompt.
 */
async resolve(sessionId: SessionId, workspace: string): Promise<AccountHarnessBinding>
```

Types: [SessionId](core.md)

Source: [`packages/agents/agent-external-runtime/src/index.ts`](../../packages/agents/agent-external-runtime/src/index.ts)

<a id="ctxpersistentagentactivation--persistentagentactivation"></a>

### `ctx.persistentAgentActivation` — `PersistentAgentActivation`

Persistent-agent entry used by mail and routines. Native profiles keep the registered loop. External profiles never enter it.

```ts cordis-catalog
/**
 * Publish an agent for a profile that is already bound to the session.
 * @param input - owner, conversation and profile.
 * @returns the live handle after setup listeners finish.
 */
createOrResume(input: PersistentAgentActivationInput): Promise<AgentHandle>
```

Types: [AgentHandle](core.md)

Source: [`packages/agents/agent-runtime/src/activation.ts`](../../packages/agents/agent-runtime/src/activation.ts)

<a id="ctxpersistentagents--persistentagents"></a>

### `ctx.persistentAgents` — `PersistentAgents`

Registry owning profiles and durable session-to-agent metadata.

```ts cordis-catalog
/** Create without starting a turn.
 * @param input - profile fields.
 * @param inherited - creator's selection.
 * @returns durable profile.
 */
async create(input: AgentPatch, inherited: AgentRoute): Promise<AgentProfile>

/** Read a detached profile.
 * @param id - stable id.
 * @returns profile; throws when absent.
 */
get(id: PersistentAgentId): AgentProfile

/** List detached configurations, including stored fallback order.
 * @returns all profiles.
 */
list(): AgentProfile[]

/** Compare-and-set a partial edit.
 * @param id - stable id.
 * @param expectedRevision - last read revision.
 * @param input - changed fields.
 * @returns saved profile.
 */
async update(id: PersistentAgentId, expectedRevision: number, input: AgentPatch): Promise<AgentProfile>

/** Edit each item independently.
 * @param edits - ids, revisions and partial edits.
 * @returns explicit per-item outcome.
 */
async updateMany( edits: readonly { id: PersistentAgentId; revision: number; patch: AgentPatch }[], ): Promise<({ id: PersistentAgentId; profile: AgentProfile } | { id: PersistentAgentId; error: string })[]>

/** Sidebar groups visible to the caller; membership never grants access.
 * @returns detached sections, oldest first.
 */
listSections(): AgentSection[]

/** Create one sidebar group for the authenticated account.
 * @param name - display name, 1 to 40 characters.
 * @returns the stored section.
 */
async createSection(name: string): Promise<AgentSection>

/** Rename one visible section; agent membership and profile ids do not change.
 * @param id - section id.
 * @param name - new display name, 1 to 40 characters.
 * @returns the stored section.
 */
async renameSection(id: string, name: string): Promise<AgentSection>

/** Delete one visible section; its agents survive and become ungrouped.
 * @param id - section id.
 * @returns the deleted id.
 */
async deleteSection(id: string): Promise<{ id: string }>

/** Move one visible agent into a section, or remove its grouping with null.
 * @param agentId - profile id.
 * @param sectionId - visible section id, or null to ungroup.
 * @returns the saved profile.
 */
async assignSection(agentId: PersistentAgentId, sectionId: string | null): Promise<AgentProfile>

/** Attach durable metadata without changing a Session header or its history.
 * @param sessionId - conversation id.
 * @param agentId - profile id.
 */
async bind(sessionId: SessionId, agentId: PersistentAgentId): Promise<void>

/** Read plugin-owned session metadata.
 * @param sessionId - conversation id.
 * @returns agentId and optional ownerId, or undefined.
 */
metadataOf(sessionId: SessionId): { agentId: PersistentAgentId; ownerId?: string | undefined } | undefined

/** Resolve the authenticated tool caller, never a model-supplied id.
 * @param agent - live caller.
 * @returns stable persistent id.
 */
of(agent: Agent): PersistentAgentId

/** Validate a selection again before session activation.
 * @param id - stable id.
 * @returns loop-compatible model selection.
 */
async selection(id: PersistentAgentId): Promise<ModelSelection>
```

Types: [Agent](core.md) · [ModelSelection](core.md) · [SessionId](core.md)

Source: [`packages/agents/agent-registry/src/index.ts`](../../packages/agents/agent-registry/src/index.ts)

<a id="accounts-events"></a>

### `accounts/*` events

<a id="accountsended--emit"></a>

#### `accounts/ended` — emit

One account may no longer authenticate or act, so its connections must end.

```ts cordis-catalog
/**
 * One account may no longer authenticate or act, so its connections must end.
 * @param accountId - stable id of the disabled or archived account.
 * @mode emit
 */
'accounts/ended'(accountId: string): void
```

Source: [`packages/agents/agent-runtime/src/accounts.ts`](../../packages/agents/agent-runtime/src/accounts.ts)

<a id="agent-routine-events"></a>

### `agent-routine/*` events

<a id="agent-routinereport--emit"></a>

#### `agent-routine/report` — emit

A routine produced a report for the user; consumers deliver it (inbox, mailbox, notification).

```ts cordis-catalog
/**
 * A routine produced a report for the user; consumers deliver it (inbox, mailbox, notification).
 * @param report - the report to deliver.
 * @mode emit
 */
'agent-routine/report'(report: RoutineReport): void
```

Source: [`packages/agents/agent-routine/src/index.ts`](../../packages/agents/agent-routine/src/index.ts)
<!-- END GENERATED cordis-surface -->
