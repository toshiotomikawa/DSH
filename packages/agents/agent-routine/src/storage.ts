/** Durable shape of routines and executions, stored in a domain of this package. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Routine, Run } from './types.ts'

const scheduleSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), date: z.string(), time: z.string() }).strict(),
  z.object({ kind: z.literal('daily'), time: z.string() }).strict(),
  z.object({ kind: z.literal('weekdays'), time: z.string() }).strict(),
  z.object({ kind: z.literal('weekly'), time: z.string(), weekdays: z.array(z.number().int()) }).strict(),
  z.object({ kind: z.literal('monthly'), day: z.number().int(), time: z.string() }).strict(),
  z.object({ kind: z.literal('interval'), everySeconds: z.number().int() }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string() }).strict(),
])

const routineSchema: z.ZodType<Routine> = z.object({
  id: z.string(),
  agentId: z.string(),
  ownerId: z.string().exactOptional(),
  name: z.string(),
  instruction: z.string(),
  instructionVersion: z.number().int(),
  trigger: z.enum(['schedule', 'script']),
  schedule: scheduleSpec.exactOptional(),
  timeZone: z.string(),
  active: z.boolean(),
  limitPolicy: z.enum(['wait', 'skip']),
  missedPolicy: z.enum(['skip', 'run-once']),
  scriptEnabled: z.boolean(),
  scheduleTaskId: z.string().exactOptional(),
  consumed: z.boolean(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()

const runSchema: z.ZodType<Run> = z.object({
  id: z.string(),
  seq: z.number().int(),
  routineId: z.string(),
  agentId: z.string(),
  ownerId: z.string().exactOptional(),
  source: z.enum(['agenda', 'manual', 'script', 'webhook']),
  manual: z.boolean(),
  scheduledAt: z.string().exactOptional(),
  acceptedAt: z.string(),
  startedAt: z.string().exactOptional(),
  endedAt: z.string().exactOptional(),
  state: z.enum(['fila', 'espera_cota', 'execucao', 'sucesso_relato', 'sucesso_sem_novidade', 'falha', 'cancelada', 'pulada']),
  instructionVersion: z.number().int().exactOptional(),
  instruction: z.string().exactOptional(),
  payload: z.string().exactOptional(),
  idempotencyKey: z.string().exactOptional(),
  deliveryKey: z.string().exactOptional(),
  sessionId: z.string().exactOptional(),
  result: z.string().exactOptional(),
  error: z.string().exactOptional(),
  reason: z.string().exactOptional(),
  eligibleAt: z.string().exactOptional(),
  nextCheckAt: z.string().exactOptional(),
  quotaChecks: z.number().int(),
  uncertain: z.boolean(),
  noUpdate: z.boolean(),
  notifiedAt: z.string().exactOptional(),
}).strict()

/** Routines and their executions; each record is its own document so history grows without rewriting the rest. */
export const routineDomain = defineDomain({
  name: 'agent-routine',
  version: 1,
  layout: 'per-record',
  tables: {
    routines: domainTable<string, Routine>(routineSchema),
    runs: domainTable<string, Run>(runSchema),
  },
})
