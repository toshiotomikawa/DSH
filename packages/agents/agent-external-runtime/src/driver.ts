/** External agent driver; the Host supplies the official adapter and tests supply simulations. @module */
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type AgentEventDispatch, type AgentHandle, type AgentOptions, type AgentStatus, type CancelOptions, type Inbox, type Model } from '@deepseek-ai/dsh-agent'
import type { AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { PersistentAgentId } from '@deepseek-ai/dsh-agent-registry'
import type { ExternalAgentActivation, PersistentAgentActivationInput } from '@deepseek-ai/dsh-agent-runtime'
import { assertNativeResumeHead } from '@deepseek-ai/dsh-agent-runtime'
import { createAssistantMessage, createSystemMessage, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import {
  appendPluginRecord, interruptedTurnClosers, pluginRecordOf, SessionId, SessionLogOffset,
  type Session, type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { SessionSidecar } from '@deepseek-ai/dsh-experimental-agent-external-runtime'
import type { AccountHarnessBinding, HarnessBindings } from './index.ts'
import type {} from '@deepseek-ai/dsh-agent-runtime/accounts'
import { openTurnBridge, type TurnToolBridge } from './bridge.ts'
import { HarnessBindingError } from './errors.ts'
import { ExternalQuotaError, ExternalQuotaState } from './quota.ts'

/** One fake-SDK turn. Tests replace {@link ExternalAgentActivationService.sdk}. */
export interface ExternalTurnInput {
  /** DSH conversation. */
  readonly sessionId: string
  /** Turn that owns this call. */
  readonly turn: number
  /** Step inside that turn. */
  readonly step: number
  /** Claimed inbox messages. */
  readonly messages: readonly UserMessage[]
  /** Profile instructions. Not a native system prompt. */
  readonly instructions: string
  /** Aborted by cancel. */
  readonly signal: AbortSignal
  /** Stable id for this Session, runtime and binding revision. */
  readonly sdkSessionId: string
  /** Model name stored for a later official adapter. */
  readonly runtimeModel: string | undefined
  /** Profile runtime. Both transports exist; the adapter picks one. */
  readonly runtime: 'claude-sdk' | 'codex-sdk'
  /** Step-local tool bridge. Closed when the step ends. */
  readonly tools: TurnToolBridge
  /** Session workspace. Absent on the recording fake. */
  readonly cwd?: string | undefined
  /** Bound harness directory. The adapter may put it in the child environment only. */
  readonly configDirectory?: string | undefined
}

/** Replacement for an official SDK. The default records text and calls nothing else. */
export interface ExternalSdk {
  /**
   * Run one step without a native provider.
   * @param input - claimed messages and the abort signal.
   * @returns assistant text and, when the adapter captured one, the official session id.
   */
  run(input: ExternalTurnInput): Promise<{ readonly text: string; readonly sdkSessionId?: string }>
}

const RECORD = 'plugin:agent-external-runtime/session' as const

/** Host service that publishes external agents. */
export class ExternalAgentActivationService implements ExternalAgentActivation {
  private closed = false
  private readonly pending = new Set<Promise<AgentHandle>>()
  private readonly owned = new Set<AgentHandle>()
  /** @param quota - persistent failure state and identity lease owner. @param teardownFailure - sanitized unload diagnostic. */
  constructor(readonly quota: ExternalQuotaState, private readonly teardownFailure: () => void) {}

  /** Drain pending admissions, cancel owned handles, and retain durable refusal on failed teardown. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.pending)
    await Promise.all([...this.owned].map(handle => handle.dispose().catch(() => { this.teardownFailure() })))
  }
  /** Explicit Host recovery; a consumer must authorize the profile before calling.
   * @param input - owning context and persistent profile.
   */
  async clearQuota(input: Pick<PersistentAgentActivationInput, 'ownerCtx' | 'agentId'>): Promise<void> {
    const profile = required(input.ownerCtx, 'persistentAgents').get(PersistentAgentId(input.agentId))
    await this.quota.clear(this.quota.key(profile.ownerId ?? 'owner', profile.id))
  }
  /** Turns the fake SDK accepted. A replaced `sdk` does not have to fill this. */
  readonly calls: ExternalTurnInput[] = []
  /** Step function installed by the Host composition before admission. */
  sdk!: ExternalSdk

  /**
   * Publish the external agent for one bound session.
   * @param input - owner, conversation and profile.
   * @returns the live handle after setup listeners finish.
   */
  async createOrResume(input: PersistentAgentActivationInput): Promise<AgentHandle> {
    if (this.closed) throw new Error('External runtime is closed')
    const operation = this.activate(input)
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    const handle = await operation
    if (this.closed) {
      await handle.dispose()
      throw new Error('External runtime is closed')
    }
    return handle
  }

  private async activate(input: PersistentAgentActivationInput): Promise<AgentHandle> {
    const host = input.ownerCtx
    const registry = required(host, 'persistentAgents')
    const profile = registry.get(PersistentAgentId(input.agentId))
    if (profile.runtime === 'native') throw new HarnessBindingError('runtime_native')
    const runtime = profile.runtime
    const metadata = registry.metadataOf(input.sessionId)
    const ownerId = metadata?.agentId === profile.id ? metadata.ownerId : profile.ownerId
    if (ownerId === undefined) throw new HarnessBindingError('owner_mismatch')
    if (metadata?.agentId !== profile.id) await registry.bind(input.sessionId, profile.id)
    const agentId = metadata?.agentId === profile.id ? metadata.agentId : profile.id
    const bindings = host.get('harnessBindings')
    if (bindings === undefined) throw new HarnessBindingError('binding_missing')
    const identity = { ownerId, agentId }
    const key = this.quota.key(ownerId, agentId)
    let release: () => void
    try {
      if (host.agents.list().some(agent => registry.metadataOf(agent.id)?.agentId === agentId)) throw new Error('External agent identity is still live')
      release = this.quota.acquire(key)
    }
    catch (error) {
      const refusal = await this.quota.get(key)
      if (refusal !== undefined) throw new ExternalQuotaError(refusal.resetAt, refusal.afterEffects, refusal.cause === 'teardown_failed')
      throw error
    }
    let published = false
    try {
      const refusal = await this.quota.get(key)
      let handle: AgentHandle
      if (refusal !== undefined) {
        if (refusal.cause !== 'quota_exhausted' || refusal.afterEffects || !profile.automaticFallback) {
          throw new ExternalQuotaError(refusal.resetAt, refusal.afterEffects, refusal.cause === 'teardown_failed')
        }
        // Revalidate identity, binding and route before invoking any native factory.
        await bindings.resolve(input.sessionId, workspacePath(host))
        const route = profile.reserves[0]
        if (route === undefined) throw new ExternalQuotaError(refusal.resetAt)
        const info = await host.llm.resolveModelInfo(route.provider, route.model)
        if (route.reasoningEffort !== undefined && !info.reasoning?.efforts.some(value => value.id === route.reasoningEffort)) throw new Error('Unsupported reserve reasoning effort')
        const agentOptions = { provider: route.provider, model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }) }
        const persistence = required(host, 'sessionPersistence')
        const stored = await persistence.stat(input.sessionId)
        // Old external logs never wrote the system head; a native turn would corrupt them.
        if (stored !== undefined) await assertNativeResumeHead(persistence, input.sessionId)
        handle = stored === undefined
          ? await host.agents.create({ sessionId: input.sessionId, agentOptions })
          : await host.agents.resume({ resumeSessionId: input.sessionId, agentOptions })
      } else {
        const stored = await required(host, 'sessionPersistence').stat(input.sessionId)
        handle = stored === undefined
          ? await this.openNew(host, input, bindings, runtime, profile.instructions, profile.runtimeModel, identity)
          : await this.openStored(host, input, bindings, runtime, profile.instructions, profile.runtimeModel, identity)
      }
      published = true
      let disposed: Promise<void> | undefined
      const owned: AgentHandle = { agent: handle.agent, dispose: () => disposed ??= (async () => {
        try {
          await handle.dispose()
          if ((await this.quota.get(key))?.cause === 'teardown_failed') throw new ExternalQuotaError(undefined, true, true)
        }
        catch (error) {
          await this.quota.refuse(key, { cause: 'teardown_failed', afterEffects: true })
          throw error
        }
        release()
        this.owned.delete(owned)
      })() }
      this.owned.add(owned)
      return owned
    } finally {
      if (!published) release()
    }
  }

  private async openNew(
    host: Context,
    input: PersistentAgentActivationInput,
    bindings: HarnessBindings,
    runtime: 'claude-sdk' | 'codex-sdk',
    instructions: string,
    runtimeModel: string | undefined,
    identity: { ownerId: string; agentId: string },
  ): Promise<AgentHandle> {
    const workspace = workspacePath(host)
    const binding = await bindings.resolve(input.sessionId, workspace)
    const session = required(host, 'sessions').prepare(input.sessionId, { meta: { cwd: workspace } })
    const writer = await required(host, 'sessionPersistence').create(session.header)
    try {
      return await this.publish(host, session, writer, binding, runtime, instructions, runtimeModel, false, identity)
    } catch (error) {
      await writer.close().catch(() => {})
      throw error
    }
  }

  private async openStored(
    host: Context,
    input: PersistentAgentActivationInput,
    bindings: HarnessBindings,
    runtime: 'claude-sdk' | 'codex-sdk',
    instructions: string,
    runtimeModel: string | undefined,
    identity: { ownerId: string; agentId: string },
  ): Promise<AgentHandle> {
    const writer = await required(host, 'sessionPersistence').open(input.sessionId, 'write')
    try {
      const cold = await writer.read(0)
      const closers = interruptedTurnClosers(cold.events)
      if (closers.length > 0) await writer.append(closers)
      const storedCount = cold.events.length + closers.length
      const session = required(host, 'sessions').prepare(input.sessionId, {
        seed: [...cold.events, ...closers],
        meta: structuredClone(writer.header),
        inheritedEventCount: writer.inheritedEventCount,
        eventState: cold.eventState,
      })
      // The resume marker is appended before store entry, so the live router never sees it.
      // oxlint-disable-next-line typescript/no-deprecated -- same stored-suffix read the native loop uses
      const suffix = session.snapshotEvents(SessionLogOffset(storedCount))
      if (suffix.length > 0) await writer.append(suffix)
      const workspace = session.header.cwd ?? workspacePath(host)
      const binding = await bindings.resolve(input.sessionId, workspace)
      return await this.publish(host, session, writer, binding, runtime, instructions, runtimeModel, true, identity)
    } catch (error) {
      await writer.close().catch(() => {})
      throw error
    }
  }

  private async publish(
    host: Context,
    session: Session,
    writer: SessionHandle,
    binding: AccountHarnessBinding,
    runtime: 'claude-sdk' | 'codex-sdk',
    instructions: string,
    runtimeModel: string | undefined,
    resumed: boolean,
    identity: { ownerId: string; agentId: string },
  ): Promise<AgentHandle> {
    const agent = new ExternalAgent(host, session, this, runtime, instructions, runtimeModel)
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    const fail = async (error: unknown): Promise<never> => {
      agent.closeAdmission()
      try { await agent.whenIdle() } catch { /* teardown still removes the registries */ }
      detachAgent?.()
      detachSession?.()
      await agent.scope.dispose()
      throw error
    }
    try {
      const sessions = required(host, 'sessions')
      detachSession = sessions.enter(session)
      sessions.announce(session)
      detachAgent = required(host, 'agents').enter(agent)
      await required(host, 'agents').announce(agent, resumed ? 'resume' : 'startup')
      const { ownerId, agentId } = identity
      const previous = sidecarOf(session)
      if (previous !== undefined) {
        // A native reserve has a different conversation. Never resume a stale SDK handle over its history.
        if (session.snapshotEvents().some(event => event.type === 'request/header')) throw new HarnessBindingError('binding_stale')
        if (previous.ownerId !== ownerId || previous.agentId !== agentId || previous.sessionId !== session.id) throw new HarnessBindingError('owner_mismatch')
        if (previous.runtime !== runtime || previous.revision !== binding.revision) throw new HarnessBindingError('binding_stale')
      } else if (resumed && hadTurn(session)) {
        throw new HarnessBindingError('binding_stale')
      }
      const sdkSessionId = previous?.sdkSessionId ?? `fake:${session.id}`
      if (previous === undefined) {
        appendPluginRecord(session, RECORD, {
          ownerId, agentId, sessionId: session.id, runtime, revision: binding.revision, sdkSessionId,
        })
      }
      agent.arm(sdkSessionId, ownerId, binding.configDirectory)
      const dispose = async (): Promise<void> => {
        agent.closeAdmission()
        agent.cancel({ kind: 'disposed' })
        await agent.whenIdle()
        detachAgent?.()
        detachSession?.()
        await writer.close()
        await agent.scope.dispose()
      }
      return { agent, dispose }
    } catch (error) {
      return fail(error)
    }
  }
}

function required<K extends string & keyof Context>(ctx: Context, name: K): Context[K] {
  const value = ctx.get(name)
  if (value === undefined) throw new HarnessBindingError('binding_missing')
  return value
}

function workspacePath(ctx: Context): string {
  // Read through a local shape. Intersecting Context would force every stub to
  // implement WorkspaceRegistry, and this package does not depend on it.
  const registry = (ctx as { workspaceRegistry?: { list?: () => readonly unknown[] } }).workspaceRegistry
  for (const item of registry?.list?.() ?? []) {
    if (typeof item !== 'object' || item === null || !('path' in item)) continue
    if (typeof item.path === 'string' && item.path.length > 0) return item.path
  }
  throw new HarnessBindingError('binding_missing')
}

function isSidecar(value: unknown): value is SessionSidecar {
  if (typeof value !== 'object' || value === null) return false
  const data = value as Record<string, unknown>
  return typeof data.ownerId === 'string'
    && typeof data.agentId === 'string'
    && typeof data.sessionId === 'string'
    && (data.runtime === 'claude-sdk' || data.runtime === 'codex-sdk')
    && typeof data.revision === 'number' && Number.isInteger(data.revision) && data.revision >= 1
    && typeof data.sdkSessionId === 'string' && data.sdkSessionId.length > 0
}

function sidecarOf(session: Session): SessionSidecar | undefined {
  let found: SessionSidecar | undefined
  // oxlint-disable-next-line typescript/no-deprecated -- seed plus live records; ownEvents drops the restored prefix
  for (const event of session.snapshotEvents()) {
    const record = pluginRecordOf(event)
    if (record?.type !== RECORD) continue
    if (!isSidecar(record.data)) throw new HarnessBindingError('binding_stale')
    found = record.data
  }
  return found
}

function hadTurn(session: Session): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- the restored prefix holds earlier turns
  for (const event of session.snapshotEvents()) if (event.type === 'turn/start') return true
  return false
}

