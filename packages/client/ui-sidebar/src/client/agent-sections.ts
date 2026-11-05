/** Register the sidebar's account-scoped resource and slot contribution. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/remote'
import type { AgentSidebarSnapshot } from '../types.ts'
import { AgentSections, type AgentSectionsInjected } from './AgentSections.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { 'agent-sidebar': AgentSidebarSnapshot }
}

/** Attach resource reads and registry commands to the owning plugin's lifetime.
 * @param ctx - client plugin context with remote services, resources and slots.
 */
export function registerAgentSections(ctx: Context): void {
  const api = ctx.remote.agentSidebar
  ctx.effect(() => ctx.resources.register({
    protocol: 'agent-sidebar',
    async *open(_address, { signal }) { yield await api.list(signal) },
  }), 'sidebar: agent resource')
  ctx.slots.inject('sidebar.agents', () => ctx.slots.register({
    name: 'sidebar.agents', locale: 'sidebar',
    inject: (): AgentSectionsInjected => ({
      mutate: (command) => {
        switch (command.kind) {
          case 'create': return api.createSection(command.name)
          case 'rename': return api.renameSection(command.id, command.name)
          case 'delete': return api.deleteSection(command.id)
          case 'move': return api.moveAgent(command.id, command.sectionId)
          case 'runtime': return api.setRuntime(command.id, command.revision, command.settings)
          case 'clearQuota': return api.clearQuota(command.id)
        }
      },
    }),
  }, AgentSections))
}
