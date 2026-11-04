import { describe, expect, it } from 'vitest'
import { delivery, setup } from './harness.ts'
import type { Rig } from './harness.ts'
import type { Routine, Run } from '../src/types.ts'

const DAILY = { kind: 'daily', time: '12:00' } as const
const base = { agentId: 'a1', name: 'Resumo', instruction: 'Resuma o dia.', schedule: DAILY, timeZone: 'UTC' }
const DAY = 86_400_000

async function routine(rig: Rig, extra: Record<string, unknown> = {}): Promise<Routine> {
  return rig.engine.createRoutine({ ...base, ...extra })
}

describe('criterion 4: one-time routine and quota', () => {
  it('waits for quota, survives a restart and runs once when the quota is back', async () => {
    const rig = setup()
    const item = await routine(rig, { schedule: { kind: 'once', date: '2026-06-01', time: '13:00' } })
    rig.clock.now = Date.parse('2026-06-01T13:00:00Z')
    const run = await rig.engine.observeDelivery(item.id, delivery('m1', '2026-06-01T13:00:00.000Z'))
    expect(run).toMatchObject({ state: 'execucao', source: 'agenda', sessionId: 'scheduler-m1' })
    expect(rig.engine.view(item.id).routine).toMatchObject({ active: false, consumed: true })
    await rig.engine.settle((run as { id: string }).id, { kind: 'limit', message: 'cota' })
    expect(rig.engine.run((run as { id: string }).id)).toMatchObject({ state: 'espera_cota', quotaChecks: 1 })
    expect(rig.starts).toEqual([])
    const restarted = rig.make()
    await restarted.recover()
    rig.clock.now += 299_000
    await restarted.tick()
    expect(rig.starts).toEqual([])
    rig.clock.now += 2000
    await restarted.tick()
    expect(rig.starts).toHaveLength(1)
    expect(restarted.run((run as { id: string }).id)).toMatchObject({ state: 'execucao', sessionId: 'session-1' })
    await restarted.settle((run as { id: string }).id, { kind: 'completed', text: 'ok' })
    expect(restarted.history(item.id)).toHaveLength(1)
    expect(rig.reports).toHaveLength(1)
  })
})

