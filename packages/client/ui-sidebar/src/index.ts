/** Host companion: expose the account's persistent agent sidebar. */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the registry's Context augmentation. The deployment composes the plugin.
import type {} from '@deepseek-ai/dsh-agent-registry'
import { ownerIdOf, Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentSidebarSnapshot } from './types.ts'

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
      agents: registry.list().map(({ id, name, title, sectionId }) => ({ id, name, title, sectionId })),
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
