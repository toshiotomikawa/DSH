# 持久智能体

[English](persistent-agents.md) | 中文

此可选能力提供 `ctx.persistentAgents` 和 `ctx.agentMemory`，不会修改上游默认配置。先加载存储、模型和会话服务，再全局加载 agent-registry、agent-memory 和 tool-agent-memory。省略的模型字段继承调用方指定的配置；主模型和备用模型都通过适配器目录验证。路由只保存提供方、模型和可选推理强度：原生循环没有账户选择器，因此账户标签会被拒绝，而不是保存后被静默丢弃。备用顺序和切换同意仅保存和显示，不自动切换；同意至少需要一个有效备用。

## 身份

邮箱和例程集成使用全局 agent-runtime：在注册表、记忆、agents 和 system-prompt 之后加载，在 agent-mailbox 和 agent-routine 之前加载。它提供真实目录和例程桥接，在创建会话之前绑定持久身份，并加载必要记忆。exec.agent.id 是会话标识，持久智能体标识通过注册表元数据解析。例程的日历提醒只负责记录投递；运行时在提供方调用之前取消承载会话，例程引擎独占执行接纳。普通日历提醒不受影响。

只有 `[SCHEDULE REMINDER]` 投递信封会取消承载会话；`[SCHEDULE CHANGE]` 通知不会取消智能体。例程引擎拥有其日历任务，普通日历编辑和清理会拒绝修改，并要求使用 `routine_update`，以保持 new 目标及三分钟的重复间隔下限。普通日历任务仍可正常编辑。

创建操作保存稳定标识、名称、职务、描述、指令、首个任务、头像、版本和可选 ownerId，不启动模型回合。更新要求当前版本；省略字段保持不变，批量更新逐项返回结果。权限管理不在 M6a 范围内。

在智能体预设中加载 `@deepseek-ai/dsh-tool-agent-memory/preset`，配置 agentId。该行按原文注入身份和必要记忆，在激活前验证模型，并持久绑定会话。通过 metadataOf(sessionId) 读取 agentId。绑定保存在 agents 域中，不更改上游会话头或日志格式。会话 id 以单射且路径安全的编码保存（`r-` 加已是安全小写的 id，其余为 `h-` 加十六进制），因此在大小写不敏感的文件系统上仅大小写不同的 id 仍指向不同文档。重命名不会改变标识和已有引用。M6b/M6c 负责消息和例程。

本地头像由现有 sharp 依赖解码，接受不超过 512 KiB 的 PNG、JPEG 和 WebP。图片与生成种子不能同时提供。无效更新保留旧头像。生成头像保存稳定种子供界面渲染。

## 记忆

remember、forget_memory、list_memories 和 search_memories 从调用会话确定所属智能体。list 提供带 nextCursor 的分页。进程内按不区分大小写的词搜索，再按匹配数、更新时间和标识排序，无匹配返回空数组。记忆始终是不可信数据，不授予权限。

maxMemories 默认为 256，maxMemoryBytes 和 essentialBytes 默认为 8192 UTF-8 字节。必要上下文预算包括完整序列化数据和警告。预算不足时操作明确失败，保留原文和原有选择；调用方可明确重试保存为可搜索记忆。降低限制也不删除数据；必要上下文超限会阻止激活，直到可信调用方调整选择。selectForUser 使用版本比较更新选择，可锁定选择使模型不能更改。

更改按当前回合暂存。现有 session/event 的 turn/end 提供 completed 结果，因此仅成功回合提交，取消、失败和会话释放丢弃暂存。每个智能体的完整记忆集合为一个 per-record 记录，使多项更新通过一次原子写入提交。集合版本防止并发回合相互覆盖；跨进程协调沿用 storage-domain 的限制。无法读取的已存记忆集合（JSON 损坏，或记录不符合 schema）在打开时被隔离：其文档留在磁盘上，其他智能体的集合照常打开，而该智能体的 search、list、essential、remember、forget 和 selectForUser 都会拒绝，直到有人恢复该文档。记忆绝不会以空集合打开，因此下一回合无法覆盖唯一的副本。

工具仅报告暂存。下一次提示组装等待已接纳的提交；提交失败会记录并向受影响会话报告一次，随后可重试。写入完成前进程崩溃可能丢失暂存更新，工具不会声称未确认的数据已持久化。消费者可调用 settled(sessionId) 等待结果。

## 验证

运行 `pnpm exec vitest run packages/agents`。Loader 测试通过 cordis.yml 加载真实插件、存储和智能体循环，仅模拟模型提供方。测试覆盖重开、验证、隔离、成功与取消回合、版本冲突、用户锁和预算限制，并对每个源文件要求 100% 覆盖率。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccounts--accounts"></a>

### `ctx.accounts` — `Accounts`

Account records and the hash-only entry credential of each account.

```ts cordis-catalog
/**
 * Create one active account and issue its entry token, which is returned once
 * and stored only as its SHA-256 hash.
 * @param displayName - name shown to people; another account may share it.
 * @param role - administrator or member.
 * @returns the stored account and the plaintext token, never readable again.
 */
async create(displayName: string, role: AccountRole = 'member'): Promise<{ account: Account; token: string }>

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
 * Resolve one presented entry token. Archived and disabled accounts prove nothing.
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
```

Types: [Agent](core.zh.md) · [SessionId](core.zh.md)

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

Types: [Agent](core.zh.md) · [SessionId](core.zh.md)

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

Types: [Agent](core.zh.md) · [SessionId](core.zh.md)

Source: [`packages/agents/agent-memory/src/index.ts`](../../packages/agents/agent-memory/src/index.ts)

<a id="ctxagentroutinebridge--routinebridge"></a>

### `ctx.agentRoutineBridge` — `RoutineBridge`

What the agent registry and the session layer provide to routines; supplied by the composition.

Source: [`packages/agents/agent-routine/src/index.ts`](../../packages/agents/agent-routine/src/index.ts)

<a id="ctxagentroutines--agentroutines"></a>

### `ctx.agentRoutines` — `AgentRoutines`

The `ctx.agentRoutines` service: opens the routine domain and wires the engine to the scheduler and web server.

Source: [`packages/agents/agent-routine/src/index.ts`](../../packages/agents/agent-routine/src/index.ts)

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

Types: [Agent](core.zh.md) · [ModelSelection](core.zh.md) · [SessionId](core.zh.md)

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
