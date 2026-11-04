/** Routine engine: registration, one record per execution, queue, quota wait, missed occurrences and notification. */
import { RoutineError } from './errors.ts'
import { MAX_PAYLOAD_BYTES, buildPrompt } from './prompt.ts'
import { nextOccurrence, occurrencesBetween, validateSchedule } from './timing.ts'
import type {
  AgentInfo, AgentResolver, Notifier, Outcome, Routine, RoutineInput, RoutinePatch,
  RoutineStore, Run, RunSource, RunnerPort, ScheduleGateway, ScheduleTaskSpec,
} from './types.ts'

/** Dependencies and tunables of the engine. */
export interface EngineOptions {
  readonly store: RoutineStore
  readonly schedule: ScheduleGateway
  readonly agents: AgentResolver
  readonly runner: RunnerPort
  readonly notify: Notifier
  /** Wall clock in epoch milliseconds. */
  readonly now: () => number
  /** Fresh identifier with the given prefix. */
  readonly newId: (prefix: string) => string
  readonly warn: (message: string) => void
  /** Seconds between quota re-checks when the provider gave no renewal time; the last value repeats. */
  readonly backoffSeconds: readonly number[]
  /** Seconds a delivery may lag its planned instant before it counts as an occurrence caught up after downtime. */
  readonly graceSeconds: number
}

/** Receipt of one delivery made by the host scheduler. */
export interface Delivery {
  readonly messageId: string
  readonly scheduledAt: string
  readonly deliveredAt: string
  readonly sessionId: string
}

/** Answer of a trigger: the run and whether it already existed. */
export interface TriggerResult {
  readonly run: Run
  readonly duplicate: boolean
}

const MAX_NAME = 120
const MAX_KEY = 128

/** Strip the optional values the tables reject and apply a patch of definite fields. */
function withFields<T extends object>(base: T, fields: Partial<Record<keyof T, unknown>>): T {
  const merged: Record<string, unknown> = { ...base, ...fields }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as T
}

function checkZone(zone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
  } catch (error) {
    throw new RoutineError('fuso_invalido', `fuso "${zone}" não é um fuso IANA válido`, { cause: error })
  }
}

