/** Chooses the native loop or the external driver for one persistent agent. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { PersistentAgentId } from '@deepseek-ai/dsh-agent-registry'
import { isSurfaceEvent, type SessionId } from '@deepseek-ai/dsh-session'

/** Caller-owned activation of one durable agent conversation. */
export interface PersistentAgentActivationInput {
  /** Context that owns the live handle. */
  readonly ownerCtx: Context
  /** DSH conversation to create or resume. */
  readonly sessionId: SessionId
  /** Persistent profile that owns the conversation. */
  readonly agentId: string
}

/** Stored history that cannot accept a native turn; a new conversation is required. */
export class StoredConversationError extends Error {
  /** Stable failure identity for callers that branch on it. */
  readonly code = 'SURFACE_HEAD_MISSING'
  constructor() {
    super('Stored conversation has no native system head; start a new conversation')
    this.name = 'StoredConversationError'
  }
}

/**
 * Refuse a native turn over stored history that never wrote the protected
 * system head. External logs from before that head existed stay readable by
 * their own driver, but a native step would append a `system/message` after
 * the first user message and the next open would reject the log. Read-only.
 * @param persistence - stored-session backend.
 * @param sessionId - conversation that already exists.
 * @throws StoredConversationError when the first surface event is not the system head.
 */
export async function assertNativeResumeHead(
  persistence: Context['sessionPersistence'],
  sessionId: SessionId,
): Promise<void> {
  const handle = await persistence.open(sessionId, 'read')
  try {
    const head = (await handle.read(0)).events.find(isSurfaceEvent)
    if (head !== undefined && head.type !== 'system/message') throw new StoredConversationError()
  } finally {
    await handle.close()
  }
}

/**
 * Persistent-agent entry used by mail and routines.
 * Native profiles keep the registered loop. External profiles never enter it.
 */
export interface PersistentAgentActivation {
  /**
   * Publish an agent for a profile that is already bound to the session.
   * @param input - owner, conversation and profile.
   * @returns the live handle after setup listeners finish.
   */
  createOrResume(input: PersistentAgentActivationInput): Promise<AgentHandle>
}

/** External plugin entry. The native loop must not implement this. */
export interface ExternalAgentActivation {
  /** Explicit trusted Host recovery, after the caller authorizes the profile owner.
   * @param input - owning context and profile; a live handle forbids recovery.
   */
  clearQuota(input: Pick<PersistentAgentActivationInput, 'ownerCtx' | 'agentId'>): Promise<void>
  /**
   * Publish the external agent for one bound session.
   * @param input - owner, conversation and profile.
   * @returns the live handle after the external driver is quiescent enough to accept work.
   */
  createOrResume(input: PersistentAgentActivationInput): Promise<AgentHandle>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Activation port for persistent mail and routines. */
    persistentAgentActivation: PersistentAgentActivation
    /** Present only while the external-runtime plugin is loaded. */
    externalAgentActivation: ExternalAgentActivation
  }
}

/** Dispatches native sessions to the loop and external sessions to the plugin. */
export class PersistentAgentActivationService implements PersistentAgentActivation {
  /**
   * Publish a native loop session or the external driver.
   * @param input - owner, conversation and profile.
   * @returns the live handle after setup listeners finish.
   */
  async createOrResume(input: PersistentAgentActivationInput): Promise<AgentHandle> {
    const host = input.ownerCtx
    // Callers such as mail and routines do not inject every root service. get()
    // resolves the shared implementation; property access would refuse it.
    const registry = host.get('persistentAgents')
    if (registry === undefined) throw new Error('Persistent agent registry is unavailable')
    const agentId = PersistentAgentId(input.agentId)
    const profile = registry.get(agentId)
    if (profile.runtime !== 'native') {
      const external = host.get('externalAgentActivation')
      if (external === undefined) throw new Error('External agent runtime is unavailable')
      return external.createOrResume(input)
    }
    const agentOptions = await registry.selection(agentId)
    const persistence = host.get('sessionPersistence')
    if (persistence === undefined) throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    const stored = await persistence.stat(input.sessionId)
    if (stored === undefined) return host.agents.create({ sessionId: input.sessionId, agentOptions })
    await assertNativeResumeHead(persistence, input.sessionId)
    return host.agents.resume({ resumeSessionId: input.sessionId, agentOptions })
  }
}