describe('criterion 5: wait, skip and invalid credential', () => {
  it('backs off with growing delays and honours a reset time', async () => {
    const rig = setup()
    const item = await routine(rig)
    const { run } = await rig.engine.trigger(item.id, { source: 'script' })
    const stamp = (): string => rig.engine.run(run.id)?.nextCheckAt as string
    await rig.engine.settle(run.id, { kind: 'limit' })
    expect(Date.parse(stamp()) - rig.clock.now).toBe(300_000)
    rig.clock.now += 300_000
    await rig.engine.tick()
    await rig.engine.settle(run.id, { kind: 'limit' })
    expect(Date.parse(stamp()) - rig.clock.now).toBe(900_000)
    rig.clock.now += 900_000
    await rig.engine.tick()
    await rig.engine.settle(run.id, { kind: 'limit' })
    rig.clock.now += 3_600_000
    await rig.engine.tick()
    await rig.engine.settle(run.id, { kind: 'limit' })
    expect(Date.parse(stamp()) - rig.clock.now).toBe(3_600_000)
    rig.clock.now += 3_600_000
    await rig.engine.tick()
    const reset = new Date(rig.clock.now + 7_200_000).toISOString()
    await rig.engine.settle(run.id, { kind: 'limit', resetAt: reset })
    expect(rig.engine.run(run.id)).toMatchObject({ nextCheckAt: reset, eligibleAt: reset })
  })

  it('holds the slot while waiting so the next run queues behind it', async () => {
    const rig = setup()
    const item = await routine(rig)
    const first = await rig.engine.trigger(item.id, { source: 'script' })
    const second = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.settle(first.run.id, { kind: 'limit' })
    expect(rig.engine.run(second.run.id)?.state).toBe('fila')
    rig.clock.now += 301_000
    await rig.engine.tick()
    expect(rig.engine.run(first.run.id)?.state).toBe('execucao')
    await rig.engine.settle(first.run.id, { kind: 'completed', text: 'ok' })
    expect(rig.engine.run(second.run.id)?.state).toBe('execucao')
  })

  it('skips calendar and webhook runs under the skip policy but waits for manual and script ones', async () => {
    const rig = setup()
    const item = await routine(rig, { limitPolicy: 'skip' })
    const scheduled = await rig.engine.observeDelivery(item.id, delivery('m1', '2026-06-02T12:00:00.000Z'))
    await rig.engine.settle((scheduled as { id: string }).id, { kind: 'limit' })
    expect(rig.engine.run((scheduled as { id: string }).id)).toMatchObject({ state: 'pulada', reason: 'cota' })
    const hook = await rig.engine.trigger(item.id, { source: 'webhook' })
    await rig.engine.settle(hook.run.id, { kind: 'limit' })
    expect(rig.engine.run(hook.run.id)?.state).toBe('pulada')
    const manual = await rig.engine.trigger(item.id, { source: 'manual', manual: true })
    await rig.engine.settle(manual.run.id, { kind: 'limit' })
    expect(rig.engine.run(manual.run.id)?.state).toBe('espera_cota')
    await rig.engine.cancel(manual.run.id)
    const script = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.settle(script.run.id, { kind: 'limit' })
    expect(rig.engine.run(script.run.id)?.state).toBe('espera_cota')
  })

  it('treats an invalid credential as a failure, not as quota', async () => {
    const rig = setup()
    const item = await routine(rig)
    const { run } = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.settle(run.id, { kind: 'auth', message: 'chave inválida' })
    expect(rig.engine.run(run.id)).toMatchObject({ state: 'falha', reason: 'autenticacao', error: 'chave inválida' })
    rig.clock.now += DAY
    await rig.engine.tick()
    expect(rig.starts).toHaveLength(1)
  })

  it('does not repeat a run that already had effects when the limit hit', async () => {
    const rig = setup()
    const item = await routine(rig)
    const { run } = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.settle(run.id, { kind: 'limit', afterEffects: true })
    expect(rig.engine.run(run.id)).toMatchObject({ state: 'falha', uncertain: true, reason: 'limite_apos_efeitos_requer_decisao' })
    rig.clock.now += DAY
    await rig.engine.tick()
    expect(rig.starts).toHaveLength(1)
  })

  it('keeps a waiting automatic run until its paused routine is resumed, and fails it when the agent is gone', async () => {
    const rig = setup()
    const item = await routine(rig)
    const hook = await rig.engine.trigger(item.id, { source: 'webhook' })
    await rig.engine.settle(hook.run.id, { kind: 'limit' })
    await rig.engine.editRoutine(item.id, { active: false })
    rig.clock.now += DAY
    await rig.engine.tick()
    expect(rig.engine.run(hook.run.id)?.state).toBe('espera_cota')
    await rig.engine.editRoutine(item.id, { active: true })
    await rig.engine.tick()
    expect(rig.engine.run(hook.run.id)?.state).toBe('execucao')
    await rig.engine.settle(hook.run.id, { kind: 'limit' })
    rig.agents.delete('a1')
    rig.clock.now += DAY
    await rig.engine.tick()
    expect(rig.engine.run(hook.run.id)).toMatchObject({ state: 'falha', reason: 'sem_rotina_ou_agente' })
    const orphan = rig.store.runs.get(hook.run.id) as Run
    await rig.store.routines.delete(item.id)
    await rig.store.runs.put('orfa', { ...orphan, id: 'orfa', state: 'espera_cota', nextCheckAt: new Date(rig.clock.now).toISOString() })
    const fresh = rig.make()
    await fresh.tick()
    expect(fresh.run('orfa')?.state).toBe('falha')
  })

  it('moves the last-seen mark forward about once a minute', async () => {
    const rig = setup()
    const item = await routine(rig)
    const paused = await routine(rig, { name: 'Pausada', active: false })
    const script = await rig.engine.createRoutine({ agentId: 'a1', name: 'S', instruction: 'x' })
    rig.clock.now += 30_000
    await rig.engine.tick()
    expect(rig.engine.view(item.id).routine.lastSeenAt).toBe(new Date(START_MS).toISOString())
    rig.clock.now += 40_000
    await rig.engine.tick()
    expect(rig.engine.view(item.id).routine.lastSeenAt).toBe(new Date(rig.clock.now).toISOString())
    expect(rig.engine.view(paused.id).routine.lastSeenAt).toBe(new Date(START_MS).toISOString())
    expect(rig.engine.view(script.id).routine.lastSeenAt).toBe(new Date(START_MS).toISOString())
  })
})

const START_MS = Date.parse('2026-06-01T12:00:00Z')

