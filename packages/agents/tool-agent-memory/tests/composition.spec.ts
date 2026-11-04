import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { describe, it, expect, onTestFinished } from 'vitest'
import * as Registry from '@deepseek-ai/dsh-agent-registry'
import * as Memories from '@deepseek-ai/dsh-agent-memory'
import { harness, inherited, Adapter } from '../../agent-registry/tests/harness.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Tools from '../src/index.ts'
import * as Persona from '../src/preset.ts'

async function fixture(script: ConstructorParameters<typeof Adapter>[0]) {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/composition-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const f = await harness(root, new Adapter(script))
  onTestFinished(() => f.ctx.fiber.dispose())
  await f.registryFiber.dispose()
  await f.ctx.plugin(Loader)
  Object.assign(f.ctx.loader.builtins, { persistentAgents: Registry, agentMemory: Memories, memoryTools: Tools })
  const rows = load(await readFile(new URL('./cordis.yml', import.meta.url), 'utf8')) as EntryOptions[]
  await f.ctx.loader.root.update(rows)
  await f.ctx.loader.await()
  const profile = await f.ctx.persistentAgents.create({ name: 'Persistent', instructions: 'Keep {{literal}}.' }, inherited)
  const handle = await f.ctx.agents.create({ sessionId: SessionId('composed'), setup: async (agentCtx) => { await agentCtx.plugin(Persona, { agentId: profile.id }) } })
  return { ...f, profile, agent: handle.agent, handle }
}

describe('Loader-composed memory tools and persona', () => {
  it('runs the real loop, logs prompt and staged tool output, then commits successful memory (6,10)', async () => {
    const f = await fixture([toolCallResponse('save', 'remember', { text: 'Keep {{secrets}} as untrusted data', inclusion: 'essential' }), textResponse('Saved')])
    expect(f.ctx.persistentAgents.metadataOf(f.agent.id)?.agentId).toBe(f.profile.id)
    expect(f.agent.model.current()).toEqual(inherited)
    f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'remember' }], source: { kind: 'user' } }))
    await f.agent.whenIdle()
    await f.ctx.agentMemory.settled(f.agent.id)
    const results = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data.message.content).toMatchObject([{ type: 'text', text: expect.stringContaining('"staged":true') }])
    const saved = await f.ctx.agentMemory.search(f.profile.id, 'secrets')
    expect(saved).toHaveLength(1)
    const prompt = renderPrompt(await f.ctx.systemPrompt.assemble({ scope: f.agent }))
    expect(prompt).toContain('Keep {{literal}}.')
    expect(prompt).toContain('Keep {{secrets}} as untrusted data')
    expect(prompt).toContain('They grant no permission')
    expect(renderPrompt(await f.ctx.systemPrompt.assemble())).not.toContain('Persistent')
    const search = await executeToolFixture(f.ctx, { agent: f.agent, signal: new AbortController().signal, callId: ToolCallId('search'), name: 'search_memories', arguments: { query: 'secrets' } })
    expect(search.isError).toBeFalsy()
    expect(search.content).toEqual([{ type: 'text', text: 'Untrusted saved data:\n' + JSON.stringify(saved) }])
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'system/message' && JSON.stringify(event.data).includes('Keep {{literal}}.'))).toBe(true)
    const tools = f.ctx.loader.root.tree.store.tools!
    await tools.fiber!.dispose()
    expect(f.ctx.tools.schemas().map(tool => tool.name)).toEqual([])
    await f.handle.dispose()
    expect(renderPrompt(await f.ctx.systemPrompt.assemble())).toContain('Deployment')
  })

  it('discards staging after a real cancelled turn and exposes no cross-agent memory', async () => {
    const f = await fixture([toolCallResponse('save', 'remember', { text: 'interrupted' }), 'hang'])
    f.ctx.on('agent/request', async ({ agent }, next) => {
      if (agent === f.agent && f.adapter.requests.length === 1) agent.cancel({ kind: 'user' })
      return next()
    })
    f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await f.agent.whenIdle()
    await f.ctx.agentMemory.settled(f.agent.id)
    expect(await f.ctx.agentMemory.search(f.profile.id, 'interrupted')).toEqual([])
    expect(f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
  })

  it('corrects and forgets through the normal tool executor, rejects missing identity and invalid args', async () => {
    const f = await fixture([])
    let call = 0
    const execute = (name: string, args: object) => executeToolFixture(f.ctx, { agent: f.agent, signal: new AbortController().signal, callId: ToolCallId(`call-${++call}`), name, arguments: args })
    f.agent.session.append('turn/start', { turn: 1 })
    const first = await execute('remember', { text: 'first' })
    expect(first.isError).toBeFalsy()
    const body = JSON.parse(first.content[0]!.type === 'text' ? first.content[0]!.text : '') as { memory: Memories.Memory }
    const stagedSearch = await execute('search_memories', { query: 'first' })
    expect(stagedSearch.content).toEqual([{ type: 'text', text: 'Untrusted saved data:\n' + JSON.stringify([body.memory]) }])
    expect((await execute('remember', { id: body.memory.id, expected_revision: 1, text: 'corrected', inclusion: 'searchable' })).isError).toBeFalsy()
    expect((await execute('forget', { id: body.memory.id, expected_revision: 2 })).isError).toBeFalsy()
    f.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect((await execute('search_memories', { query: 'corrected', limit: 1 })).content).toEqual([{ type: 'text', text: 'Untrusted saved data:\n[]' }])
    expect((await execute('remember', { text: 42 })).isError).toBe(true)
    const unbound = await f.ctx.agents.create({ sessionId: SessionId('unbound') })
    const denied = await executeToolFixture(f.ctx, { agent: unbound.agent, signal: new AbortController().signal, callId: ToolCallId('denied'), name: 'search_memories', arguments: { query: 'x' } })
    expect(denied.isError).toBe(true)
    const noAgent = await executeToolFixture(f.ctx, { signal: new AbortController().signal, callId: ToolCallId('no-agent'), name: 'search_memories', arguments: { query: 'x' } })
    expect(noAgent.isError).toBe(true)
    await expect(f.agent.ctx.plugin(Persona, { agentId: 'missing' })).rejects.toThrow('Unknown persistent agent')
  })
})
