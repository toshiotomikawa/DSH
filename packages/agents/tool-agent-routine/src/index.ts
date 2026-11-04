/**
 * Model-facing tools for per-agent routines: create, edit, list, test, and report that nothing is new.
 * @module @deepseek-ai/dsh-tool-agent-routine
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { RoutineError } from '@deepseek-ai/dsh-agent-routine'
import type { RoutineEngine, RoutinePatch, ScheduleSpec } from '@deepseek-ai/dsh-agent-routine'

export const name = 'tool-agent-routine'
export const inject = ['tools', 'agentRoutines']

const SCHEDULE_PARAM = {
  type: 'json',
  description: 'Calendar: {kind:"once",date:"YYYY-MM-DD",time:"HH:mm"}, {kind:"daily",time}, {kind:"weekdays",time}, '
    + '{kind:"weekly",time,weekdays:[1..7]}, {kind:"monthly",day:1..31,time}, {kind:"interval",everySeconds:>=180} or '
    + '{kind:"cron",expression}. Times are read in time_zone. Recurrences closer than three minutes are refused.',
} as const

const RUN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    state: { type: 'string', required: true },
    source: { type: 'string', required: true },
    reason: { type: 'string' },
    result: { type: 'string' },
    error: { type: 'string' },
    scheduledAt: { type: 'string' },
    acceptedAt: { type: 'string', required: true },
    endedAt: { type: 'string' },
  },
} as const

function text(value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Run a call; engine refusals reach the model as `code: message`. */
async function guarded<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof RoutineError) throw new Error(`${error.code}: ${error.message}`)
    throw error
  }
}

/** Round-trip through JSON so absent optional keys disappear and the value is lossless JSON. */
function plain(value: object): never {
  return JSON.parse(JSON.stringify(value)) as never
}

function patchOf(args: Record<string, unknown>): RoutinePatch {
  const patch: Record<string, unknown> = {}
  const map: [string, string][] = [
    ['name', 'name'], ['instruction', 'instruction'], ['schedule', 'schedule'], ['time_zone', 'timeZone'], ['active', 'active'],
    ['limit_policy', 'limitPolicy'], ['missed_policy', 'missedPolicy'], ['script_enabled', 'scriptEnabled'],
  ]
  for (const [from, to] of map) if (args[from] !== undefined) patch[to] = args[from]
  return patch
}