/** Execution engine over a store, the host scheduler and a session runner. */
export class RoutineEngine {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: EngineOptions) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }

  private get routines() { return this.options.store.routines }
  private get runs() { return this.options.store.runs }
  private iso(): string { return new Date(this.options.now()).toISOString() }

  private require(id: string): Routine {
    const routine = this.routines.get(id)
    if (routine === undefined) throw new RoutineError('rotina_inexistente', `rotina "${id}" não existe`)
    return routine
  }

  private agentOf(routine: Routine): AgentInfo {
    const agent = this.options.agents(routine.agentId)
    if (agent === undefined) throw new RoutineError('agente_inexistente', `agente "${routine.agentId}" não existe`)
    return agent
  }

  private runsOf(routineId: string): Run[] {
    return [...this.runs.entries()].map(([, run]) => run).filter(run => run.routineId === routineId)
  }

  private taskSpec(routine: Routine, agent: AgentInfo): ScheduleTaskSpec {
    return {
      title: routine.name,
      prompt: buildPrompt(routine.instruction, undefined),
      active: routine.active && !routine.consumed,
      ...agent.preset === undefined ? {} : { agentPreset: agent.preset },
      ...agent.cwd === undefined ? {} : { cwd: agent.cwd },
      spec: routine.schedule as NonNullable<Routine['schedule']>,
      timeZone: routine.timeZone,
    }
  }

  // ---- registration --------------------------------------------------------------------------------------------

  /**
   * Register a routine and, when it has a calendar, its task on the host scheduler.
   * @param input - fields of the new routine.
   * @returns the stored routine.
   * @throws RoutineError when a field is invalid; nothing is saved then.
   */
  createRoutine(input: RoutineInput): Promise<Routine> {
    return this.serial(async () => {
      const agent = this.options.agents(input.agentId)
      if (agent === undefined) throw new RoutineError('agente_inexistente', `agente "${input.agentId}" não existe`)
      const trigger = input.trigger ?? (input.schedule === undefined ? 'script' : 'schedule')
      const now = this.options.now()
      const routine = this.validated({
        id: this.options.newId('routine'),
        agentId: input.agentId,
        ...input.ownerId === undefined ? {} : { ownerId: input.ownerId },
        name: input.name,
        instruction: input.instruction,
        instructionVersion: 1,
        trigger,
        ...input.schedule === undefined ? {} : { schedule: input.schedule },
        timeZone: input.timeZone ?? 'UTC',
        active: input.active ?? true,
        limitPolicy: input.limitPolicy ?? 'wait',
        missedPolicy: input.missedPolicy ?? (input.schedule?.kind === 'once' ? 'run-once' : 'skip'),
        scriptEnabled: input.scriptEnabled ?? true,
        consumed: false,
        lastSeenAt: new Date(now).toISOString(),
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      }, input.timeZone !== undefined)
      if (routine.trigger !== 'schedule') {
        await this.routines.put(routine.id, routine)
        return routine
      }
      const taskId = await this.options.schedule.create(this.taskSpec(routine, agent))
      const saved = { ...routine, scheduleTaskId: taskId }
      try {
        await this.routines.put(saved.id, saved)
      } catch (error) {
        await this.options.schedule.remove(taskId).catch((cause: unknown) => { this.options.warn(`agent-routine: rollback failed: ${String(cause)}`) })
        throw error
      }
      return saved
    })
  }

  /** Check one routine as a whole; throws before anything is stored. */
  private validated(routine: Routine, zoneGiven: boolean): Routine {
    const name = routine.name.trim()
    const instruction = routine.instruction.trim()
    if (name === '' || name.length > MAX_NAME) throw new RoutineError('nome_invalido', `o nome deve ter de 1 a ${MAX_NAME} caracteres`)
    if (instruction === '') throw new RoutineError('instrucao_vazia', 'a instrução não pode ficar vazia')
    if (routine.trigger === 'schedule' && routine.schedule === undefined) {
      throw new RoutineError('agenda_obrigatoria', 'uma rotina por agenda precisa de agenda')
    }
    if (routine.trigger === 'script' && routine.schedule !== undefined) {
      throw new RoutineError('agenda_sobrando', 'uma rotina só por script não tem agenda')
    }
    if (routine.schedule !== undefined && !zoneGiven) {
      throw new RoutineError('fuso_obrigatorio', 'informe o fuso IANA da agenda')
    }
    checkZone(routine.timeZone)
    if (routine.schedule !== undefined) {
      validateSchedule(routine.schedule, routine.timeZone, this.options.now())
      if (routine.schedule.kind === 'once' && routine.limitPolicy === 'skip') {
        throw new RoutineError('politica_invalida', 'a ocorrência única sempre espera a cota')
      }
    }
    return { ...routine, name, instruction }
  }

  /**
   * Change a routine. Only the given fields change; an invalid change saves nothing.
   * @param id - routine id.
   * @param patch - fields to change.
   * @returns the stored routine.
   */
  editRoutine(id: string, patch: RoutinePatch): Promise<Routine> {
    return this.serial(async () => {
      const current = this.require(id)
      if (patch.active === true && current.consumed) {
        throw new RoutineError('rotina_consumida', 'a ocorrência única já foi consumida; crie outra rotina')
      }
      const trigger = patch.trigger ?? (patch.schedule !== undefined ? 'schedule' : current.trigger)
      const changes = Object.fromEntries(Object.entries({
        name: patch.name,
        instruction: patch.instruction,
        timeZone: patch.timeZone,
        active: patch.active,
        limitPolicy: patch.limitPolicy,
        missedPolicy: patch.missedPolicy,
        scriptEnabled: patch.scriptEnabled,
      }).filter(([, value]) => value !== undefined))
      const schedule = trigger === 'script' ? undefined : patch.schedule ?? current.schedule
      const { schedule: _previous, ...rest } = { ...current, ...changes, trigger }
      const merged = this.validated(schedule === undefined ? rest : { ...rest, schedule }, true)
      const now = this.options.now()
      const next: Routine = {
        ...merged,
        instructionVersion: merged.instruction === current.instruction ? current.instructionVersion : current.instructionVersion + 1,
        updatedAt: new Date(now).toISOString(),
        ...patch.active === true && !current.active ? { lastSeenAt: new Date(now).toISOString() } : {},
      }
      return this.applyRoutine(current, next)
    })
  }

  /** Move the scheduler task and the stored routine together, undoing the task when the store fails. */
  private async applyRoutine(current: Routine, next: Routine): Promise<Routine> {
    const agent = this.agentOf(next)
    let saved = next
    let undo: (() => Promise<void>) | undefined
    if (next.trigger === 'schedule') {
      if (current.scheduleTaskId === undefined) {
        const taskId = await this.options.schedule.create(this.taskSpec(next, agent))
        saved = { ...next, scheduleTaskId: taskId }
        undo = () => this.options.schedule.remove(taskId)
      } else {
        await this.options.schedule.update(current.scheduleTaskId, this.taskSpec(next, agent))
        undo = () => this.options.schedule.update(current.scheduleTaskId as string, this.taskSpec(current, agent))
      }
    } else if (current.scheduleTaskId !== undefined) {
      await this.options.schedule.remove(current.scheduleTaskId)
      const { scheduleTaskId: _removed, ...rest } = next
      saved = rest
    }
    try {
      await this.routines.put(saved.id, saved)
    } catch (error) {
      await undo?.().catch((cause: unknown) => { this.options.warn(`agent-routine: rollback failed: ${String(cause)}`) })
      throw error
    }
    return saved
  }

  /**
   * Remove a routine with its task and history; executions in flight are cancelled first.
   * @param id - routine id.
   */
  deleteRoutine(id: string): Promise<void> {
    return this.serial(async () => {
      const routine = this.require(id)
      for (const run of this.runsOf(id)) {
        if (run.state === 'execucao' && run.sessionId !== undefined) await this.stopSession(run.sessionId)
      }
      if (routine.scheduleTaskId !== undefined) await this.options.schedule.remove(routine.scheduleTaskId)
      for (const run of this.runsOf(id)) await this.runs.delete(run.id)
      await this.routines.delete(id)
    })
  }

  /**
   * One routine with its next calendar fire and recent executions.
   * @param id - routine id.
   * @param limit - number of executions to include.
   * @returns the view.
   */
  view(id: string, limit = 10): { routine: Routine; nextFireAt?: string; runs: Run[] } {
    const routine = this.require(id)
    const spec = routine.active && !routine.consumed ? routine.schedule : undefined
    return {
      routine,
      ...spec === undefined ? {} : { nextFireAt: nextOccurrence(spec, routine.timeZone, this.options.now()) },
      // The calendar of a consumed or paused routine has no next fire.
      runs: this.history(id, limit),
    }
  }

  /**
   * All routines, optionally of one agent, newest first.
   * @param agentId - only this agent's routines.
   * @returns the routines.
   */
  list(agentId?: string): Routine[] {
    return [...this.routines.entries()].map(([, routine]) => routine)
      .filter(routine => agentId === undefined || routine.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  }

  /**
   * Executions of a routine, newest first.
   * @param routineId - routine id.
   * @param limit - maximum number to return.
   * @returns the executions.
   */
  history(routineId: string, limit = 20): Run[] {
    return this.runsOf(routineId).sort((left, right) => right.seq - left.seq).slice(0, limit)
  }

  /**
   * One execution.
   * @param runId - execution id.
   * @returns the execution or undefined.
   */
  run(runId: string): Run | undefined {
    return this.runs.get(runId)
  }

  // ---- accepting executions ------------------------------------------------------------------------------------

  /**
   * Accept an execution of a routine. The answer proves persistence, not completion.
   * @param routineId - routine id.
   * @param request - source, optional payload, idempotency key and planned instant.
   * @returns the run and whether the key had already produced it.
   * @throws RoutineError when the routine cannot be run by this source or the request is invalid.
   */
  trigger(routineId: string, request: {
    source: Exclude<RunSource, 'agenda'>
    manual?: boolean
    payload?: unknown
    idempotencyKey?: string
  }): Promise<TriggerResult> {
    return this.serial(async () => {
      const routine = this.require(routineId)
      const key = request.idempotencyKey
      if (key !== undefined && (key === '' || key.length > MAX_KEY)) {
        throw new RoutineError('chave_invalida', `a chave de idempotência deve ter de 1 a ${MAX_KEY} caracteres`)
      }
      if (request.source === 'webhook' && !routine.active) {
        throw new RoutineError('rotina_pausada', 'o webhook automático respeita a pausa da rotina')
      }
      if (request.source === 'script' && !routine.scriptEnabled) {
        throw new RoutineError('script_nao_autorizado', 'a rotina não aceita disparo por script')
      }
      if (key !== undefined) {
        const existing = this.runsOf(routineId).find(run => run.idempotencyKey === key)
        if (existing !== undefined) return { run: existing, duplicate: true }
      }
      const payload = this.payloadText(request.payload)
      const run = await this.accept(routine, {
        source: request.source,
        manual: request.manual ?? false,
        ...payload === undefined ? {} : { payload },
        ...key === undefined ? {} : { idempotencyKey: key },
      })
      await this.drainAll()
      return { run: this.runs.get(run.id) as Run, duplicate: false }
    })
  }

  private payloadText(payload: unknown): string | undefined {
    if (payload === undefined) return undefined
    let text: unknown
    try {
      text = JSON.stringify(payload)
    } catch (error) {
      throw new RoutineError('payload_invalido', 'o payload precisa ser JSON', { cause: error })
    }
    if (typeof text !== 'string') throw new RoutineError('payload_invalido', 'o payload precisa ser JSON')
    if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
      throw new RoutineError('payload_grande', `o payload passa de ${MAX_PAYLOAD_BYTES} bytes`)
    }
    // A backtick only occurs inside JSON strings, where the escape keeps the fenced block closed.
    return text.replaceAll(String.fromCodePoint(96), '\\u0060')
  }

  private nextSeq(): number {
    let highest = 0
    for (const [, run] of this.runs.entries()) highest = Math.max(highest, run.seq)
    return highest + 1
  }

  /** Store one new run in the queue. */
  private async accept(routine: Routine, fields: Partial<Run> & Pick<Run, 'source' | 'manual'>): Promise<Run> {
    const run: Run = {
      id: this.options.newId('run'),
      seq: this.nextSeq(),
      routineId: routine.id,
      agentId: routine.agentId,
      ...routine.ownerId === undefined ? {} : { ownerId: routine.ownerId },
      acceptedAt: this.iso(),
      state: 'fila',
      quotaChecks: 0,
      uncertain: false,
      noUpdate: false,
      ...fields,
    }
    await this.runs.put(run.id, run)
    return run
  }

  // ---- calendar deliveries -------------------------------------------------------------------------------------

  /**
   * Record a delivery made by the host scheduler. The same delivery is recorded once.
   * @param routineId - routine whose task fired.
   * @param delivery - receipt with the session the scheduler created.
   * @returns the run, or undefined when the routine no longer exists.
   */
  observeDelivery(routineId: string, delivery: Delivery): Promise<Run | undefined> {
    return this.serial(async () => {
      const routine = this.routines.get(routineId)
      if (routine?.schedule === undefined) return undefined
      const known = this.runsOf(routineId).find(run => run.deliveryKey === delivery.messageId || run.scheduledAt === delivery.scheduledAt)
      if (known !== undefined) return known
      const spec = routine.schedule
      const planned = Date.parse(delivery.scheduledAt)
      const seenAt = Date.parse(routine.lastSeenAt)
      const late = Date.parse(delivery.deliveredAt) - planned > this.options.graceSeconds * 1000
      // A late delivery while the process kept seeing the clock is a slow flush, not a downtime gap.
      const downtime = late && Number.isFinite(seenAt) && seenAt < planned
      const missed = downtime ? occurrencesBetween(spec, routine.timeZone, seenAt, planned - 1) : []
      let outcome: Run
      if (!routine.active) {
        outcome = await this.skipped(routine, delivery, 'rotina_pausada')
      } else if (downtime && routine.missedPolicy === 'skip') {
        for (const occurrence of missed) await this.skippedOccurrence(routine, occurrence, 'desligamento')
        outcome = await this.skipped(routine, delivery, 'desligamento')
      } else {
        for (const occurrence of missed) await this.skippedOccurrence(routine, occurrence, 'suprimida')
        outcome = await this.admitDelivery(routine, delivery)
      }
      await this.routines.put(routineId, {
        ...routine,
        lastSeenAt: this.iso(),
        // A skipped occurrence (for example a paused one-time routine) is not consumed; a resume may still run it.
        ...spec.kind === 'once' && outcome.state !== 'pulada' ? { active: false, consumed: true } : {},
      })
      return outcome
    })
  }

  private async skipped(routine: Routine, delivery: Delivery, reason: string): Promise<Run> {
    await this.stopSession(delivery.sessionId)
    const run = await this.accept(routine, {
      source: 'agenda', manual: false, scheduledAt: delivery.scheduledAt, deliveryKey: delivery.messageId,
      state: 'pulada', reason, endedAt: this.iso(),
    })
    return run
  }

  private async skippedOccurrence(routine: Routine, occurrence: string, reason: string): Promise<void> {
    const key = `${routine.id}@${occurrence}`
    if (this.runsOf(routine.id).some(run => run.deliveryKey === key || run.scheduledAt === occurrence)) return
    await this.accept(routine, {
      source: 'agenda', manual: false, scheduledAt: occurrence, deliveryKey: key, state: 'pulada', reason, endedAt: this.iso(),
    })
  }

  private async admitDelivery(routine: Routine, delivery: Delivery): Promise<Run> {
    // The scheduler opened a session for its `new` target; routines own the only execution session,
    // so stop that one and let the single queue start the run through the runner.
    await this.stopSession(delivery.sessionId)
    const run = await this.accept(routine, {
      source: 'agenda', manual: false, scheduledAt: delivery.scheduledAt, deliveryKey: delivery.messageId,
    })
    await this.drain(routine.id)
    return this.runs.get(run.id) as Run
  }

  /** A calendar or webhook run waits while its routine is paused; a one-time routine pauses itself when it fires, and its run goes on. */
  private blocked(run: Run, routine: Routine): boolean {
    const automatic = run.source === 'agenda' || run.source === 'webhook'
    return automatic && !routine.active && !routine.consumed
  }

  private async stopSession(sessionId: string): Promise<void> {
    await this.options.runner.cancel(sessionId).catch((error: unknown) => { this.options.warn(`agent-routine: cancel failed: ${String(error)}`) })
  }

  // ---- queue and admission -------------------------------------------------------------------------------------

  private async drainAll(): Promise<void> {
    const ids = new Set([...this.runs.entries()].filter(([, run]) => run.state === 'fila').map(([, run]) => run.routineId))
    for (const id of ids) await this.drain(id)
  }

  /** Start queued runs of one routine, one at a time, until the slot is taken. */
  private async drain(routineId: string): Promise<void> {
    for (;;) {
      const all = this.runsOf(routineId)
      if (all.some(run => run.state === 'execucao')) return
      const routine = this.routines.get(routineId)
      // A waiting automatic run of a paused routine does not hold the slot against an explicit script or manual run.
      const occupied = all.some(run => run.state === 'espera_cota' && (routine === undefined || !this.blocked(run, routine)))
      if (occupied) return
      const next = all.filter(run => run.state === 'fila').sort((left, right) => left.seq - right.seq)[0]
      if (next === undefined) return
      await this.admit(next)
    }
  }

  /** Admit a queued run: fix the instruction version and start its session. */
  private async admit(run: Run): Promise<void> {
    const routine = this.routines.get(run.routineId)
    const agent = routine === undefined ? undefined : this.options.agents(routine.agentId)
    if (routine === undefined || agent === undefined) {
      await this.finish(run, 'falha', { error: 'a rotina ou o agente não existe mais', reason: 'sem_rotina_ou_agente' })
      return
    }
    if (this.blocked(run, routine)) {
      await this.finish(run, 'pulada', { reason: 'rotina_pausada' })
      return
    }
    const admitted: Run = {
      ...run, state: 'execucao', startedAt: this.iso(), instruction: routine.instruction, instructionVersion: routine.instructionVersion,
    }
    delete (admitted as { reason?: string }).reason
    await this.runs.put(run.id, admitted)
    await this.launch(admitted, agent)
  }

  /** Start the session of an admitted run and record it. */
  private async launch(run: Run, agent: AgentInfo): Promise<void> {
    try {
      const { sessionId } = await this.options.runner.start({
        runId: run.id, agent, prompt: buildPrompt(run.instruction as string, run.payload),
      })
      await this.runs.put(run.id, { ...run, sessionId })
    } catch (error) {
      await this.finish(run, 'falha', { error: `a sessão não iniciou: ${String(error instanceof Error ? error.message : error)}`, reason: 'inicio_falhou' })
    }
  }

  private async finish(run: Run, state: Run['state'], fields: Partial<Run> = {}): Promise<Run> {
    const done = withFields(run, { ...fields, state, endedAt: this.iso() })
    await this.runs.put(run.id, done)
    return done
  }

  // ---- outcomes ------------------------------------------------------------------------------------------------

  /**
   * Record how a started run ended and free the slot.
   * @param runId - execution id.
   * @param outcome - result reported by the runner.
   * @returns false when the run was not running.
   */
  settle(runId: string, outcome: Outcome): Promise<boolean> {
    return this.serial(async () => {
      const run = this.runs.get(runId)
      if (run?.state !== 'execucao') return false
      await this.apply(run, outcome)
      await this.drain(run.routineId)
      return true
    })
  }

  private async apply(run: Run, outcome: Outcome): Promise<void> {
    switch (outcome.kind) {
      case 'completed': {
        const state = run.noUpdate && outcome.text.trim() === '' ? 'sucesso_sem_novidade' : 'sucesso_relato'
        const done = await this.finish(run, state, { result: outcome.text })
        if (state === 'sucesso_relato' && !run.manual) await this.notifyOnce(done)
        return
      }
      case 'limit': return this.limit(run, outcome)
      case 'auth': {
        await this.finish(run, 'falha', { error: outcome.message, reason: 'autenticacao' })
        return
      }
      case 'failed': {
        await this.finish(run, 'falha', { error: outcome.message, reason: 'falha' })
        return
      }
      case 'cancelled': {
        await this.finish(run, 'cancelada')
      }
    }
  }

  private async notifyOnce(run: Run): Promise<void> {
    const routine = this.routines.get(run.routineId)
    try {
      await this.options.notify({
        runId: run.id,
        routineId: run.routineId,
        agentId: run.agentId,
        routineName: routine?.name ?? run.routineId,
        text: run.result as string,
      })
      await this.runs.put(run.id, { ...run, notifiedAt: this.iso() })
    } catch (error) {
      this.options.warn(`agent-routine: notification failed: ${String(error)}`)
    }
  }

  private async limit(run: Run, outcome: Extract<Outcome, { kind: 'limit' }>): Promise<void> {
    const routine = this.routines.get(run.routineId)
    const message = outcome.message ?? 'limite de uso do provedor'
    if (outcome.afterEffects === true) {
      await this.finish(run, 'falha', { error: message, reason: 'limite_apos_efeitos_requer_decisao', uncertain: true })
      return
    }
    const automatic = run.source === 'agenda' || run.source === 'webhook'
    if (automatic && routine?.limitPolicy === 'skip') {
      await this.finish(run, 'pulada', { reason: 'cota' })
      return
    }
    const delays = this.options.backoffSeconds.length === 0 ? [300, 900, 3600] : this.options.backoffSeconds
    const resetMs = outcome.resetAt === undefined ? undefined : Date.parse(outcome.resetAt)
    const validReset = resetMs !== undefined && Number.isFinite(resetMs) && resetMs > this.options.now()
    const wait = validReset ? resetMs - this.options.now() : (delays[Math.min(run.quotaChecks, delays.length - 1)] as number) * 1000
    const next = new Date(validReset ? resetMs : this.options.now() + wait).toISOString()
    const waiting = withFields(run, {
      state: 'espera_cota',
      reason: `cota: ${message}`,
      eligibleAt: validReset ? outcome.resetAt : undefined,
      nextCheckAt: next,
      quotaChecks: run.quotaChecks + 1,
      endedAt: undefined,
    })
    await this.runs.put(run.id, waiting)
  }

  /**
   * Mark the run of a session as "nothing to report". No notification follows.
   * @param sessionId - session of the calling agent.
   * @returns the affected run.
   * @throws RoutineError when the session belongs to no running execution.
   */
  noUpdate(sessionId: string): Promise<Run> {
    return this.serial(async () => {
      const run = [...this.runs.entries()].map(([, item]) => item).find(item => item.sessionId === sessionId && item.state === 'execucao')
      if (run === undefined) throw new RoutineError('sem_execucao', 'esta sessão não está executando uma rotina')
      const marked = { ...run, noUpdate: true }
      await this.runs.put(run.id, marked)
      return marked
    })
  }

  /**
   * Cancel an execution that is queued, waiting for quota or running.
   * @param runId - execution id.
   * @returns the cancelled run.
   */
  cancel(runId: string): Promise<Run> {
    return this.serial(async () => {
      const run = this.runs.get(runId)
      if (run === undefined) throw new RoutineError('execucao_inexistente', `execução "${runId}" não existe`)
      if (run.state !== 'fila' && run.state !== 'espera_cota' && run.state !== 'execucao') {
        throw new RoutineError('execucao_encerrada', 'a execução já terminou')
      }
      if (run.state === 'execucao' && run.sessionId !== undefined) await this.stopSession(run.sessionId)
      const done = await this.finish(run, 'cancelada', { reason: 'cancelada_pelo_usuario' })
      await this.drain(run.routineId)
      return done
    })
  }

  // ---- ticks and recovery --------------------------------------------------------------------------------------

  /**
   * Re-check runs waiting for quota whose time came and start queued runs. Safe to call often.
   */
  tick(): Promise<void> {
    return this.serial(async () => {
      const now = this.options.now()
      for (const [, run] of [...this.runs.entries()]) {
        if (run.state !== 'espera_cota' || Date.parse(run.nextCheckAt as string) > now) continue
        const routine = this.routines.get(run.routineId)
        if (routine !== undefined && this.blocked(run, routine)) continue
        const agent = routine === undefined ? undefined : this.options.agents(routine.agentId)
        if (agent === undefined) {
          await this.finish(run, 'falha', { error: 'a rotina ou o agente não existe mais', reason: 'sem_rotina_ou_agente' })
          continue
        }
        const resumed = withFields(run, { state: 'execucao', reason: undefined, nextCheckAt: undefined, eligibleAt: undefined })
        await this.runs.put(run.id, resumed)
        await this.launch(resumed, agent)
      }
      // A report whose notification failed is retried once per tick until it is stamped.
      for (const [, run] of [...this.runs.entries()]) {
        if (run.state === 'sucesso_relato' && !run.manual && run.notifiedAt === undefined) await this.notifyOnce(run)
      }
      for (const [id, routine] of [...this.routines.entries()]) {
        if (routine.active && routine.trigger === 'schedule' && now - Date.parse(routine.lastSeenAt) >= 60_000) {
          await this.routines.put(id, { ...routine, lastSeenAt: new Date(now).toISOString() })
        }
      }
      await this.drainAll()
    })
  }

  /**
   * After a restart: a run that was executing is recorded as interrupted and uncertain, never repeated by itself;
   * queued and waiting runs continue.
   */
  recover(): Promise<void> {
    return this.serial(async () => {
      for (const [, run] of [...this.runs.entries()]) {
        if (run.state === 'execucao') {
          await this.finish(run, 'falha', { error: 'a execução foi interrompida pelo desligamento', reason: 'interrompida', uncertain: true })
        }
      }
      await this.drainAll()
    })
  }
}