interface Activity {
  abort: AbortController
  done: Promise<void>
  settle: () => void
  cause?: AgentCancelCause
  keepInbox?: boolean
}

class DurableInbox implements Inbox {
  private turn: UserMessage[] = []
  private step: UserMessage[] = []

  constructor(private readonly session: Session, private readonly dispatch: AgentEventDispatch) {
    // oxlint-disable-next-line typescript/no-deprecated -- restored splices are part of the seed
    for (const event of session.snapshotEvents()) this.fold(event)
  }

  get nextTurn(): readonly UserMessage[] { return this.turn }
  get nextStep(): readonly UserMessage[] { return this.step }

  clear(): void {
    this.splice('next-step', 0, this.step.length, [])
    this.splice('next-turn', 0, this.turn.length, [])
  }

  append(target: InboxTarget, message: UserMessage): void { this.splice(target, this.list(target).length, 0, [message]) }
  prepend(target: InboxTarget, message: UserMessage): void { this.splice(target, 0, 0, [message]) }

  replace(messageId: string, newMessage: UserMessage): boolean {
    return this.swap(messageId, [newMessage])
  }

  remove(messageId: string): boolean {
    return this.swap(messageId, [])
  }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    return this.edit(target, start, deleteCount, inserted, true)
  }

  /** Remove messages for a claim. A claim is an edit, not a canceled discard. */
  take(target: InboxTarget, turn: number, count: number): UserMessage[] {
    const removed = this.edit(target, 0, count, [], false)
    for (const message of removed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return removed
  }

  private edit(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const inbox = this.list(target)
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0 ? Math.max(inbox.length + offset, 0) : Math.min(offset, inbox.length)
    const truncatedDelete = Math.trunc(deleteCount)
    const actualDelete = Math.min(Math.max(Number.isNaN(truncatedDelete) ? 0 : truncatedDelete, 0), inbox.length - actualStart)
    if (actualDelete === 0 && inserted.length === 0) return []
    const removed = inbox.slice(actualStart, actualStart + actualDelete)
    const next = inbox.toSpliced(actualStart, actualDelete, ...inserted)
    this.assertIds(target, next)
    const discard = discardRemoved && actualDelete > 0
    this.session.append('agent/inbox/spliced', {
      target, start: actualStart,
      ...(actualDelete === 0 ? {} : { removedCount: actualDelete }),
      inserted,
      ...(discard ? { outcome: 'canceled' as const } : {}),
    })
    this.set(target, next)
    if (discard) for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    for (const message of inserted) this.dispatch.emit('agent/inbox/inserted', { message })
    return removed
  }

  private swap(messageId: string, inserted: UserMessage[]): boolean {
    for (const target of ['next-step', 'next-turn'] as const) {
      const index = this.list(target).findIndex(message => message.id === messageId)
      if (index >= 0) {
        this.splice(target, index, 1, inserted)
        return true
      }
    }
    return false
  }

  private list(target: InboxTarget): UserMessage[] {
    return target === 'next-turn' ? this.turn : this.step
  }

  private set(target: InboxTarget, messages: UserMessage[]): void {
    if (target === 'next-turn') this.turn = messages
    else this.step = messages
  }

  private assertIds(target: InboxTarget, next: readonly UserMessage[]): void {
    const ids = new Set<string>()
    const combined = target === 'next-turn' ? [...next, ...this.step] : [...this.turn, ...next]
    for (const message of combined) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
  }

  private fold(event: SessionEvent): void {
    if (event.type !== 'agent/inbox/spliced') return
    const splice = event.data
    const inbox = this.list(splice.target)
    const removed = splice.removedCount ?? 0
    this.set(splice.target, inbox.toSpliced(splice.start, removed, ...splice.inserted))
  }
}

