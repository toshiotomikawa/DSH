import { describe, expect, it } from 'vitest'
import { refusal, setup } from './harness.ts'
import type { Rig } from './harness.ts'
import type { Routine } from '../src/types.ts'

const DAILY = { kind: 'daily', time: '09:00' } as const
const base = { agentId: 'a1', name: 'Resumo', instruction: 'Resuma o dia.', schedule: DAILY, timeZone: 'UTC' }

async function routine(rig: Rig, extra: Record<string, unknown> = {}): Promise<Routine> {
  return rig.engine.createRoutine({ ...base, ...extra })
}

describe('criterion 3: pause, manual test and serialization', () => {
  it('runs a manual test of a paused routine once, without reactivating or moving the next fire', async () => {
    const rig = setup()
    const paused = await routine(rig, { active: false })
    rig.calls.length = 0
    const { run, duplicate } = await rig.engine.trigger(paused.id, { source: 'manual', manual: true })
    expect(duplicate).toBe(false)
    expect(run).toMatchObject({ state: 'execucao', source: 'manual', manual: true, sessionId: 'session-1' })
    expect(rig.starts).toHaveLength(1)
    await rig.engine.settle(run.id, { kind: 'completed', text: 'feito' })
    const view = rig.engine.view(paused.id)
    expect(view.routine).toMatchObject({ active: false, lastSeenAt: paused.lastSeenAt })
    expect(view.nextFireAt).toBeUndefined()
    expect(view.runs[0]).toMatchObject({ state: 'sucesso_relato', result: 'feito' })
    expect(rig.calls).toEqual([])
    expect(rig.reports).toEqual([])
  })

  it('keeps an admitted run going when the routine is paused', async () => {
    const rig = setup()
    const active = await routine(rig)
    const { run } = await rig.engine.trigger(active.id, { source: 'manual', manual: true })
    await rig.engine.editRoutine(active.id, { active: false })
    expect(rig.engine.run(run.id)?.state).toBe('execucao')
    expect(await rig.engine.settle(run.id, { kind: 'completed', text: 'ok' })).toBe(true)
    expect(rig.engine.run(run.id)?.state).toBe('sucesso_relato')
  })

  it('serializes two occurrences of one routine with distinct ids', async () => {
    const rig = setup()
    const item = await routine(rig, { trigger: 'script', schedule: undefined })
    const [first, second] = await Promise.all([
      rig.engine.trigger(item.id, { source: 'script' }),
      rig.engine.trigger(item.id, { source: 'script' }),
    ])
    expect(first.run.id).not.toBe(second.run.id)
    expect(rig.engine.run(first.run.id)?.state).toBe('execucao')
    expect(rig.engine.run(second.run.id)?.state).toBe('fila')
    expect(rig.starts).toHaveLength(1)
    await rig.engine.settle(first.run.id, { kind: 'completed', text: 'a' })
    expect(rig.engine.run(second.run.id)?.state).toBe('execucao')
    expect(rig.starts).toHaveLength(2)
    expect(rig.engine.history(item.id).map(run => run.id)).toEqual([second.run.id, first.run.id])
  })

  it('does not block other routines', async () => {
    const rig = setup()
    const one = await routine(rig)
    const two = await routine(rig, { name: 'Outra' })
    await rig.engine.trigger(one.id, { source: 'manual', manual: true })
    await rig.engine.trigger(two.id, { source: 'manual', manual: true })
    expect(rig.starts).toHaveLength(2)
  })
})

