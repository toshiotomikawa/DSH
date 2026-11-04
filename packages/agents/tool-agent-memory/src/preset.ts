/** Preset row that binds each composed session to a durable agent. @module */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { PersistentAgentId } from '@deepseek-ai/dsh-agent-registry'
import type {} from '@deepseek-ai/dsh-agent-memory'

/** Cordis preset-row name. */
export const name = 'persistent-agent-persona'
/** Durable profile, essential memory and prompt services. */
export const inject = ['persistentAgents', 'agentMemory', 'systemPrompt']
/** The preset selects one stable agent identity. */
export interface Config {
  /** Stable identity selected by this preset row. */
  agentId: string
}
/** Loader validation for the selected id. */
export const Config: z<Config> = z.object({ agentId: z.string().required() })

/** Bind scoped sessions and contribute literal profile and memory text.
 * @param ctx - agent preset context.
 * @param config - durable agent id.
 */
export function apply(ctx: Context, config: Config): void {
  const id = PersistentAgentId(config.agentId)
  ctx.persistentAgents.get(id)
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    interpolate: false,
    text: () => {
      const profile = ctx.persistentAgents.get(id)
      return `${profile.name}\n${profile.title}\n${profile.description}\n${profile.instructions}`
    },
  }), 'persistentAgent.persona()')
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    await ctx.agentMemory.settled(context.agent?.id)
    const result = await next()
    const text = ctx.agentMemory.essential(id)
    return { ...result, sections: [...result.sections, { name: 'persistent-agent:memories', interpolate: false, text }] }
  })
  ctx.on('agent/created', async ({ agent }) => {
    const selection = await ctx.persistentAgents.selection(id)
    await ctx.persistentAgents.bind(agent.id, id)
    agent.model.select(selection)
  })
}