describe('criterion 6: missed occurrences', () => {
  const lateBy = 3 * DAY + 10 * 60_000

  it('records every missed occurrence as skipped under the skip policy and stops the late session', async () => {
    const rig = setup()
    const item = await routine(rig)
    rig.clock.now = START_MS + lateBy
    const run = await rig.engine.observeDelivery(item.id, delivery('m1', '2026-06-04T12:00:00.000Z', 10 * 60_000))
    expect(run).toMatchObject({ state: 'pulada', reason: 'desligamento' })
    const states = rig.engine.history(item.id, 50)
    expect(states.map(entry => entry.scheduledAt).sort()).toEqual([
      '2026-06-02T12:00:00.000Z', '2026-06-03T12:00:00.000Z', '2026-06-04T12:00:00.000Z',
    ])
    expect(states.every(entry => entry.state === 'pulada')).toBe(true)
    expect(rig.cancels).toEqual(['scheduler-m1'])
    expect(rig.starts).toEqual([])
    expect(rig.engine.view(item.id).routine.lastSeenAt).toBe(new Date(rig.clock.now).toISOString())
  })

  it('runs once under run-once and marks the others as suppressed', async () => {
    const rig = setup()
    const item = await routine(rig, { missedPolicy: 'run-once' })
    rig.clock.now = START_MS + lateBy
    const run = await rig.engine.observeDelivery(item.id, delivery('m1', '2026-06-04T12:00:00.000Z', 10 * 60_000))
    expect(run).toMatchObject({ state: 'execucao', sessionId: 'scheduler-m1' })
    const suppressed = rig.engine.history(item.id, 50).filter(entry => entry.reason === 'suprimida')
    expect(suppressed).toHaveLength(2)
    expect(rig.cancels).toEqual([])
  })

  it('does not record a missed occurrence twice', async () => {
    const rig = setup()
    const item = await routine(rig)
    rig.clock.now = START_MS + lateBy
    await rig.engine.observeDelivery(item.id, delivery('m1', '2026-06-04T12:00:00.000Z', 10 * 60_000))
    const again = await rig.engine.observeDelivery(item.id, delivery('m1', '2026-06-04T12:00:00.000Z', 10 * 60_000))
    expect(again?.deliveryKey).toBe('m1')
    expect(rig.engine.history(item.id, 50)).toHaveLength(3)
    await rig.store.routines.put(item.id, { ...rig.engine.view(item.id).routine, lastSeenAt: new Date(START_MS).toISOString() })
    const replay = rig.make()
    await replay.observeDelivery(item.id, delivery('m2', '2026-06-04T12:00:00.000Z', 10 * 60_000))
    expect(replay.history(item.id, 50).filter(entry => entry.reason === 'desligamento')).toHaveLength(4)
  })

  it('keeps the missed-run decision apart from the quota decision', async () => {
    const rig = setup()
    const item = await routine(rig, { missedPolicy: 'run-once', limitPolicy: 'wait' })
    rig.clock.now = START_MS + lateBy
    const run = await rig.engine.observeDelivery(item.id, delivery('m1', '2026-06-04T12:00:00.000Z', 10 * 60_000))
    await rig.engine.settle((run as { id: string }).id, { kind: 'limit' })
    expect(rig.engine.run((run as { id: string }).id)?.state).toBe('espera_cota')
    const other = await routine(rig, { name: 'Outra', missedPolicy: 'skip', limitPolicy: 'wait' })
    const skipped = await rig.engine.observeDelivery(other.id, delivery('m2', '2026-06-05T12:00:00.000Z', 20 * 60_000))
    expect(skipped?.state).toBe('pulada')
    const third = await routine(rig, { name: 'Terceira', missedPolicy: 'skip', limitPolicy: 'wait' })
    rig.clock.now += DAY
    const onTime = await rig.engine.observeDelivery(third.id, delivery('m3', '2026-06-05T12:00:00.000Z', 30_000))
    await rig.engine.settle((onTime as { id: string }).id, { kind: 'limit' })
    expect(rig.engine.run((onTime as { id: string }).id)?.state).toBe('espera_cota')
  })
})

describe('calendar deliveries', () => {
  it('ignores unknown or script-only routines', async () => {
    const rig = setup()
    expect(await rig.engine.observeDelivery('nada', delivery('m1', '2026-06-02T12:00:00.000Z'))).toBeUndefined()
    const script = await rig.engine.createRoutine({ agentId: 'a1', name: 'S', instruction: 'x' })
    expect(await rig.engine.observeDelivery(script.id, delivery('m1', '2026-06-02T12:00:00.000Z'))).toBeUndefined()
  })

  it('skips the delivery of a paused routine and stops its session', async () => {
    const rig = setup()
    const item = await routine(rig, { active: false })
    const run = await rig.engine.observeDelivery(item.id, delivery('m1', '2026-06-02T12:00:00.000Z'))
    expect(run).toMatchObject({ state: 'pulada', reason: 'rotina_pausada' })
    expect(rig.cancels).toEqual(['scheduler-m1'])
  })

  it('queues a delivery that arrives while the previous run is still going', async () => {
    const rig = setup()
    const item = await routine(rig)
    const first = await rig.engine.observeDelivery(item.id, delivery('m1', '2026-06-02T12:00:00.000Z'))
    rig.clock.now += DAY
    const second = await rig.engine.observeDelivery(item.id, delivery('m2', '2026-06-03T12:00:00.000Z'))
    expect(second).toMatchObject({ state: 'fila', reason: 'serializada' })
    expect(rig.cancels).toEqual(['scheduler-m2'])
    await rig.engine.settle((first as { id: string }).id, { kind: 'completed', text: 'a' })
    expect(rig.engine.run((second as { id: string }).id)).toMatchObject({ state: 'execucao', sessionId: 'session-1' })
    expect(rig.engine.run((second as { id: string }).id)).not.toHaveProperty('reason')
  })
})

describe('recovery after a restart', () => {
  it('records an interrupted run as uncertain, never repeats it, and continues the queue', async () => {
    const rig = setup()
    const item = await routine(rig)
    const running = await rig.engine.trigger(item.id, { source: 'script' })
    const queued = await rig.engine.trigger(item.id, { source: 'script' })
    const restarted = rig.make()
    await restarted.recover()
    expect(restarted.run(running.run.id)).toMatchObject({ state: 'falha', reason: 'interrompida', uncertain: true })
    expect(restarted.run(queued.run.id)?.state).toBe('execucao')
    expect(rig.starts).toHaveLength(2)
    expect(rig.reports).toEqual([])
  })
})
