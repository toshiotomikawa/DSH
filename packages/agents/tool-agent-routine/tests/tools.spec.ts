import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { setup } from '../../agent-routine/tests/harness.ts'
import { apply, inject, name } from '../src/index.ts'

type Execute = (args: unknown, exec: unknown) => Promise<unknown>

/** Mount the tools on a fake host that carries a real engine on fake collaborators. */
function mount(options: { bridge?: boolean } = {}) {
  const rig = setup()
  rig.agents.set('b2', { id: 'b2', name: 'Beta' })
  const tools = new Map<string, ToolDefinition>()
  const bridge = options.bridge === false ? undefined : {
    agentOfSession: (id: string) => (id === 'sess-1' ? 'a1' : id === 'sess-b' ? 'b2' : undefined),
  }
  const ctx = {
    agentRoutines: { engine: rig.engine },
    get: (key: string) => (key === 'agentRoutineBridge' ? bridge : undefined),
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } },
  }
  apply(ctx as never)
  const call = (toolName: string, args: unknown, exec: unknown = { agent: { id: 'sess-1' } }): Promise<unknown> =>
    (tools.get(toolName)?.execute as Execute)(args, exec)
  return { rig, tools, call }
}

const SCHEDULE = { kind: 'daily', time: '09:00' }

describe('tool registration', () => {
  it('registers the five tools and declares its services', () => {
    const { tools } = mount()
    expect([...tools.keys()]).toEqual(['routine_create', 'routine_update', 'routine_list', 'routine_test', 'routine_no_update'])
    expect(name).toBe('tool-agent-routine')
    expect(inject).toEqual(['tools', 'agentRoutines'])
    for (const tool of tools.values()) {
      const rendered = tool.output.render({}, { a: 1 })
      expect(rendered).toEqual([{ type: 'text', text: '{"a":1}' }])
    }
  })
})

