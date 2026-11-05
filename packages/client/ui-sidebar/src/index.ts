/** Host companion: expose the account's persistent agent sidebar. */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the registry's Context augmentation. The deployment composes the plugin.
import type {} from '@deepseek-ai/dsh-agent-registry'
import { ownerIdOf, Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentSidebarSnapshot, AgentRuntimeSettings } from './types.ts'
import type {} from '@deepseek-ai/dsh-agent-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context { agentSidebar: AgentSidebar }
}

/** Thin Remote adapter; the registry owns validation, isolation and persistence. */
export class AgentSidebar extends TypertRemoteService {
  static inject = ['persistentAgents', 'typert']

  /** @param ctx - host plugin context with the shared registry. */
  constructor(ctx: Context) { super(ctx, 'agentSidebar') }

  private account(): Context {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('Agent sidebar requires an authenticated invocation')
    // The local owner's sidebar is account-scoped too, unlike trusted host registry administration.
    return this.ctx.extend({ invocation: {
      ...invocation,
      peer: { ...invocation.peer, principal: { kind: 'account', ownerId: ownerIdOf(invocation) } },
    } })
  }

  /** List only display fields, never instructions or provider configuration.
   * @param signal - carrier cancellation.
   * @returns account-scoped agents and sections.
   */
  @Remote
  list(signal: AbortSignal): AgentSidebarSnapshot {
    signal.throwIfAborted()
    const registry = this.account().persistentAgents
    return {
      agents: registry.list().map(({ id, name, title, sectionId, revision, runtime, runtimeModel, automaticFallback }) =>
        ({ id, name, title, sectionId, revision, runtime, runtimeModel, automaticFallback })),
      sections: registry.listSections().map(({ id, name }) => ({ id, name })),
    }
  }

  /** Create a section in the current account.
   * @param name - display name, 1 to 40 characters.
   * @returns resolves after the registry commits.
   */
  @Remote
  async createSection(name: string): Promise<void> { await this.account().persistentAgents.createSection(name) }

  /** Rename a section in the current account.
   * @param id - visible section id.
   * @param name - replacement display name.
   * @returns resolves after the registry commits.
   */
  @Remote
  async renameSection(id: string, name: string): Promise<void> { await this.account().persistentAgents.renameSection(id, name) }

  /** Remove grouping while keeping agents and their conversations.
   * @param id - visible section id.
   * @returns resolves after the registry commits.
   */
  @Remote
  async deleteSection(id: string): Promise<void> { await this.account().persistentAgents.deleteSection(id) }

  /** Move an agent, or remove its grouping with null.
   * @param id - visible agent id.
   * @param sectionId - visible section id, or null to ungroup.
   * @returns resolves after the registry commits.
   */
  @Remote
  async moveAgent(id: string, sectionId: string | null): Promise<void> {
    const registry = this.account().persistentAgents
    const agent = registry.list().find(profile => profile.id === id)
    if (agent === undefined) throw new Error(`Unknown persistent agent: ${id}`)
    await registry.assignSection(agent.id, sectionId)
  }

  /** Save an owned profile's runtime with compare-and-set; active identities must be stopped first.
   * @param id - account-owned profile.
   * @param revision - last observed profile revision.
   * @param settings - runtime, optional harness model and explicit reserve consent.
   */
  @Remote
  async setRuntime(id: string, revision: number, settings: AgentRuntimeSettings): Promise<void> {
    const account = this.account()
    const profile = account.persistentAgents.list().find(agent => agent.id === id)
    if (profile === undefined) throw new Error('Unknown persistent agent')
    if (account.agents.list().some(agent => account.persistentAgents.metadataOf(agent.id)?.agentId === id)) {
      throw new Error('Stop this agent before changing its runtime')
    }
    await account.persistentAgents.update(profile.id, revision, {
      runtime: settings.runtime, runtimeModel: settings.runtimeModel, automaticFallback: settings.automaticFallback,
    })
  }

  /** Clear only an owned profile's refusal; the external service rejects live handles.
   * @param id - account-owned profile.
   */
  @Remote
  async clearQuota(id: string): Promise<void> {
    const account = this.account()
    const profile = account.persistentAgents.list().find(agent => agent.id === id)
    if (profile === undefined) throw new Error('Unknown persistent agent')
    const external = account.get('externalAgentActivation')
    if (external === undefined) throw new Error('External runtime is unavailable')
    await external.clearQuota({ ownerCtx: account, agentId: profile.id })
  }
}

/** Host services needed by the Remote adapter; the deployment composes the registry. */
export const inject = ['persistentAgents', 'typert']

/** Mount the adapter over the registry the deployment already composed.
 * @param ctx - host plugin context.
 * @returns resolves when the adapter is active.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(AgentSidebar)
}