describe('accepting executions', () => {
  it('keeps the script entry apart from the automatic webhook', async () => {
    const rig = setup()
    const paused = await routine(rig, { active: false })
    expect(await refusal(rig.engine.trigger(paused.id, { source: 'webhook' }))).toBe('rotina_pausada')
    expect(rig.engine.history(paused.id)).toEqual([])
    const live = await routine(rig)
    expect((await rig.engine.trigger(live.id, { source: 'webhook' })).run.source).toBe('webhook')
    const script = await rig.engine.trigger(paused.id, { source: 'script' })
    expect(script.run.state).toBe('execucao')
    expect(rig.engine.view(paused.id).routine.active).toBe(false)
  })

  it('refuses unknown routines, revoked scripts, bad payloads and bad keys before creating a run', async () => {
    const rig = setup()
    const item = await routine(rig, { scriptEnabled: false })
    expect(await refusal(rig.engine.trigger('nada', { source: 'script' }))).toBe('rotina_inexistente')
    expect(await refusal(rig.engine.trigger(item.id, { source: 'script' }))).toBe('script_nao_autorizado')
    const open = await routine(rig, { name: 'Aberta' })
    expect(await refusal(rig.engine.trigger(open.id, { source: 'script', payload: 'x'.repeat(17_000) }))).toBe('payload_grande')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(await refusal(rig.engine.trigger(open.id, { source: 'script', payload: circular }))).toBe('payload_invalido')
    expect(await refusal(rig.engine.trigger(open.id, { source: 'script', payload: () => 1 }))).toBe('payload_invalido')
    expect(await refusal(rig.engine.trigger(open.id, { source: 'script', idempotencyKey: '' }))).toBe('chave_invalida')
    expect(await refusal(rig.engine.trigger(open.id, { source: 'script', idempotencyKey: 'k'.repeat(129) }))).toBe('chave_invalida')
    expect([...rig.store.runs.entries()]).toEqual([])
    expect(rig.starts).toEqual([])
  })

  it('returns the same run for the same key and distinct runs without one', async () => {
    const rig = setup()
    const item = await routine(rig)
    const first = await rig.engine.trigger(item.id, { source: 'script', idempotencyKey: 'k1', payload: { n: 1 } })
    const again = await rig.engine.trigger(item.id, { source: 'script', idempotencyKey: 'k1', payload: { n: 2 } })
    expect(again.duplicate).toBe(true)
    expect(again.run.id).toBe(first.run.id)
    expect(rig.engine.history(item.id)).toHaveLength(1)
    const loose = await rig.engine.trigger(item.id, { source: 'script' })
    const other = await rig.engine.trigger(item.id, { source: 'script' })
    expect(loose.run.id).not.toBe(other.run.id)
  })

  it('hands the payload to the new session as data and never mixes a secret into the run', async () => {
    const rig = setup()
    const item = await routine(rig)
    const { run } = await rig.engine.trigger(item.id, { source: 'script', payload: { fim: 'build', log: 'C:/logs/x.txt', nota: 'use `cmd`' } })
    const prompt = rig.starts[0]?.prompt as string
    expect(prompt).toContain('Resuma o dia.')
    expect(prompt).toContain('[DADOS EXTERNOS]')
    expect(prompt).toContain('"log":"C:/logs/x.txt"')
    expect(prompt).toContain(String.raw`use \u0060cmd\u0060`)
    expect(prompt.indexOf('Resuma o dia.')).toBeLessThan(prompt.indexOf('[DADOS EXTERNOS]'))
    expect(JSON.stringify(rig.store.runs.get(run.id))).not.toContain('Bearer')
    const plain = await rig.engine.trigger(item.id, { source: 'manual' })
    expect(plain.run.source).toBe('manual')
    await rig.engine.settle(run.id, { kind: 'completed', text: 'ok' })
    expect(rig.starts[1]?.prompt).not.toContain('[DADOS EXTERNOS]')
  })

  it('fixes the instruction when a run is admitted and uses the new one afterwards', async () => {
    const rig = setup()
    const item = await routine(rig)
    const first = await rig.engine.trigger(item.id, { source: 'script' })
    const second = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.editRoutine(item.id, { instruction: 'Nova instrução.' })
    expect(rig.engine.run(first.run.id)).toMatchObject({ instruction: 'Resuma o dia.', instructionVersion: 1 })
    await rig.engine.settle(first.run.id, { kind: 'completed', text: 'ok' })
    expect(rig.engine.run(second.run.id)).toMatchObject({ instruction: 'Nova instrução.', instructionVersion: 2 })
    expect(rig.starts[1]?.prompt).toContain('Nova instrução.')
  })

  it('records a failure when the session does not start and moves on', async () => {
    const rig = setup()
    const item = await routine(rig)
    rig.runner.startError = new Error('sem vaga')
    const failed = await rig.engine.trigger(item.id, { source: 'script' })
    expect(failed.run).toMatchObject({ state: 'falha', reason: 'inicio_falhou' })
    expect(failed.run.error).toContain('sem vaga')
    rig.runner.startError = 'texto' as never
    const second = await rig.engine.trigger(item.id, { source: 'script' })
    expect(second.run.error).toContain('texto')
    rig.runner.startError = undefined
    const ok = await rig.engine.trigger(item.id, { source: 'script' })
    expect(ok.run.state).toBe('execucao')
  })

  it('fails a queued run whose routine or agent vanished and skips automatic runs of a paused routine', async () => {
    const rig = setup()
    const item = await routine(rig, { trigger: 'script', schedule: undefined })
    const running = await rig.engine.trigger(item.id, { source: 'script' })
    const queuedScript = await rig.engine.trigger(item.id, { source: 'script' })
    const webhook = await routine(rig, { name: 'Hook' })
    const hookRunning = await rig.engine.trigger(webhook.id, { source: 'webhook' })
    const hookQueued = await rig.engine.trigger(webhook.id, { source: 'webhook' })
    await rig.engine.editRoutine(webhook.id, { active: false })
    await rig.engine.settle(hookRunning.run.id, { kind: 'completed', text: 'ok' })
    expect(rig.engine.run(hookQueued.run.id)).toMatchObject({ state: 'pulada', reason: 'rotina_pausada' })
    rig.agents.delete('a1')
    await rig.engine.settle(running.run.id, { kind: 'completed', text: 'ok' })
    expect(rig.engine.run(queuedScript.run.id)).toMatchObject({ state: 'falha', reason: 'sem_rotina_ou_agente' })
  })
})

