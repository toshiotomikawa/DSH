/**
 * Value types of agent routines: the registered routine, one execution (run) of it, and the ports the engine uses.
 * @module @deepseek-ai/dsh-agent-routine/types
 */

/** Calendar shapes a routine accepts; local times are read in the routine's own IANA zone. */
export type ScheduleSpec =
  | { readonly kind: 'once'; readonly date: string; readonly time: string }
  | { readonly kind: 'daily'; readonly time: string }
  | { readonly kind: 'weekdays'; readonly time: string }
  | { readonly kind: 'weekly'; readonly time: string; readonly weekdays: readonly number[] }
  | { readonly kind: 'monthly'; readonly day: number; readonly time: string }
  | { readonly kind: 'interval'; readonly everySeconds: number }
  | { readonly kind: 'cron'; readonly expression: string }

/** What happens to an execution when the account hits a usage limit. */
export type LimitPolicy = 'wait' | 'skip'

/** What happens to occurrences that fell while the server was down. */
export type MissedPolicy = 'skip' | 'run-once'

/** Where an execution came from. */
export type RunSource = 'agenda' | 'manual' | 'script' | 'webhook'

/** Lifecycle states of one execution. */
export type RunState =
  | 'fila'
  | 'espera_cota'
  | 'execucao'
  | 'sucesso_relato'
  | 'sucesso_sem_novidade'
  | 'falha'
  | 'cancelada'
  | 'pulada'

/** One registered routine. */
export interface Routine {
  readonly id: string
  /** Stable id of the persistent agent; renaming the agent never changes the link. */
  readonly agentId: string
  /** Owner of the routine; carried for the later multi-user work and read by no logic. */
  readonly ownerId?: string
  readonly name: string
  /** Self-sufficient instruction run in a fresh session. */
  readonly instruction: string
  /** Counts instruction edits; a run keeps the version it was admitted with. */
  readonly instructionVersion: number
  /** Whether the routine fires by calendar or only by explicit manual or script runs. */
  readonly trigger: 'schedule' | 'script'
  readonly schedule?: ScheduleSpec
  /** IANA zone that reads the calendar times. */
  readonly timeZone: string
  /** `false` blocks calendar and webhook firing; manual tests and script triggers still run. */
  readonly active: boolean
  readonly limitPolicy: LimitPolicy
  readonly missedPolicy: MissedPolicy
  /** Whether the authenticated local script may run this routine. */
  readonly scriptEnabled: boolean
  /** Task of the host scheduler that carries the calendar. */
  readonly scheduleTaskId?: string
  /** A one-time routine that already fired. */
  readonly consumed: boolean
  /** Latest instant the engine saw the clock; start of the window for occurrences lost while the server was down. */
  readonly lastSeenAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** One execution of a routine. */
export interface Run {
  readonly id: string
  /** Acceptance order inside the whole store; the queue runs in this order. */
  readonly seq: number
  readonly routineId: string
  readonly agentId: string
  readonly ownerId?: string
  readonly source: RunSource
  /** True for a test started by hand; its answer is shown, never notified. */
  readonly manual: boolean
  /** Planned instant of a calendar occurrence. */
  readonly scheduledAt?: string
  readonly acceptedAt: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly state: RunState
  /** Instruction version and text fixed when the run was admitted. */
  readonly instructionVersion?: number
  readonly instruction?: string
  /** External data from a script, kept apart from the instruction. */
  readonly payload?: string
  /** Same key from the same routine returns the same run. */
  readonly idempotencyKey?: string
  /** Delivery that created the run on the host scheduler. */
  readonly deliveryKey?: string
  readonly sessionId?: string
  readonly result?: string
  readonly error?: string
  /** Why the run waits, was skipped or needs a decision. */
  readonly reason?: string
  /** Earliest instant the run may be admitted again, when the provider said so. */
  readonly eligibleAt?: string
  /** Instant of the next quota re-check. */
  readonly nextCheckAt?: string
  readonly quotaChecks: number
  /** The run ended in a way that may have left outside effects; it is never repeated by itself. */
  readonly uncertain: boolean
  /** The model chose to report nothing. */
  readonly noUpdate: boolean
  readonly notifiedAt?: string
}

/** Agent data the engine needs; the registry itself belongs to another package. */
export interface AgentInfo {
  readonly id: string
  readonly name: string
  readonly preset?: string
  readonly cwd?: string
}

/** Resolves a persistent agent by its stable id. */
export type AgentResolver = (agentId: string) => AgentInfo | undefined

/** What the host scheduler needs to carry a routine's calendar. */
export interface ScheduleTaskSpec {
  readonly title: string
  readonly prompt: string
  readonly active: boolean
  readonly agentPreset?: string
  readonly cwd?: string
  readonly spec: ScheduleSpec
  readonly timeZone: string
}

/** Host scheduler used as the only clock. */
export interface ScheduleGateway {
  /** Create the task; the delivery target is a fresh session each time. */
  create: (task: ScheduleTaskSpec) => Promise<string>
  /** Replace the task's fields. */
  update: (id: string, task: ScheduleTaskSpec) => Promise<void>
  /** Remove the task. */
  remove: (id: string) => Promise<void>
}

/** Starts and stops sessions for admitted runs. */
export interface RunnerPort {
  /** Start the run in a new session; the outcome comes later through `settle`. */
  start: (input: { runId: string; agent: AgentInfo; prompt: string }) => Promise<{ sessionId: string }>
  /** Stop a running session. */
  cancel: (sessionId: string) => Promise<void>
}

/** How a started run ended. */
export type Outcome =
  | { readonly kind: 'completed'; readonly text: string }
  | { readonly kind: 'limit'; readonly resetAt?: string; readonly afterEffects?: boolean; readonly message?: string }
  | { readonly kind: 'auth'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'cancelled' }

/** A report that deserves the user's attention. */
export interface Report {
  readonly runId: string
  readonly routineId: string
  readonly agentId: string
  readonly routineName: string
  readonly text: string
}

/** Receives reports that deserve the user's attention. */
export type Notifier = (report: Report) => Promise<void> | void

/** Minimal table surface the engine needs; a storage-domain table satisfies it. */
export interface TableLike<V> {
  get: (key: string) => V | undefined
  entries: () => IterableIterator<[string, V]>
  put: (key: string, value: V) => Promise<void>
  delete: (key: string) => Promise<boolean>
}

/** Persistent state of the engine. */
export interface RoutineStore {
  readonly routines: TableLike<Routine>
  readonly runs: TableLike<Run>
}

/** Fields accepted when a routine is created. */
export interface RoutineInput {
  readonly agentId: string
  readonly ownerId?: string
  readonly name: string
  readonly instruction: string
  readonly trigger?: 'schedule' | 'script'
  readonly schedule?: ScheduleSpec
  readonly timeZone?: string
  readonly active?: boolean
  readonly limitPolicy?: LimitPolicy
  readonly missedPolicy?: MissedPolicy
  readonly scriptEnabled?: boolean
}

/** Fields that an edit may change; omitted fields keep their value. */
export type RoutinePatch = Partial<Omit<RoutineInput, 'agentId' | 'ownerId'>>
