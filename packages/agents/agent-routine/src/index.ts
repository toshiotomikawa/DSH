/**
 * Per-agent routines over the host scheduler: a fresh session for every execution, one record per execution,
 * a queue, a persistent wait for quota, missed-occurrence policies and an authenticated local entry for scripts.
 * @module @deepseek-ai/dsh-agent-routine
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { ScheduleId, ScheduleInputError } from '@deepseek-ai/dsh-schedule'
import type { ScheduleCatalogEntry, ScheduleEditRequest, ScheduleEditResult } from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { RoutineEngine } from './engine.ts'
import { toTiming } from './timing.ts'
import { routineDomain } from './storage.ts'
import { TRIGGER_PATH, createTriggerHandler, loadToken } from './trigger.ts'
import type { AgentResolver, RunnerPort, ScheduleGateway, ScheduleTaskSpec } from './types.ts'

export type * from './types.ts'
export { RoutineEngine } from './engine.ts'
export type { Delivery, EngineOptions, TriggerResult } from './engine.ts'
export { RoutineError } from './errors.ts'
export { MIN_INTERVAL_SECONDS, occurrencesBetween, validateSchedule } from './timing.ts'
export { MAX_PAYLOAD_BYTES, buildPrompt } from './prompt.ts'
export { TRIGGER_PATH, createTriggerHandler, loadToken } from './trigger.ts'
export { routineDomain } from './storage.ts'

/** What the agent registry and the session layer provide to routines; supplied by the composition. */
export interface RoutineBridge {
  /** Resolve a persistent agent by its stable id. */
  readonly agents: AgentResolver
  /** Persistent agent that owns a session, when known; lets tools default to the calling agent. */
  readonly agentOfSession?: (sessionId: string) => string | undefined
  /** Start and stop sessions of admitted executions; outcomes return through `ctx.agentRoutines.engine.settle`. */
  readonly runner: RunnerPort
}

/** Report of an execution that deserves attention. */
export interface RoutineReport {
  readonly runId: string
  readonly routineId: string
  readonly agentId: string
  readonly routineName: string
  readonly text: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-agent routines. */
    agentRoutines: AgentRoutines
    /** Optional bridge to the agent registry and the session layer. */
    agentRoutineBridge: RoutineBridge
  }
  interface Events {
    /**
     * A routine produced a report for the user; consumers deliver it (inbox, mailbox, notification).
     * @mode emit
     */
    'agent-routine/report'(report: RoutineReport): void
  }
}

/** Plugin settings. */
export interface Config {
  /** Token file; omitted follows `$DSH_HOME/agent-routines.token`, then `~/.dsh/agent-routines.token`. */
  tokenFile?: string
  /** Seconds between checks of waiting runs; default 60. */
  tickSeconds?: number
  /** Seconds a delivery may lag before it counts as a missed occurrence; default 120. */
  graceSeconds?: number
  /** Seconds between quota re-checks when the provider names no renewal time; default 300, 900, 3600. */
  backoffSeconds?: number[]
}

const ConfigSchema: z<Config> = z.object({
  tokenFile: z.string(),
  tickSeconds: z.number().step(1).min(1).max(3600).default(60),
  graceSeconds: z.number().step(1).min(1).max(86_400).default(120),
  backoffSeconds: z.array(z.number().step(1).min(1).max(86_400)).default([300, 900, 3600]),
})

// Only this gateway can mutate the engine's calendar; model arguments cannot mint a permitted request.
const routineEdits = new WeakSet<ScheduleEditRequest>()

async function editCalendar(ctx: Context, request: ScheduleEditRequest): Promise<ScheduleEditResult> {
  routineEdits.add(request)
  try {
    return await ctx.schedule.edit(request)
  } finally {
    routineEdits.delete(request)
  }
}

/**
 * Adapter from the engine's gateway to `ctx.schedule`: every execution gets a fresh session (`new` target) of the
 * agent's preset.
 * @param ctx - context that holds `schedule`.
 * @returns the gateway.
 */