describe('criterion 9: report, no update, failure and manual answer', () => {
  it('notifies a report once', async () => {
    const rig = setup()
    const item = await routine(rig)
    const { run } = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.settle(run.id, { kind: 'completed', text: 'Há novidade.' })
    expect(rig.reports).toEqual([{
      runId: run.id, routineId: item.id, agentId: 'a1', routineName: 'Resumo', text: 'Há novidade.',
    }])
    expect(rig.engine.run(run.id)?.notifiedAt).toBeDefined()
    expect(await rig.engine.settle(run.id, { kind: 'completed', text: 'Há novidade.' })).toBe(false)
    expect(rig.reports).toHaveLength(1)
  })

  it('keeps the history and sends nothing when the model says there is no update', async () => {
    const rig = setup()
    const item = await routine(rig)
    const { run } = await rig.engine.trigger(item.id, { source: 'script' })
    const marked = await rig.engine.noUpdate('session-1')
    expect(marked.noUpdate).toBe(true)
    await rig.engine.settle(run.id, { kind: 'completed', text: 'Nada a relatar.' })
    expect(rig.engine.run(run.id)).toMatchObject({ state: 'sucesso_sem_novidade', result: 'Nada a relatar.' })
    expect(rig.reports).toEqual([])
    expect(rig.engine.history(item.id)).toHaveLength(1)
  })

  it('shows the answer of a manual test even when it said no update', async () => {
    const rig = setup()
    const item = await routine(rig)
    const { run } = await rig.engine.trigger(item.id, { source: 'manual', manual: true })
    await rig.engine.noUpdate('session-1')
    await rig.engine.settle(run.id, { kind: 'completed', text: 'Sem mudanças hoje.' })
    expect(rig.engine.view(item.id).runs[0]).toMatchObject({ state: 'sucesso_sem_novidade', result: 'Sem mudanças hoje.', manual: true })
    expect(rig.reports).toEqual([])
  })

  it('never shows a failure as no update', async () => {
    const rig = setup()
    const item = await routine(rig)
    const { run } = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.noUpdate('session-1')
    await rig.engine.settle(run.id, { kind: 'failed', message: 'ferramenta quebrou' })
    expect(rig.engine.run(run.id)).toMatchObject({ state: 'falha', error: 'ferramenta quebrou', reason: 'falha' })
    expect(rig.reports).toEqual([])
  })

  it('refuses no-update from a session that runs no routine', async () => {
    const rig = setup()
    expect(await refusal(rig.engine.noUpdate('qualquer'))).toBe('sem_execucao')
    const item = await routine(rig)
    const { run } = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.settle(run.id, { kind: 'cancelled' })
    expect(rig.engine.run(run.id)?.state).toBe('cancelada')
    expect(await refusal(rig.engine.noUpdate('session-1'))).toBe('sem_execucao')
  })

  it('keeps the report in the run when the notification cannot be delivered', async () => {
    const rig = setup()
    const item = await routine(rig)
    rig.notifier.fails = true
    const { run } = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.settle(run.id, { kind: 'completed', text: 'relato' })
    expect(rig.engine.run(run.id)).toMatchObject({ state: 'sucesso_relato', result: 'relato' })
    expect(rig.engine.run(run.id)?.notifiedAt).toBeUndefined()
    expect(rig.warnings.some(item => item.includes('notification failed'))).toBe(true)
    await rig.engine.deleteRoutine(item.id)
    const gone = await routine(rig, { name: 'Outra' })
    const next = await rig.engine.trigger(gone.id, { source: 'script' })
    rig.notifier.fails = false
    await rig.store.routines.delete(gone.id)
    await rig.engine.settle(next.run.id, { kind: 'completed', text: 'x' })
    expect(rig.reports[0]?.routineName).toBe(gone.id)
  })
})

describe('cancelling', () => {
  it('cancels queued, waiting and running executions', async () => {
    const rig = setup()
    const item = await routine(rig)
    const running = await rig.engine.trigger(item.id, { source: 'script' })
    const queued = await rig.engine.trigger(item.id, { source: 'script' })
    expect((await rig.engine.cancel(queued.run.id)).state).toBe('cancelada')
    rig.runner.cancelError = new Error('já morreu')
    const stopped = await rig.engine.cancel(running.run.id)
    expect(stopped).toMatchObject({ state: 'cancelada', reason: 'cancelada_pelo_usuario' })
    expect(rig.cancels).toEqual(['session-1'])
    expect(rig.warnings.some(item => item.includes('cancel failed'))).toBe(true)
    rig.runner.cancelError = undefined
    const waiting = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.settle(waiting.run.id, { kind: 'limit' })
    expect((await rig.engine.cancel(waiting.run.id)).state).toBe('cancelada')
    expect(await refusal(rig.engine.cancel(waiting.run.id))).toBe('execucao_encerrada')
    expect(await refusal(rig.engine.cancel('nada'))).toBe('execucao_inexistente')
  })

  it('starts the next queued run after a cancellation', async () => {
    const rig = setup()
    const item = await routine(rig)
    const first = await rig.engine.trigger(item.id, { source: 'script' })
    const second = await rig.engine.trigger(item.id, { source: 'script' })
    await rig.engine.cancel(first.run.id)
    expect(rig.engine.run(second.run.id)?.state).toBe('execucao')
  })
})
