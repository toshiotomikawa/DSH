import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '../../../storage/storage/src/index.ts'
import { DomainFacility } from '../../../storage/storage-domain/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import AgentRoutines, { scheduleGateway, TRIGGER_PATH } from '../src/index.ts'
import type { RoutineReport } from '../src/index.ts'
import type { AgentInfo, ScheduleTaskSpec } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []

beforeEach(() => { vi.useFakeTimers({ now: Date.parse('2026-06-01T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'Date'] }) })
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Edit { id: string; action: string; patch?: Record<string, unknown> }

/** Host with a memory domain, a scripted scheduler and a recording web server. */
function fakes() {
  const state = {
    created: [] as Record<string, unknown>[],
    edits: [] as Edit[],
    editResult: {} as Record<string, unknown>,
    records: [] as { messageId: string; scheduledAt: string; deliveredAt: string; targetSessionId: string }[],
    page: 'records' as 'records' | 'other' | 'throw',
    routes: [] as { path: string; handler: unknown }[],
    unregistered: 0,
  }
  const schedule = {
    create: (input: Record<string, unknown>) => {
      state.created.push(input)
      return Promise.resolve({ id: `task-${state.created.length}` })
    },
    edit: (input: Edit) => {
      state.edits.push(input)
      return Promise.resolve(state.editResult)
    },
    history: () => {
      if (state.page === 'throw') return Promise.reject(new Error('history down'))
      return Promise.resolve(state.page === 'records' ? { records: state.records } : { code: 'not-found' })
    },
  }
  const webServer = {
    register: (route: { path: string; handler: unknown }) => {
      state.routes.push(route)
      return () => { state.unregistered++ }
    },
  }
  return { state, schedule, webServer }
}

async function host(extra: { bridge?: boolean; cancelFails?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'routine-plugin-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('mem', backend))
  const facility = new DomainFacility(ctx, { backend: 'mem' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return unmount
  })
  const parts = fakes()
  ctx.provide('schedule', parts.schedule)
  ctx.provide('webServer', parts.webServer)
  const started: string[] = []
  const cancelled: string[] = []
  const agent: AgentInfo = { id: 'a1', name: 'Alfa', preset: 'alfa', cwd: '/work' }
  if (extra.bridge !== false) {
    ctx.provide('agentRoutineBridge', {
      agents: (id: string) => (id === 'a1' ? agent : undefined),
      runner: {
        start: (input: { runId: string }) => { started.push(input.runId); return Promise.resolve({ sessionId: `s-${started.length}` }) },
        cancel: (sessionId: string) => {
          cancelled.push(sessionId)
          return extra.cancelFails === true ? Promise.reject(new Error('já foi')) : Promise.resolve()
        },
      },
    })
  }
  const reports: RoutineReport[] = []
  ctx.on('agent-routine/report', (report: RoutineReport) => { reports.push(report) })
  await ctx.plugin(AgentRoutines, { tokenFile: join(root, 'token'), tickSeconds: 1 })
  return { ctx, root, started, cancelled, reports, ...parts }
}

const base = { agentId: 'a1', name: 'Resumo', instruction: 'Resuma.', schedule: { kind: 'daily', time: '12:00' }, timeZone: 'UTC' } as const

describe('plugin wiring', () => {
  it('creates scheduler tasks with a fresh-session target of the agent preset', async () => {
    const h = await host()
    const engine = h.ctx.agentRoutines.engine
    const item = await engine.createRoutine(base)
    expect(h.state.created[0]).toMatchObject({
      title: 'Resumo',
      timing: { kind: 'daily' },
      target: { kind: 'new', create: { agentPreset: 'alfa', cwd: '/work' } },
    })
    const paused = await engine.createRoutine({ ...base, name: 'P', active: false })
    expect(h.state.edits.at(-1)).toMatchObject({ id: paused.scheduleTaskId, action: 'update', patch: { active: false } })
    await engine.editRoutine(item.id, { name: 'Novo' })
    expect(h.state.edits.at(-1)).toMatchObject({ id: item.scheduleTaskId, action: 'update', patch: { title: 'Novo', active: true } })
    await engine.deleteRoutine(item.id)
    expect(h.state.edits.at(-1)).toMatchObject({ id: item.scheduleTaskId, action: 'delete' })
  })

  it('treats a scheduler refusal as a failure', async () => {
    const h = await host()
    h.state.editResult = { code: 'not-found' }
    const item = await h.ctx.agentRoutines.engine.createRoutine(base)
    await expect(h.ctx.agentRoutines.engine.editRoutine(item.id, { name: 'X' })).rejects.toThrow('schedule: not-found')
  })

  it('builds a gateway without preset or folder when the agent has none', async () => {
    const created: Record<string, unknown>[] = []
    const gateway = scheduleGateway({
      schedule: { create: (input: Record<string, unknown>) => { created.push(input); return Promise.resolve({ id: 't' }) } },
    } as never)
    const spec: ScheduleTaskSpec = {
      title: 'x', prompt: 'p', spec: { kind: 'daily', time: '09:00' }, timeZone: 'UTC', active: true,
    }
    expect(await gateway.create(spec)).toBe('t')
    expect(created[0]).toMatchObject({ target: { kind: 'new', create: {} } })
  })

  it('registers the script entry on the web server and removes it with the plugin', async () => {
    const h = await host()
    expect(h.state.routes.map(route => route.path)).toEqual([TRIGGER_PATH])
    h.ctx.registry.delete(AgentRoutines)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.state.unregistered).toBe(1)
  })

  it('runs the execution through the bridge and emits the report', async () => {
    const h = await host()
    const engine = h.ctx.agentRoutines.engine
    const item = await engine.createRoutine(base)
    const { run } = await engine.trigger(item.id, { source: 'script' })
    expect(h.started).toEqual([run.id])
    await engine.settle(run.id, { kind: 'completed', text: 'feito' })
    expect(h.reports).toEqual([{ runId: run.id, routineId: item.id, agentId: 'a1', routineName: 'Resumo', text: 'feito' }])
    await engine.deleteRoutine(item.id)
    const again = await engine.createRoutine(base)
    const second = await engine.trigger(again.id, { source: 'script' })
    await engine.cancel(second.run.id)
    expect(h.cancelled).toEqual(['s-2'])
  })

  it('cancels quietly when the bridge left, and logs through the host logger', async () => {
    const h = await host()
    const engine = h.ctx.agentRoutines.engine
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => undefined)
    const item = await engine.createRoutine({ agentId: 'a1', name: 'S', instruction: 'x' })
    const { run } = await engine.trigger(item.id, { source: 'script' })
    h.ctx.set('agentRoutineBridge', undefined)
    await engine.cancel(run.id)
    expect(engine.run(run.id)?.state).toBe('cancelada')
    expect(h.cancelled).toEqual([])
    expect(warn.mock.calls.some(call => String(call[0]).includes('cancel failed'))).toBe(true)
    const second = await engine.trigger(item.id, { source: 'script' })
    expect(second.run.state).toBe('falha')
    h.state.editResult = { code: 'x' }
    vi.spyOn(engine, 'trigger').mockRejectedValue(new Error('boom'))
    const { createServer } = await import('node:http')
    const { readFile } = await import('node:fs/promises')
    const token = (await readFile(join(h.root, 'token'), 'utf8')).trim()
    const handler = h.state.routes[0]?.handler as (request: unknown, response: unknown) => Promise<void>
    const server = createServer((request, response) => { void handler(request, response) })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port
    const answer = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"routineId":"r"}',
    })
    await new Promise(done => server.close(done))
    expect(answer.status).toBe(503)
    expect(warn.mock.calls.some(call => String(call[0]).includes('trigger failed'))).toBe(true)
  })

  it('logs a cancellation the executor refuses', async () => {
    const h = await host({ cancelFails: true })
    const engine = h.ctx.agentRoutines.engine
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => undefined)
    const item = await engine.createRoutine({ agentId: 'a1', name: 'S', instruction: 'x' })
    const { run } = await engine.trigger(item.id, { source: 'script' })
    await engine.cancel(run.id)
    expect(warn.mock.calls.some(call => String(call[0]).includes('cancel failed'))).toBe(true)
  })

  it('fails the start when no session executor is connected', async () => {
    const h = await host({ bridge: false })
    const engine = h.ctx.agentRoutines.engine
    expect(await engine.createRoutine(base).catch((error: unknown) => (error as { code: string }).code)).toBe('agente_inexistente')
  })
})

