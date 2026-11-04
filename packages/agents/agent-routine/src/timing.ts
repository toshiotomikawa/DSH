/** Translates a routine calendar into the host scheduler's timing and replays occurrences on a given clock. */
import {
  ScheduleId, isRecurringScheduleRecord, resolveRecurringOccurrence,
} from '@deepseek-ai/dsh-schedule'
import type { ScheduleRecord, ScheduleTiming } from '@deepseek-ai/dsh-schedule'
import { createScheduleRecord } from '@deepseek-ai/dsh-schedule/src/update.ts'
import { RoutineError } from './errors.ts'
import type { ScheduleSpec } from './types.ts'

/** Recurrences closer than this are refused: the host's own floor is 60 s, ours is three minutes. */
export const MIN_INTERVAL_SECONDS = 180

/** How many consecutive future occurrences are measured against the floor. */
const FLOOR_SAMPLE = 8

/** Hard cap on occurrences replayed for one window. */
const REPLAY_CAP = 1000

const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/

function clock(time: string): { hour: number; minute: number; second: number } {
  const match = CLOCK.exec(time)
  const hour = Number(match?.[1])
  const minute = Number(match?.[2])
  const second = Number(match?.[3] ?? 0)
  if (match === null || hour > 23 || minute > 59 || second > 59) {
    throw new RoutineError('agenda_invalida', `horário "${time}" inválido; use HH:mm`)
  }
  return { hour, minute, second }
}

/** The scheduler reads HH:mm:ss; routines also accept HH:mm. */
function seconds(time: string): string {
  return /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time
}

/**
 * Convert a routine calendar into the scheduler's timing.
 * @param spec - calendar chosen by the user.
 * @param timeZone - IANA zone that reads the local times.
 * @returns the timing the host scheduler understands.
 * @throws RoutineError when a shape is wrong.
 */
export function toTiming(spec: ScheduleSpec, timeZone: string): ScheduleTiming {
  switch (spec.kind) {
    case 'once': return { kind: 'at', at: { date: spec.date, time: seconds(spec.time), time_zone: timeZone } }
    case 'daily': return { kind: 'daily', daily: { time: seconds(spec.time), time_zone: timeZone } }
    case 'weekdays': return { kind: 'weekly', weekly: { time: seconds(spec.time), time_zone: timeZone, weekdays: [1, 2, 3, 4, 5] } }
    case 'weekly': return { kind: 'weekly', weekly: { time: seconds(spec.time), time_zone: timeZone, weekdays: [...spec.weekdays] } }
    case 'monthly': {
      if (!Number.isInteger(spec.day) || spec.day < 1 || spec.day > 31) {
        throw new RoutineError('agenda_invalida', 'o dia do mês deve ficar entre 1 e 31')
      }
      const { hour, minute, second } = clock(spec.time)
      if (second !== 0) throw new RoutineError('agenda_invalida', 'a agenda mensal não aceita segundos; use HH:mm')
      return { kind: 'cron', cron: { expression: `${minute} ${hour} ${spec.day} * *`, time_zone: timeZone } }
    }
    case 'interval': return { kind: 'every', every_seconds: spec.everySeconds }
    case 'cron': return { kind: 'cron', cron: { expression: spec.expression, time_zone: timeZone } }
  }
}

/** Build the scheduler record for a timing, mapping its input errors. */
function recordFor(timing: ScheduleTiming, now: number): ScheduleRecord {
  try {
    return createScheduleRecord(ScheduleId('routine-probe'), 'probe', 'probe', timing, now)
  } catch (error) {
    throw new RoutineError('agenda_invalida', String(error), { cause: error })
  }
}

/**
 * Replay the occurrences of a calendar inside a window, one by one.
 * @param spec - calendar.
 * @param timeZone - IANA zone.
 * @param from - exclusive start in epoch milliseconds.
 * @param to - inclusive end in epoch milliseconds.
 * @param limit - most occurrences to return.
 * @returns the occurrences as canonical UTC instants.
 */
export function occurrencesBetween(spec: ScheduleSpec, timeZone: string, from: number, to: number, limit = REPLAY_CAP): string[] {
  let record = recordFor(toTiming(spec, timeZone), from)
  const found: string[] = []
  while (found.length < limit && Date.parse(record.scheduledAt) <= to) {
    if (!isRecurringScheduleRecord(record)) {
      found.push(record.scheduledAt)
      break
    }
    const occurrence = resolveRecurringOccurrence(record, Date.parse(record.scheduledAt))
    found.push(occurrence.occurrenceAt)
    /* v8 ignore next -- recurring records always carry a next instant; the check narrows the type. */
    if (occurrence.nextScheduledAt === undefined) break
    record = { ...record, scheduledAt: occurrence.nextScheduledAt }
  }
  return found
}

/**
 * Check a calendar before anything is saved: shape, future occurrence and the three-minute floor.
 * @param spec - calendar.
 * @param timeZone - IANA zone.
 * @param now - current epoch milliseconds.
 * @returns the timing for the host scheduler.
 * @throws RoutineError when the calendar is refused.
 */
export function validateSchedule(spec: ScheduleSpec, timeZone: string, now: number): ScheduleTiming {
  if (spec.kind === 'interval' && spec.everySeconds < MIN_INTERVAL_SECONDS) {
    throw new RoutineError('intervalo_curto', `o intervalo mínimo é de ${MIN_INTERVAL_SECONDS} segundos`)
  }
  const timing = toTiming(spec, timeZone)
  const first = recordFor(timing, now)
  if (isRecurringScheduleRecord(first)) {
    const horizon = now + 400 * 86_400_000
    const sample = occurrencesBetween(spec, timeZone, now, horizon, FLOOR_SAMPLE).map(value => Date.parse(value))
    for (let index = 1; index < sample.length; index++) {
      if ((sample[index] as number) - (sample[index - 1] as number) < MIN_INTERVAL_SECONDS * 1000) {
        throw new RoutineError('intervalo_curto', `a agenda dispara em menos de ${MIN_INTERVAL_SECONDS} segundos`)
      }
    }
  }
  return timing
}

/**
 * Next occurrence strictly after an instant.
 * @param spec - calendar.
 * @param timeZone - IANA zone.
 * @param now - current epoch milliseconds.
 * @returns the instant.
 */
export function nextOccurrence(spec: ScheduleSpec, timeZone: string, now: number): string {
  return recordFor(toTiming(spec, timeZone), now).scheduledAt
}
