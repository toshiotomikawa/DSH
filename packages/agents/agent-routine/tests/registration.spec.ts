import { describe, expect, it } from 'vitest'
import { refusal, setup } from './harness.ts'

const DAILY = { kind: 'daily', time: '09:00' } as const
const base = { agentId: 'a1', name: 'Resumo', instruction: 'Resuma o dia.', schedule: DAILY, timeZone: 'America/Sao_Paulo' }

describe('criterion 1: registration, restart and edits', () => {
  it('saves a routine of agent A, links it by id and survives a restart', async () => {
    const rig = setup()
    const routine = await rig.engine.createRoutine(base)
    expect(rig.tasks.get(routine.scheduleTaskId as string)).toMatchObject({
      title: 'Resumo', agentPreset: 'alfa', cwd: '/work', timeZone: 'America/Sao_Paulo', active: true,
    })
    const before = rig.engine.view(routine.id)
    expect(before.nextFireAt).toBe('2026-06-02T12:00:00.000Z')
    // Rename the agent: the link is the id, so nothing changes.
    rig.agents.set('a1', { id: 'a1', name: 'Alfa Renomeada', preset: 'alfa', cwd: '/work' })
    const restarted = rig.make()
    const after = restarted.view(routine.id)
    expect(after.routine).toEqual(before.routine)
    expect(after.nextFireAt).toBe(before.nextFireAt)
    expect(after.routine.agentId).toBe('a1')
    expect(after.routine.timeZone).toBe('America/Sao_Paulo')
  })

  it('applies defaults by calendar kind and keeps the owner field without logic', async () => {
    const rig = setup()
    const recurring = await rig.engine.createRoutine({ ...base, ownerId: 'dono' })
    expect(recurring).toMatchObject({ limitPolicy: 'wait', missedPolicy: 'skip', scriptEnabled: true, trigger: 'schedule', ownerId: 'dono' })
    const once = await rig.engine.createRoutine({ ...base, schedule: { kind: 'once', date: '2026-12-01', time: '09:00' } })
    expect(once.missedPolicy).toBe('run-once')
    const script = await rig.engine.createRoutine({ agentId: 'a1', name: 'Worker', instruction: 'Faça.' })
    expect(script).toMatchObject({ trigger: 'script', timeZone: 'UTC' })
    expect(script.scheduleTaskId).toBeUndefined()
    expect(rig.calls).toEqual(['create', 'create'])
  })

  it('registers a paused routine with an inactive scheduler task', async () => {
    const rig = setup()
    const routine = await rig.engine.createRoutine({ ...base, active: false })
    expect(rig.tasks.get(routine.scheduleTaskId as string)?.active).toBe(false)
    expect(rig.engine.view(routine.id).nextFireAt).toBeUndefined()
  })

  it('editing only the instruction keeps id, schedule, zone and policies', async () => {
    const rig = setup()
    const routine = await rig.engine.createRoutine({ ...base, limitPolicy: 'skip', missedPolicy: 'run-once' })
    const edited = await rig.engine.editRoutine(routine.id, { instruction: 'Resuma a semana.' })
    expect(edited).toMatchObject({
      id: routine.id, name: 'Resumo', schedule: DAILY, timeZone: 'America/Sao_Paulo', limitPolicy: 'skip', missedPolicy: 'run-once',
      instruction: 'Resuma a semana.', instructionVersion: 2, scheduleTaskId: routine.scheduleTaskId,
    })
    expect(rig.tasks.get(routine.scheduleTaskId as string)?.prompt).toContain('Resuma a semana.')
    const same = await rig.engine.editRoutine(routine.id, { instruction: 'Resuma a semana.' })
    expect(same.instructionVersion).toBe(2)
  })

  it('saves nothing when a field is invalid', async () => {
    const rig = setup()
    const bad: [Record<string, unknown>, string][] = [
      [{ agentId: 'nope' }, 'agente_inexistente'],
      [{ name: '   ' }, 'nome_invalido'],
      [{ name: 'x'.repeat(121) }, 'nome_invalido'],
      [{ instruction: '  ' }, 'instrucao_vazia'],
      [{ trigger: 'schedule', schedule: undefined }, 'agenda_obrigatoria'],
      [{ trigger: 'script' }, 'agenda_sobrando'],
      [{ timeZone: undefined }, 'fuso_obrigatorio'],
      [{ timeZone: 'Marte/Olimpo' }, 'fuso_invalido'],
      [{ schedule: { kind: 'interval', everySeconds: 120 } }, 'intervalo_curto'],
      [{ schedule: { kind: 'cron', expression: '* * * * *' } }, 'intervalo_curto'],
      [{ schedule: { kind: 'once', date: '2026-12-01', time: '09:00' }, limitPolicy: 'skip' }, 'politica_invalida'],
      [{ schedule: { kind: 'monthly', day: 40, time: '09:00' } }, 'agenda_invalida'],
    ]
    for (const [override, code] of bad) {
      expect(await refusal(rig.engine.createRoutine({ ...base, ...override } as never)), JSON.stringify(override)).toBe(code)
    }
    expect(rig.calls).toEqual([])
    expect([...rig.store.routines.entries()]).toEqual([])
  })

  it('saves nothing when an edit is invalid', async () => {
    const rig = setup()
    const routine = await rig.engine.createRoutine(base)
    rig.calls.length = 0
    const stored = structuredClone(rig.store.routines.get(routine.id))
    expect(await refusal(rig.engine.editRoutine(routine.id, { instruction: ' ' }))).toBe('instrucao_vazia')
    expect(await refusal(rig.engine.editRoutine(routine.id, { schedule: { kind: 'interval', everySeconds: 60 } }))).toBe('intervalo_curto')
    expect(await refusal(rig.engine.editRoutine(routine.id, { timeZone: 'Marte/Olimpo' }))).toBe('fuso_invalido')
    expect(await refusal(rig.engine.editRoutine('nada', { name: 'x' }))).toBe('rotina_inexistente')
    expect(rig.store.routines.get(routine.id)).toEqual(stored)
    expect(rig.calls).toEqual([])
  })

  it('rolls the scheduler task back when the store fails', async () => {
    const rig = setup()
    rig.store.routines.failPuts = 1
    expect(await refusal(rig.engine.createRoutine(base))).toBe('other:Error: disk full')
    expect(rig.tasks.size).toBe(0)
    rig.gateway.removeFails = true
    rig.store.routines.failPuts = 1
    await refusal(rig.engine.createRoutine(base))
    expect(rig.warnings.some(item => item.includes('rollback failed'))).toBe(true)
    rig.gateway.removeFails = false
    const routine = await rig.engine.createRoutine(base)
    rig.store.routines.failPuts = 1
    expect(await refusal(rig.engine.editRoutine(routine.id, { name: 'Novo' }))).toBe('other:Error: disk full')
    expect(rig.tasks.get(routine.scheduleTaskId as string)?.title).toBe('Resumo')
    rig.gateway.updateOk = 1
    rig.store.routines.failPuts = 1
    await refusal(rig.engine.editRoutine(routine.id, { name: 'Novo' }))
    expect(rig.warnings.filter(item => item.includes('rollback failed')).length).toBeGreaterThanOrEqual(2)
  })

  it('pauses and resumes without replaying what passed', async () => {
    const rig = setup()
    const routine = await rig.engine.createRoutine(base)
    const paused = await rig.engine.editRoutine(routine.id, { active: false })
    expect(paused.active).toBe(false)
    expect(rig.tasks.get(routine.scheduleTaskId as string)?.active).toBe(false)
    rig.clock.now += 3 * 86_400_000
    const resumed = await rig.engine.editRoutine(routine.id, { active: true })
    expect(resumed.lastSeenAt).toBe(new Date(rig.clock.now).toISOString())
    expect(rig.tasks.get(routine.scheduleTaskId as string)?.active).toBe(true)
    const again = await rig.engine.editRoutine(routine.id, { active: true })
    expect(again.lastSeenAt).toBe(resumed.lastSeenAt)
  })

  it('moves the scheduler task when the trigger changes', async () => {
    const rig = setup()
    const routine = await rig.engine.createRoutine(base)
    const script = await rig.engine.editRoutine(routine.id, { trigger: 'script' })
    expect(script).toMatchObject({ trigger: 'script' })
    expect(script.schedule).toBeUndefined()
    expect(script.scheduleTaskId).toBeUndefined()
    expect(rig.tasks.size).toBe(0)
    const back = await rig.engine.editRoutine(routine.id, { schedule: DAILY, timeZone: 'UTC' })
    expect(back.trigger).toBe('schedule')
    expect(back.scheduleTaskId).toBeDefined()
    expect(rig.tasks.size).toBe(1)
    const onlyScript = await rig.engine.createRoutine({ agentId: 'a1', name: 'W', instruction: 'x' })
    const renamed = await rig.engine.editRoutine(onlyScript.id, { name: 'W2' })
    expect(renamed.name).toBe('W2')
    expect(rig.tasks.size).toBe(1)
  })

  it('refuses to resume a one-time routine that already fired', async () => {
    const rig = setup()
    const routine = await rig.engine.createRoutine({ ...base, schedule: { kind: 'once', date: '2026-12-01', time: '09:00' } })
    await rig.store.routines.put(routine.id, { ...routine, consumed: true, active: false })
    expect(await refusal(rig.engine.editRoutine(routine.id, { active: true }))).toBe('rotina_consumida')
    expect(rig.engine.view(routine.id).nextFireAt).toBeUndefined()
  })

  it('lists newest first, filters by agent and reads the agent from the id', async () => {
    const rig = setup()
    rig.agents.set('a2', { id: 'a2', name: 'Beta' })
    const first = await rig.engine.createRoutine(base)
    rig.clock.now += 1000
    const second = await rig.engine.createRoutine({ agentId: 'a2', name: 'Outra', instruction: 'x' })
    expect(rig.engine.list().map(item => item.id)).toEqual([second.id, first.id])
    expect(rig.engine.list('a1').map(item => item.id)).toEqual([first.id])
    expect(rig.tasks.get(first.scheduleTaskId as string)).toMatchObject({ agentPreset: 'alfa', cwd: '/work' })
    const bare = await rig.engine.createRoutine({ ...base, agentId: 'a2' })
    expect(rig.tasks.get(bare.scheduleTaskId as string)).not.toHaveProperty('agentPreset')
    expect(rig.tasks.get(bare.scheduleTaskId as string)).not.toHaveProperty('cwd')
  })

  it('deletes a routine with its task, runs and live session', async () => {
    const rig = setup()
    const routine = await rig.engine.createRoutine({ ...base, trigger: 'schedule' })
    const script = await rig.engine.createRoutine({ agentId: 'a1', name: 'W', instruction: 'x' })
    const { run } = await rig.engine.trigger(routine.id, { source: 'manual', manual: true })
    await rig.engine.trigger(script.id, { source: 'script' })
    expect(rig.engine.run(run.id)?.state).toBe('execucao')
    await rig.engine.deleteRoutine(routine.id)
    await rig.engine.deleteRoutine(script.id)
    expect(rig.cancels).toEqual(['session-1', 'session-2'])
    expect(rig.tasks.size).toBe(0)
    expect([...rig.store.routines.entries(), ...rig.store.runs.entries()]).toEqual([])
    expect(await refusal(rig.engine.deleteRoutine(routine.id))).toBe('rotina_inexistente')
    const view = await rig.engine.createRoutine(base)
    expect(rig.engine.view(view.id).runs).toEqual([])
  })
})