class ExternalAgent implements Agent {
  readonly options: AgentOptions = {}
  readonly model: Model = {
    current: () => undefined,
    select: () => { throw new Error('External agent runtime refuses API model selection') },
  }

  readonly scope: Scope
  readonly ctx: Context
  readonly inbox: DurableInbox
  private readonly dispatch: AgentEventDispatch
  status: AgentStatus = 'idle'
  private admitted = true
  private published = false
  private pendingWake = false
  private activity: Activity | undefined
  private sdkSessionId = ''
  private ownerId = 'owner'
  private configDirectory = ''
  private sessionRecord: SessionSidecar = {
    ownerId: 'owner', agentId: '', sessionId: '', runtime: 'claude-sdk', revision: 1, sdkSessionId: '',
  }

  constructor(
    private readonly host: Context,
    readonly session: Session,
    private readonly activation: ExternalAgentActivationService,
    private readonly runtime: 'claude-sdk' | 'codex-sdk',
    private readonly instructions: string,
    private readonly runtimeModel: string | undefined,
  ) {
    this.scope = createScope(host, this)
    this.ctx = this.scope.ctx
    this.dispatch = agentEvents(host, this)
    this.inbox = new DurableInbox(session, this.dispatch)
  }

  get id(): SessionId { return this.session.id }