export function scheduleGateway(ctx: Context): ScheduleGateway {
  const fields = (task: ScheduleTaskSpec) => ({
    title: task.title,
    prompt: task.prompt,
    timing: toTiming(task.spec, task.timeZone),
    target: {
      kind: 'new' as const,
      create: {
        ...task.agentPreset === undefined ? {} : { agentPreset: task.agentPreset },
        ...task.cwd === undefined ? {} : { cwd: task.cwd },
      },
    },
  })
  const created = (entry: ScheduleCatalogEntry): string => entry.id
  const checked = (result: ScheduleEditResult): void => {
    if ('code' in result) throw new Error(`schedule: ${result.code}`)
  }
  return {
    async create(task) {
      const entry = await ctx.schedule.create(fields(task))
      if (!task.active) checked(await editCalendar(ctx, { id: entry.id, action: 'update', patch: { active: false } }))
      return created(entry)
    },
    async update(id, task) {
      checked(await editCalendar(ctx, { id: ScheduleId(id), action: 'update', patch: { ...fields(task), active: task.active } }))
    },
    async remove(id) {
      checked(await editCalendar(ctx, { id: ScheduleId(id), action: 'delete' }))
    },
  }
}

/** The `ctx.agentRoutines` service: opens the routine domain and wires the engine to the scheduler and web server. */
export class AgentRoutines extends Service {
  /** Host services needed before routines work. */
  static inject = ['storageDomain', 'schedule', 'webServer']
  static Config: z<Config> = ConfigSchema

  /** The engine; defined once the service is ready. */
  engine!: RoutineEngine

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'agentRoutines')
  }

  async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const config = this.config
    const domain = await ctx.storageDomain.open(routineDomain)
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const tokenFile = config.tokenFile ?? join(home, 'agent-routines.token')
    const token = await loadToken(tokenFile)
    const bridge = (): RoutineBridge | undefined => ctx.get('agentRoutineBridge')
    this.engine = new RoutineEngine({
      store: { routines: domain.table('routines'), runs: domain.table('runs') },
      schedule: scheduleGateway(ctx),
      agents: id => bridge()?.agents(id),
      runner: {
        // A missing bridge is a visible failure: the run is recorded as failed and the warning explains why.
        start: (input) => {
          const current = bridge()
          /* v8 ignore next -- the bridge that resolved the agent can vanish between admission and launch */
          if (current === undefined) return Promise.reject(new Error('agent-routine: bridge unavailable'))
          return current.runner.start(input)
        },
        cancel: (sessionId) => {
          const current = bridge()
          if (current === undefined) return Promise.reject(new Error('agent-routine: bridge unavailable'))
          return current.runner.cancel(sessionId)
        },
      },
      notify: (report) => { ctx.emit('agent-routine/report', report) },
      now: () => Date.now(),
      newId: prefix => `${prefix}-${randomUUID()}`,
      warn: (message) => { ctx.logger.warn(message) },
      backoffSeconds: config.backoffSeconds as number[],
      graceSeconds: config.graceSeconds as number,
    })
    const engine = this.engine
    ctx.on('schedule/validate-edit', (request) => {
      if (!routineEdits.has(request) && engine.list().some(routine => routine.scheduleTaskId === request.id)) {
        throw new ScheduleInputError('invalid_selector', 'This calendar belongs to an agent routine; use routine_update.')
      }
    })
    ctx.effect(() => async () => { await domain.close() }, 'agent-routine.domain')
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: TRIGGER_PATH, handler: createTriggerHandler(engine, token, (message) => { ctx.logger.warn(message) }, tokenFile) }),
      `agent-routine: ${TRIGGER_PATH}`,
    )
    let reading: Promise<void> = Promise.resolve()
    const reconcile = (): Promise<void> => {
      reading = reading.then(async () => {
        for (const routine of engine.list()) {
          if (routine.scheduleTaskId === undefined) continue
          const page = await ctx.schedule.history({ id: ScheduleId(routine.scheduleTaskId), limit: 20 })
          if (!('records' in page)) continue
          for (const record of [...page.records].reverse()) {
            await engine.observeDelivery(routine.id, {
              messageId: record.messageId,
              scheduledAt: record.scheduledAt,
              deliveredAt: record.deliveredAt,
              sessionId: record.targetSessionId,
            })
          }
        }
      }).catch((error: unknown) => { ctx.logger.warn(`agent-routine: reconcile failed: ${String(error)}`) })
      return reading
    }
    await engine.recover()
    await reconcile()
    ctx.effect(() => ctx.on('schedule/changed', () => { void reconcile() }), 'agent-routine.schedule-changed')
    ctx.effect(() => {
      const timer = setInterval(() => {
        void engine.tick().then(reconcile).catch((error: unknown) => { ctx.logger.warn(`agent-routine: tick failed: ${String(error)}`) })
      }, (config.tickSeconds as number) * 1000)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'agent-routine.tick')
  }
}

export default AgentRoutines