export function apply(ctx: Context): void {
  const engine = (): RoutineEngine => ctx.agentRoutines.engine
  const agentOf = (exec: ToolExecution, given: string | undefined): string => {
    const found = exec.agent === undefined ? undefined : ctx.get('agentRoutineBridge')?.agentOfSession?.(exec.agent.id)
    if (found === undefined) throw new RoutineError('agente_obrigatorio', 'informe o agente da rotina em `agent`')
    if (given !== undefined && given !== found) {
      throw new RoutineError('agente_nao_autorizado', 'a rotina pertence a outro agente')
    }
    return found
  }
  const owned = (exec: ToolExecution, id: string): void => {
    const caller = agentOf(exec, undefined)
    const routine = engine().list().find(item => item.id === id)
    // Another agent's routine must look exactly like a missing one.
    if (routine === undefined || routine.agentId !== caller) throw new RoutineError('rotina_inexistente', `rotina "${id}" não existe`)
  }

  ctx.tools.register(defineTool({
    name: 'routine_create',
    description: 'Register a routine for a persistent agent. Each execution starts a fresh session with the agent identity, so the '
      + 'instruction must be self-sufficient. Without a schedule the routine runs only by manual test or an authenticated script.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short name, at most 120 characters.' },
      instruction: { type: 'string', required: true, description: 'Self-sufficient instruction for each execution.' },
      agent: { type: 'string', description: 'Persistent agent id; omitted means the calling agent.' },
      schedule: SCHEDULE_PARAM,
      time_zone: { type: 'string', description: 'IANA zone; required with a schedule.' },
      active: { type: 'boolean', description: 'false registers the routine paused.' },
      limit_policy: { type: 'string', enum: ['wait', 'skip'], description: 'wait (default) keeps the run until the usage limit renews; skip drops it. A one-time schedule always waits.' },
      missed_policy: { type: 'string', enum: ['skip', 'run-once'], description: 'Occurrences lost while the server was off: skip (default for recurrences) or run-once (default for one-time).' },
      script_enabled: { type: 'boolean', description: 'Whether the local script entry may run this routine (default true).' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { id: { type: 'string', required: true } } }, render: (_args, value) => text(value) },
    execute: (args, exec) => guarded(async () => plain(await engine().createRoutine({
      agentId: agentOf(exec, args.agent),
      name: args.name,
      instruction: args.instruction,
      ...args.schedule === undefined ? {} : { schedule: args.schedule as ScheduleSpec },
      ...args.time_zone === undefined ? {} : { timeZone: args.time_zone },
      ...patchOf({
        active: args.active,
        limit_policy: args.limit_policy,
        missed_policy: args.missed_policy,
        script_enabled: args.script_enabled,
      }),
    }))),
  }))

  ctx.tools.register(defineTool({
    name: 'routine_update',
    description: 'Change fields of a routine, pause or resume it, or delete it. Editing only the instruction keeps everything else. '
      + 'A run already admitted keeps the instruction it started with.',
    parameters: {
      id: { type: 'string', required: true, description: 'Routine id.' },
      name: { type: 'string' },
      instruction: { type: 'string' },
      schedule: SCHEDULE_PARAM,
      time_zone: { type: 'string' },
      active: { type: 'boolean', description: 'false pauses the calendar; true resumes it without replaying past occurrences.' },
      limit_policy: { type: 'string', enum: ['wait', 'skip'] },
      missed_policy: { type: 'string', enum: ['skip', 'run-once'] },
      script_enabled: { type: 'boolean' },
      remove: { type: 'boolean', description: 'true deletes the routine with its history.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { id: { type: 'string', required: true } } }, render: (_args, value) => text(value) },
    execute: (args, exec) => guarded(async () => {
      if (args.remove === true) {
        owned(exec, args.id)
        await engine().deleteRoutine(args.id)
        return { id: args.id, removed: true }
      }
      owned(exec, args.id)
      return plain(await engine().editRoutine(args.id, patchOf(args)))
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'routine_list',
    description: 'List routines, or show one with its next calendar fire and recent executions (state, reason, result).',
    parameters: {
      id: { type: 'string', description: 'Routine id; shows its detail and history.' },
      agent: { type: 'string', description: 'Only routines of this agent.' },
      history_limit: { type: 'integer', description: 'Executions to show with a routine (default 10).' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => text(value) },
    execute: (args, exec) => guarded(() => {
      const caller = agentOf(exec, args.agent)
      if (args.id !== undefined) {
        owned(exec, args.id)
        const view = engine().view(args.id, args.history_limit ?? 10)
        return plain({ routine: view.routine, nextFireAt: view.nextFireAt, runs: view.runs })
      }
      return plain({ routines: engine().list(caller) })
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'routine_test',
    description: 'Run a routine once by hand, even when it is paused. Does not activate the calendar or move the next fire. '
      + 'The answer stays in the run, visible through routine_list.',
    parameters: { id: { type: 'string', required: true, description: 'Routine id.' } },
    output: { schema: RUN_OUTPUT, render: (_args, value) => text(value) },
    execute: (args, exec) => guarded(async () => {
      owned(exec, args.id)
      return plain((await engine().trigger(args.id, { source: 'manual', manual: true })).run)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'routine_no_update',
    description: 'Call this inside a routine execution when the instruction says there is nothing to report. The run is kept in the history, '
      + 'its text is collected and no notification is sent. Do not use it after a failure.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', required: true } } }, render: (_args, value) => text(value) },
    execute: (_args, exec) => guarded(async () => {
      if (exec.agent === undefined) throw new RoutineError('sem_execucao', 'esta chamada não pertence a uma sessão')
      return { runId: (await engine().noUpdate(exec.agent.id)).id }
    }),
  }))
}