  /** Called after publication so a listener can queue work that starts immediately after. */
  arm(sdkSessionId: string, ownerId: string, configDirectory: string): void {
    this.sdkSessionId = sdkSessionId
    this.published = true
    this.ownerId = ownerId
    this.configDirectory = configDirectory
    // Publish appends the sidecar before arm, so the cast sees that record.
    this.sessionRecord = sidecarOf(this.session) as SessionSidecar
    this.scope.ctx.effect(() => this.host.on('accounts/ended', (accountId) => {
      if (accountId === ownerId) this.cancel({ kind: 'disposed' })
    }))
    this.wake()
  }

  closeAdmission(): void { this.admitted = false }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    const activity = this.activity
    if (activity?.cause !== undefined) return
    // Idle teardown must not drop a durable inject. A user cancel still does.
    const keep = options?.keepInbox === true || (activity === undefined && cause.kind === 'disposed')
    if (!keep) {
      this.inbox.clear()
      this.pendingWake = false
    }
    if (activity === undefined) return
    activity.cause = cause
    activity.keepInbox = options?.keepInbox === true
    activity.abort.abort()
  }

  whenIdle(): Promise<void> {
    const activity = this.activity
    if (activity === undefined) return Promise.resolve()
    return activity.done.then(() => this.whenIdle())
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.activity !== undefined) throw new Error('agent is busy')
    const activity = this.begin()
    return task(activity.abort.signal).finally(() => { this.finish(activity) })
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.inbox.append(target, message)
    if (!wakeup) return
    this.pendingWake = true
    this.wake()
  }

  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(message: UserMessage): void { this.send(message, 'next-step', false) }

  private begin(): Activity {
    const abort = new AbortController()
    let settle!: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })
    const activity: Activity = { abort, done, settle }
    this.activity = activity
    return activity
  }

  private finish(activity: Activity): void {
    this.activity = undefined
    if (this.admitted && this.pendingWake) this.wake()
    activity.settle()
  }

  private wake(): void {
    if (!this.published || !this.admitted || this.activity !== undefined || !this.pendingWake) return
    const activity = this.begin()
    void this.drive(activity)
  }

  private setStatus(status: AgentStatus): void {
    this.status = status
    this.dispatch.emit('agent/status', { status })
  }

  private async drive(activity: Activity): Promise<void> {
    this.setStatus('running')
    try {
      while (this.admitted && !activity.abort.signal.aborted && (this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0)) {
        this.pendingWake = false
        await this.oneTurn(activity)
      }
    } finally {
      this.setStatus('idle')
      this.finish(activity)
    }
  }

  private async oneTurn(activity: Activity): Promise<void> {
    const turn = this.nextTurn()
    const messages = [
      ...this.inbox.take('next-step', turn, this.inbox.nextStep.length),
      ...this.inbox.take('next-turn', turn, Math.min(1, this.inbox.nextTurn.length)),
    ]
    this.session.append('turn/start', { turn })
    let step = 0
    let opened = false
    try {
      let batch = messages
      while (batch.length > 0 && !activity.abort.signal.aborted) {
        step += 1
        opened = true
        this.session.append('step/start', { turn, step })
        // Native reserve turns can replace this head later without invalidating the durable surface.
        if (turn === 1 && step === 1) this.session.append('system/message', {
          turn, step, message: createSystemMessage(''),
        }, { surfaceOp: 'append' })
        for (const message of batch) this.session.append('user/message', message, { surfaceOp: 'append' })
        const bridge = await openTurnBridge({
          host: this.host, agent: this, ownerId: this.ownerId, turn, step,
          signal: activity.abort.signal, model: this.runtimeModel ?? 'external',
          onEnded: () => { this.cancel({ kind: 'disposed' }) },
        })
        try {
          const result = await this.activation.sdk.run({
            sessionId: this.session.id, turn, step, messages: batch, instructions: this.instructions,
            signal: activity.abort.signal, sdkSessionId: this.sdkSessionId, runtimeModel: this.runtimeModel,
            runtime: this.runtime, tools: bridge, cwd: this.session.header.cwd, configDirectory: this.configDirectory,
          })
          const captured = result.sdkSessionId
          if (captured !== undefined && captured.length > 0 && captured !== this.sdkSessionId && !captured.startsWith('fake:')) {
            const next = { ...this.sessionRecord, sdkSessionId: captured }
            appendPluginRecord(this.session, RECORD, next)
            this.sessionRecord = next
            this.sdkSessionId = captured
          }
          activity.abort.signal.throwIfAborted()
          this.session.append('assistant/message', {
            turn, step, stream: [],
            message: createAssistantMessage({
              content: [{ type: 'text', text: result.text }],
              source: { provider: 'external', model: this.runtimeModel ?? 'external' },
            }),
          }, { surfaceOp: 'append' })
          this.session.append('step/end', { turn, step })
          opened = false
          batch = this.inbox.nextStep.length === 0 ? [] : this.inbox.take('next-step', turn, this.inbox.nextStep.length)
        } finally {
          await bridge.close()
        }
      }
      if (activity.abort.signal.aborted) throw activity.abort.signal.reason
      this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    } catch (error) {
      if (opened) this.session.append('step/end', { turn, step })
      if (error instanceof ExternalQuotaError) {
        this.closeAdmission()
        // Persist before publishing turn/end: consumers may immediately settle and dispose.
        const key = this.activation.quota.key(this.ownerId, this.sessionRecord.agentId)
        // oxlint-disable-next-line typescript/no-deprecated -- includes this turn's tool events
        const effects = error.afterEffects || this.session.snapshotEvents().some(event => event.type === 'tool/call' && event.data.turn === turn)
        await this.activation.quota.refuse(key, {
          cause: error.teardownFailed ? 'teardown_failed' : activity.abort.signal.aborted ? 'aborted' : 'quota_exhausted', afterEffects: effects,
          ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }),
        })
        if (activity.abort.signal.aborted && !error.teardownFailed) {
          await this.activation.quota.refuse(key, { cause: 'aborted', afterEffects: effects })
        }
      }
      if (activity.abort.signal.aborted) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- cancel sets cause before abort
        this.session.append('turn/end', { turn, reason: { kind: 'aborted', reason: activity.cause! } })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.session.append('turn/end', { turn, reason: { kind: 'error', error: { message, code: error instanceof ExternalQuotaError ? error.code : 'UNKNOWN' } } })
    }
  }

  private nextTurn(): number {
    let turn = 0
    // oxlint-disable-next-line typescript/no-deprecated -- the seed holds earlier turns
    for (const event of this.session.snapshotEvents()) if (event.type === 'turn/start') turn = Math.max(turn, event.data.turn)
    return turn + 1
  }
}