describe('routine_create, routine_update and routine_list', () => {
  it('creates for the calling agent, edits, lists and removes', async () => {
    const { call, rig } = mount()
    const created = await call('routine_create', {
      name: 'Resumo', instruction: 'Resuma.', schedule: SCHEDULE, time_zone: 'UTC',
      active: false, limit_policy: 'skip', missed_policy: 'run-once', script_enabled: false,
    }) as { id: string; agentId: string; active: boolean; limitPolicy: string; missedPolicy: string; scriptEnabled: boolean }
    expect(created).toMatchObject({ agentId: 'a1', active: false, limitPolicy: 'skip', missedPolicy: 'run-once', scriptEnabled: false })
    const edit = { id: created.id, instruction: 'Resuma a semana.', time_zone: 'America/Sao_Paulo', active: true }
    const edited = await call('routine_update', edit) as { instructionVersion: number; active: boolean }
    expect(edited).toMatchObject({ instructionVersion: 2, active: true })
    const listed = await call('routine_list', {}) as { routines: { id: string }[] }
    expect(listed.routines.map(item => item.id)).toEqual([created.id])
    await expect(call('routine_list', { agent: 'outro' })).rejects.toThrow('agente_nao_autorizado')
    const detail = await call('routine_list', { id: created.id, history_limit: 5 }) as { routine: { id: string }; nextFireAt: string; runs: unknown[] }
    expect(detail.routine.id).toBe(created.id)
    expect(detail.nextFireAt).toBeDefined()
    expect(((await call('routine_list', { id: created.id })) as { runs: unknown[] }).runs).toEqual([])
    expect(await call('routine_update', { id: created.id, remove: true })).toEqual({ id: created.id, removed: true })
    expect(rig.tasks.size).toBe(0)
  })

  it('takes an explicit agent and refuses to guess one', async () => {
    const { call, rig } = mount()
    const created = await call('routine_create', { name: 'W', instruction: 'x', agent: 'a1' }) as { agentId: string; schedule?: unknown }
    expect(created.agentId).toBe('a1')
    expect(created).not.toHaveProperty('schedule')
    await expect(call('routine_create', { name: 'W', instruction: 'x' }, { agent: { id: 'desconhecida' } })).rejects.toThrow('agente_obrigatorio')
    await expect(call('routine_create', { name: 'W', instruction: 'x' }, {})).rejects.toThrow('agente_obrigatorio')
    expect(rig.engine.list()).toHaveLength(1)
  })

  it('refuses another agent\'s routine for create, update, list and test (audit 5)', async () => {
    const { call } = mount()
    const foreign = await call('routine_create', { name: 'B', instruction: 'x', agent: 'b2' }, { agent: { id: 'sess-b' } }) as { id: string }
    expect(foreign.id).toBeDefined()
    await expect(call('routine_create', { name: 'X', instruction: 'x', agent: 'b2' })).rejects.toThrow('agente_nao_autorizado')
    // Another agent's routine must read exactly like a missing one.
    await expect(call('routine_update', { id: foreign.id, name: 'X' })).rejects.toThrow('rotina_inexistente')
    await expect(call('routine_update', { id: foreign.id, remove: true })).rejects.toThrow('rotina_inexistente')
    await expect(call('routine_list', { id: foreign.id })).rejects.toThrow('rotina_inexistente')
    await expect(call('routine_test', { id: foreign.id })).rejects.toThrow('rotina_inexistente')
    await expect(call('routine_update', { id: 'nao-existe', name: 'X' })).rejects.toThrow('rotina_inexistente')
  })

  it('needs the bridge to know the calling agent', async () => {
    const { call } = mount({ bridge: false })
    await expect(call('routine_create', { name: 'W', instruction: 'x' })).rejects.toThrow('agente_obrigatorio')
  })

  it('shows engine refusals as code and message, and lets other errors through', async () => {
    const { call, rig } = mount()
    await expect(call('routine_create', { name: 'W', instruction: 'x', agent: 'nada' })).rejects.toThrow('agente_nao_autorizado')
    await expect(call('routine_update', { id: 'nada', name: 'x' })).rejects.toThrow('rotina_inexistente: ')
    await expect(call('routine_update', { name: 'x' })).rejects.toThrow()
    rig.store.routines.failPuts = 1
    await expect(call('routine_create', { name: 'W', instruction: 'x', agent: 'a1' })).rejects.toThrow('disk full')
  })
})

describe('routine_test and routine_no_update', () => {
  it('runs a paused routine by hand and reports the answer in the history', async () => {
    const { call, rig } = mount()
    const created = await call('routine_create', { name: 'Resumo', instruction: 'x', schedule: SCHEDULE, time_zone: 'UTC', active: false }) as { id: string }
    const run = await call('routine_test', { id: created.id }) as { id: string; state: string; source: string }
    expect(run).toMatchObject({ state: 'execucao', source: 'manual' })
    await rig.engine.settle(run.id, { kind: 'completed', text: 'resposta' })
    const detail = await call('routine_list', { id: created.id }) as { routine: { active: boolean }; runs: { result: string }[] }
    expect(detail.routine.active).toBe(false)
    expect(detail.runs[0]?.result).toBe('resposta')
  })

  it('marks "nothing new" from inside the execution session only', async () => {
    const { call, rig } = mount()
    const created = await call('routine_create', { name: 'W', instruction: 'x', agent: 'a1' }) as { id: string }
    await expect(call('routine_no_update', {}, { agent: { id: 'session-1' } })).rejects.toThrow('sem_execucao: ')
    const run = await call('routine_test', { id: created.id }) as { id: string }
    expect(await call('routine_no_update', {}, { agent: { id: 'session-1' } })).toEqual({ runId: run.id })
    await rig.engine.settle(run.id, { kind: 'completed', text: '' })
    expect(rig.engine.run(run.id)?.state).toBe('sucesso_sem_novidade')
    await expect(call('routine_no_update', {}, {})).rejects.toThrow('sem_execucao: ')
  })
})