describe('reconciliation, restart and tick', () => {
  it('records deliveries the scheduler made and never twice', async () => {
    const h = await host()
    const engine = h.ctx.agentRoutines.engine
    const item = await engine.createRoutine(base)
    h.state.records = [{ messageId: 'm1', scheduledAt: '2026-06-02T12:00:00.000Z', deliveredAt: '2026-06-02T12:00:01.000Z', targetSessionId: 'sched-1' }]
    h.ctx.emit('schedule/changed' as never)
    await vi.advanceTimersByTimeAsync(10)
    expect(engine.history(item.id)).toHaveLength(1)
    h.ctx.emit('schedule/changed' as never)
    await vi.advanceTimersByTimeAsync(10)
    expect(engine.history(item.id)).toHaveLength(1)
    expect(engine.history(item.id)[0]).toMatchObject({ source: 'agenda', state: 'execucao', sessionId: 's-1' })
    expect(h.started).toEqual([engine.history(item.id)[0]?.id])
    expect(h.cancelled).toEqual(['sched-1'])
  })

  it('ignores pages without records and logs a failing read', async () => {
    const h = await host()
    const engine = h.ctx.agentRoutines.engine
    const item = await engine.createRoutine(base)
    h.state.page = 'other'
    await vi.advanceTimersByTimeAsync(1500)
    expect(engine.history(item.id)).toEqual([])
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => undefined)
    h.state.page = 'throw'
    await vi.advanceTimersByTimeAsync(1500)
    expect(warn.mock.calls.some(call => String(call[0]).includes('reconcile failed'))).toBe(true)
  })

  it('skips routines that have no scheduler task', async () => {
    const h = await host()
    const engine = h.ctx.agentRoutines.engine
    await engine.createRoutine({ agentId: 'a1', name: 'S', instruction: 'x' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(engine.list()).toHaveLength(1)
  })

  it('resumes a waiting run on the timer and keeps going after a restart', async () => {
    const h = await host()
    const engine = h.ctx.agentRoutines.engine
    const item = await engine.createRoutine({ agentId: 'a1', name: 'S', instruction: 'x' })
    const { run } = await engine.trigger(item.id, { source: 'script' })
    await engine.settle(run.id, { kind: 'limit' })
    expect(h.started).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(301_000)
    expect(h.started).toHaveLength(2)
    expect(engine.run(run.id)?.state).toBe('execucao')
  })

  it('logs a failing tick and stops the timer with the plugin', async () => {
    const h = await host()
    const engine = h.ctx.agentRoutines.engine
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => undefined)
    const tick = vi.spyOn(engine, 'tick').mockRejectedValue(new Error('tick boom'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(warn.mock.calls.some(call => String(call[0]).includes('tick failed'))).toBe(true)
    h.ctx.registry.delete(AgentRoutines)
    await vi.advanceTimersByTimeAsync(10)
    const calls = tick.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick.mock.calls.length).toBe(calls)
  })

  it('defaults the token file to the harness home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'routine-home-'))
    roots.push(root)
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    ctx.effect(() => ctx.storage.backend.register('mem', backend))
    const facility = new DomainFacility(ctx, { backend: 'mem' })
    ctx.effect(() => {
      const unmount = ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      return unmount
    })
    const parts = fakes()
    ctx.provide('schedule', parts.schedule)
    ctx.provide('webServer', parts.webServer)
    await ctx.plugin(AgentRoutines, {})
    const { readFile } = await import('node:fs/promises')
    expect((await readFile(join(root, 'agent-routines.token'), 'utf8')).trim()).toHaveLength(64)
    vi.unstubAllEnvs()
  })
})
