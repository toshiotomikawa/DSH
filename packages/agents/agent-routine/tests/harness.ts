/** Fake clock, agents, scheduler, runner and tables: no real wait and no model call. */
import { vi } from 'vitest'
import { RoutineEngine } from '../src/engine.ts'
import type { Delivery } from '../src/engine.ts'
import { RoutineError } from '../src/errors.ts'
import type {
  AgentInfo, Report, Routine, RoutineStore, Run, ScheduleGateway, ScheduleTaskSpec, TableLike,
} from '../src/types.ts'

/** Map-backed table with a switch that makes the next writes fail. */
export class MemTable<V> implements TableLike<V> {
  readonly map = new Map<string, V>()
  failPuts = 0

  get(key: string): V | undefined { return this.map.get(key) }
  entries(): IterableIterator<[string, V]> { return [...this.map.entries()][Symbol.iterator]() }
  put(key: string, value: V): Promise<void> {
    if (this.failPuts > 0) {
      this.failPuts--
      return Promise.reject(new Error('disk full'))
    }
    this.map.set(key, structuredClone(value))
    return Promise.resolve()
  }
  delete(key: string): Promise<boolean> { return Promise.resolve(this.map.delete(key)) }
}

export const START = Date.parse('2026-06-01T12:00:00Z')

/** Everything a test needs to drive the engine. */
export function setup(options: { backoff?: number[]; grace?: number } = {}) {
  const clock = { now: START }
  const agents = new Map<string, AgentInfo>([['a1', { id: 'a1', name: 'Alfa', preset: 'alfa', cwd: '/work' }]])
  const store: RoutineStore & { routines: MemTable<Routine>; runs: MemTable<Run> } = { routines: new MemTable(), runs: new MemTable() }
  const calls: string[] = []
  const tasks = new Map<string, ScheduleTaskSpec>()
  const gateway = {
    createFails: false,
    updateOk: Number.POSITIVE_INFINITY,
    removeFails: false,
  }
  const schedule: ScheduleGateway = {
    create: (task) => {
      calls.push('create')
      if (gateway.createFails) return Promise.reject(new Error('scheduler down'))
      const id = `task-${tasks.size + 1}`
      tasks.set(id, task)
      return Promise.resolve(id)
    },
    update: (id, task) => {
      calls.push('update')
      if (gateway.updateOk-- <= 0) return Promise.reject(new Error('scheduler down'))
      tasks.set(id, task)
      return Promise.resolve()
    },
    remove: (id) => {
      calls.push('remove')
      if (gateway.removeFails) return Promise.reject(new Error('scheduler down'))
      tasks.delete(id)
      return Promise.resolve()
    },
  }
  const starts: { runId: string; agent: AgentInfo; prompt: string }[] = []
  const cancels: string[] = []
  const runner = {
    startError: undefined as Error | undefined,
    cancelError: undefined as Error | undefined,
  }
  const reports: Report[] = []
  const notifier = { fails: false }
  const warnings: string[] = []
  let counter = 0
  const make = (): RoutineEngine => new RoutineEngine({
    store,
    schedule,
    agents: id => agents.get(id),
    runner: {
      start: (input) => {
        if (runner.startError !== undefined) return Promise.reject(runner.startError)
        starts.push(input)
        return Promise.resolve({ sessionId: `session-${starts.length}` })
      },
      cancel: (sessionId) => {
        cancels.push(sessionId)
        return runner.cancelError === undefined ? Promise.resolve() : Promise.reject(runner.cancelError)
      },
    },
    notify: (report) => {
      if (notifier.fails) return Promise.reject(new Error('inbox down'))
      reports.push(report)
      return Promise.resolve()
    },
    now: () => clock.now,
    newId: prefix => `${prefix}-${++counter}`,
    warn: (message) => { warnings.push(message) },
    backoffSeconds: options.backoff ?? [300, 900, 3600],
    graceSeconds: options.grace ?? 120,
  })
  return { clock, agents, store, calls, tasks, gateway, starts, cancels, runner, reports, notifier, warnings, make, engine: make() }
}

export type Rig = ReturnType<typeof setup>

/** A delivery receipt built from a planned instant and a delay. */
export function delivery(id: string, planned: string, lateMs = 0, sessionId = `scheduler-${id}`): Delivery {
  return { messageId: id, scheduledAt: planned, deliveredAt: new Date(Date.parse(planned) + lateMs).toISOString(), sessionId }
}

/** Code of the engine refusal a promise ends with. */
export async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    return error instanceof RoutineError ? error.code : `other:${String(error)}`
  }
  return 'ok'
}

export { vi }
