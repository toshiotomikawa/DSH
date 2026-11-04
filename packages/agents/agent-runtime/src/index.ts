/** Connect durable agent identities to mailbox conversations and routine sessions. @module */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId, QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { PersistentAgentId } from '@deepseek-ai/dsh-agent-registry'
import type { MailboxDirectory, MailboxTarget } from '@deepseek-ai/dsh-agent-mailbox'
import type { Outcome, RoutineBridge } from '@deepseek-ai/dsh-agent-routine'
import type {} from '@deepseek-ai/dsh-schedule'
import * as Persona from '@deepseek-ai/dsh-tool-agent-memory/preset'

/** Loader plugin name. */
export const name = 'agent-runtime'
/** Services needed before exposing the directory and runner. */
export const inject = ['persistentAgents', 'agents', 'agentMemory', 'systemPrompt']

/** Same owner always; another owner only through its explicit grant. */
function sharedWith(ctx: Context, viewerId: string, ownerId: string): boolean {
  return ownerId === viewerId || ctx.get('accountGrants')?.allows(ownerId, viewerId) === true
}

/** Mount identity adapters; mailbox and routines may be mounted afterwards.
 * @param ctx - global persistent-agent composition.
 */
export function apply(ctx: Context): void {
  const owned = new Map<SessionId, AgentHandle>()
  const runs = new Map<SessionId, {
    handle: AgentHandle
    settle: (outcome: Outcome) => Promise<boolean>
    text: string[]
    effects: boolean
  }>()
  let closed = false
  const find = (id: string): MailboxTarget | undefined => {
    const profile = ctx.persistentAgents.list().find(entry => entry.id === id)
    if (!profile) return undefined
    return {
      id: profile.id, name: profile.name, title: profile.title, description: profile.description,
      sessionId: SessionId(`agent-${profile.id}`), model: {
        provider: profile.model.provider, model: profile.model.model,
        ...(profile.model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(profile.model.reasoningEffort) }),
      },
      ...(profile.ownerId === undefined ? {} : { ownerId: profile.ownerId }),
    }
  }
  const describe = (agent: Agent): MailboxTarget => {
    const id = ctx.persistentAgents.of(agent)
    // A binding can outlive an unreadable profile; never route it under another identity.
    const target = find(id)
    if (!target) throw new Error('Unknown persistent agent')
    return { ...target, sessionId: agent.id }
  }
  const directory: MailboxDirectory = {
    find, describe,
    visible: (caller) => {
      const sender = describe(caller)
      return ctx.persistentAgents.list().filter(profile => sharedWith(ctx, sender.ownerId ?? 'owner', profile.ownerId ?? 'owner'))
        .map(profile => find(profile.id)).filter(target => target !== undefined)
    },
    mayInterrupt: (caller, target) => {
      const sender = describe(caller)
      const found = find(target.id)
      return found !== undefined && sharedWith(ctx, sender.ownerId ?? 'owner', found.ownerId ?? 'owner')
    },
    reaches: (fromId, toId) => {
      const from = find(fromId)
      const to = find(toId)
      return from !== undefined && to !== undefined && sharedWith(ctx, from.ownerId ?? 'owner', to.ownerId ?? 'owner')
    },
    thread: () => SessionId(`agent-thread-${randomUUID()}`),
    prepare: async (target, sessionId) => { await ctx.persistentAgents.bind(sessionId, PersistentAgentId(target.id)) },
  }
  const bridge: RoutineBridge = {
    agents: (id) => { const target = find(id); return target === undefined ? undefined : { id: target.id, name: target.name, ownerId: target.ownerId ?? 'owner' } },
    agentOfSession: sessionId => ctx.persistentAgents.metadataOf(SessionId(sessionId))?.agentId,
    runner: {
      async start(input) {
        if (closed) throw new Error('Persistent agent runtime is closed')
        const routines = ctx.get('agentRoutines')
        if (!routines) throw new Error('Routine service is unavailable')
        const id = PersistentAgentId(input.agent.id)
        const selection = await ctx.persistentAgents.selection(id)
        const sessionId = SessionId(`agent-run-${randomUUID()}`)
        await ctx.persistentAgents.bind(sessionId, id)
        const handle = await ctx.agents.create({ sessionId, agentOptions: selection })
        owned.set(sessionId, handle)
        runs.set(sessionId, { handle, settle: outcome => routines.engine.settle(input.runId, outcome), text: [], effects: false })
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: input.prompt }], source: { kind: 'user' } }))
        // Return admission immediately. Awaiting idle here deadlocks the engine's serial settlement queue.
        return { sessionId }
      },
      cancel(id) {
        const agent = ctx.agents.get(SessionId(id))
        if (agent) agent.cancel({ kind: 'parent' })
        return Promise.resolve()
      },
    },
  }
  ctx.provide('agentDirectory', directory)
  ctx.provide('agentRoutineBridge', bridge)
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message.source.kind !== 'schedule') return
    const routines = ctx.get('agentRoutines')
    if (!routines) return
    const lines = message.content.flatMap(block => block.type === 'text' ? block.text.split('\n') : [])
    if (lines[0] !== '[SCHEDULE REMINDER]') return
    if (routines.engine.list().some(routine => routine.scheduleTaskId !== undefined
      && lines.includes(`schedule_id_json: ${JSON.stringify(routine.scheduleTaskId)}`))) {
      // The calendar only records delivery; the routine engine owns admission and the single model execution.
      agent.cancel({ kind: 'parent' })
    }
  })
  ctx.on('agent/created', async ({ agent }) => {
    const binding = ctx.persistentAgents.metadataOf(agent.id)
    if (!binding) return
    await agent.ctx.plugin(Persona, { agentId: binding.agentId })
    agent.model.select(await ctx.persistentAgents.selection(binding.agentId))
  })
  ctx.on('session/event', (session, event) => {
    const run = runs.get(session.id)
    if (!run) return
    if (event.type === 'tool/call') run.effects = true
    if (event.type === 'assistant/message') {
      run.text.push(...event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    }
    if (event.type !== 'turn/end') return
    runs.delete(session.id)
    let outcome: Outcome = event.data.reason.kind === 'completed'
      ? { kind: 'completed', text: run.text.join('\n') }
      : event.data.reason.kind === 'aborted' ? { kind: 'cancelled' }
        : { kind: 'failed', message: `Turn ended: ${event.data.reason.kind}` }
    if (event.data.reason.kind === 'error') {
      const failure = event.data.reason.error
      if ([QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE, 'RATE_LIMIT'].includes(failure.code) || failure.status === 429) {
        const delay = failure.providerRetryAfterMs
        const reset = new Date(Date.now() + (delay ?? 0))
        outcome = {
          kind: 'limit', message: failure.message, afterEffects: run.effects,
          ...(delay !== undefined && Number.isFinite(reset.getTime()) && delay > 0 ? { resetAt: reset.toISOString() } : {}),
        }
      } else if (failure.status === 401 || failure.status === 403) outcome = { kind: 'auth', message: failure.message }
      else outcome = { kind: 'failed', message: failure.message }
    }
    void (async () => {
      try {
        await run.settle(outcome)
      } finally {
        await run.handle.agent.whenIdle()
        await run.handle.dispose()
        owned.delete(session.id)
      }
    })().catch((error: unknown) => { ctx.logger.warn(`Routine settlement failed: ${String(error)}`) })
  })
  ctx.effect(() => async () => {
    closed = true
    for (const handle of owned.values()) await handle.dispose()
    owned.clear()
    runs.clear()
  })
}
