import { describe, expect, it } from 'vitest'
import { RoutineError } from '../src/errors.ts'
import { toTiming, validateSchedule } from '../src/timing.ts'
import { refusal, setup } from './harness.ts'

const base = { agentId: 'a1', name: 'Resumo', instruction: 'Resuma.', schedule: { kind: 'daily', time: '09:00' }, timeZone: 'UTC' } as const

describe('edges of the engine', () => {
  it('refuses an edit when the agent of the routine is gone', async () => {
    const rig = setup()
    const item = await rig.engine.createRoutine(base)
    rig.agents.delete('a1')
    expect(await refusal(rig.engine.editRoutine(item.id, { name: 'Novo' }))).toBe('agente_inexistente')
  })

  it('undoes a task created by an edit when the store fails', async () => {
    const rig = setup()
    const item = await rig.engine.createRoutine({ agentId: 'a1', name: 'S', instruction: 'x' })
    rig.store.routines.failPuts = 1
    expect(await refusal(rig.engine.editRoutine(item.id, { schedule: base.schedule, timeZone: 'UTC' }))).toBe('other:Error: disk full')
    expect(rig.tasks.size).toBe(0)
    expect(rig.calls).toEqual(['create', 'remove'])
  })

  it('orders routines created at the same instant by id', async () => {
    const rig = setup()
    const first = await rig.engine.createRoutine(base)
    const second = await rig.engine.createRoutine({ ...base, name: 'B' })
    expect(rig.engine.list().map(item => item.id)).toEqual([first.id, second.id])
  })

  it('copies the owner field to the run and starts queued runs in order', async () => {
    const rig = setup()
    const item = await rig.engine.createRoutine({ ...base, ownerId: 'dono' })
    const one = await rig.engine.trigger(item.id, { source: 'script' })
    const two = await rig.engine.trigger(item.id, { source: 'script' })
    const three = await rig.engine.trigger(item.id, { source: 'script' })
    expect(one.run.ownerId).toBe('dono')
    await rig.engine.settle(one.run.id, { kind: 'completed', text: 'a' })
    expect(rig.engine.run(two.run.id)?.state).toBe('execucao')
    expect(rig.engine.run(three.run.id)?.state).toBe('fila')
  })

  it('fails a queued run whose routine record is missing', async () => {
    const rig = setup()
    const item = await rig.engine.createRoutine(base)
    const one = await rig.engine.trigger(item.id, { source: 'script' })
    const queued = await rig.engine.trigger(item.id, { source: 'script' })
    const fresh = rig.make()
    await rig.store.routines.delete(item.id)
    const other = rig.make()
    await other.settle(one.run.id, { kind: 'completed', text: 'x' }).catch(() => undefined)
    await other.tick()
    expect(other.run(queued.run.id)).toMatchObject({ state: 'falha', reason: 'sem_rotina_ou_agente' })
    expect(fresh.run(one.run.id)).toBeDefined()
  })
})

describe('edges of the calendar', () => {
  it('keeps seconds that are already given', () => {
    expect(toTiming({ kind: 'daily', time: '08:30:15' }, 'UTC')).toMatchObject({ kind: 'daily' })
  })

  it('maps any scheduler failure to a stable code', () => {
    expect(() => validateSchedule({ kind: 'cron', expression: 5 as never }, 'UTC', Date.parse('2026-06-01T00:00:00Z'))).toThrow(RoutineError)
  })
})
