/** Chooses the native loop or the external driver for one persistent agent. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { PersistentAgentId } from '@deepseek-ai/dsh-agent-registry'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Caller-owned activation of one durable agent conversation. */
export interface PersistentAgentActivationInput {
  /** Context that owns the live handle. */
  readonly ownerCtx: Context
  /** DSH conversation to create or resume. */
  readonly sessionId: SessionId
  /** Persistent profile that owns the conversation. */
  readonly agentId: string
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
    return host.agents.resume({ resumeSessionId: input.sessionId, agentOptions })
  }
}
