import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import * as SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Registry from '../src/index.ts'

export class Adapter extends MockAdapter {
  override async listModels(provider: string) { return [{ id: 'test', provider, name: 'Test' }] }
}
export async function harness(root: string, adapter = new Adapter([textResponse('ok')])) {
  const ctx = new Context()
  await ctx.plugin(Llm)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SessionStore)
  await ctx.plugin(ProjectionRegistry)
  await ctx.plugin(Prompt, { personaPrefix: 'Deployment' })
  await ctx.plugin(Tools)
  await ctx.plugin(Native)
  await ctx.plugin(Agents)
  await ctx.plugin(SessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'data') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const registryFiber = await ctx.plugin(Registry)
  return { ctx, registryFiber, adapter }
}
export async function live(ctx: Context, id: string, profileId: Registry.PersistentAgentId) {
  const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'test' } })
  await ctx.persistentAgents.bind(handle.agent.id, profileId)
  return handle.agent
}
export const inherited = { provider: 'mock', model: 'test' }
