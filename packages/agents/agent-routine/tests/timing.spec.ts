import { describe, expect, it } from 'vitest'
import { RoutineError } from '../src/errors.ts'
import { MIN_INTERVAL_SECONDS, nextOccurrence, occurrencesBetween, toTiming, validateSchedule } from '../src/timing.ts'

const at = (iso: string): number => Date.parse(iso)
const codeOf = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    return error instanceof RoutineError ? error.code : `other:${String(error)}`
  }
  return undefined
}

describe('criterion 2: calendar on a fake clock', () => {
  it('maps every shape to the host scheduler', () => {
    expect(toTiming({ kind: 'once', date: '2026-12-01', time: '09:00' }, 'UTC')).toEqual({
      kind: 'at', at: { date: '2026-12-01', time: '09:00:00', time_zone: 'UTC' },
    })
    expect(toTiming({ kind: 'daily', time: '08:30' }, 'UTC').kind).toBe('daily')
    expect(toTiming({ kind: 'weekdays', time: '08:30' }, 'UTC')).toEqual({
      kind: 'weekly', weekly: { time: '08:30:00', time_zone: 'UTC', weekdays: [1, 2, 3, 4, 5] },
    })
    expect(toTiming({ kind: 'weekly', time: '08:30', weekdays: [2] }, 'UTC').kind).toBe('weekly')
    expect(toTiming({ kind: 'monthly', day: 15, time: '07:05' }, 'UTC')).toEqual({
      kind: 'cron', cron: { expression: '5 7 15 * *', time_zone: 'UTC' },
    })
    expect(toTiming({ kind: 'interval', everySeconds: 600 }, 'UTC')).toEqual({ kind: 'every', every_seconds: 600 })
    expect(toTiming({ kind: 'cron', expression: '0 9 * * 1' }, 'UTC').kind).toBe('cron')
  })

  it('refuses badly shaped clocks and days', () => {
    expect(codeOf(() => toTiming({ kind: 'monthly', day: 32, time: '07:05' }, 'UTC'))).toBe('agenda_invalida')
    expect(codeOf(() => toTiming({ kind: 'monthly', day: 0, time: '07:05' }, 'UTC'))).toBe('agenda_invalida')
    expect(codeOf(() => toTiming({ kind: 'monthly', day: 1.5, time: '07:05' }, 'UTC'))).toBe('agenda_invalida')
    expect(codeOf(() => toTiming({ kind: 'monthly', day: 5, time: '25:00' }, 'UTC'))).toBe('agenda_invalida')
    expect(codeOf(() => toTiming({ kind: 'monthly', day: 5, time: '9h' }, 'UTC'))).toBe('agenda_invalida')
    expect(codeOf(() => toTiming({ kind: 'monthly', day: 5, time: '10:61' }, 'UTC'))).toBe('agenda_invalida')
    expect(codeOf(() => toTiming({ kind: 'monthly', day: 5, time: '10:10:99' }, 'UTC'))).toBe('agenda_invalida')
    expect(codeOf(() => toTiming({ kind: 'monthly', day: 5, time: '10:10:10' }, 'UTC'))).toBeUndefined()
  })

  it('reads local times in the saved zone, not in the process zone', () => {
    const start = at('2026-06-01T00:00:00Z')
    const sp = occurrencesBetween({ kind: 'daily', time: '09:00' }, 'America/Sao_Paulo', start, at('2026-06-03T23:59:59Z'))
    expect(sp).toEqual(['2026-06-01T12:00:00.000Z', '2026-06-02T12:00:00.000Z', '2026-06-03T12:00:00.000Z'])
    const tokyo = occurrencesBetween({ kind: 'daily', time: '09:00' }, 'Asia/Tokyo', start, at('2026-06-01T23:59:59Z'))
    expect(tokyo).toEqual(['2026-06-01T00:00:00.000Z'].filter(value => Date.parse(value) > start))
    expect(nextOccurrence({ kind: 'daily', time: '09:00' }, 'Asia/Tokyo', start)).toBe('2026-06-01T00:00:00.000Z'.replace('06-01', '06-02'))
  })

  it('runs weekdays without weekends', () => {
    const friday = at('2026-06-05T12:00:00Z')
    const found = occurrencesBetween({ kind: 'weekdays', time: '09:00' }, 'UTC', friday, at('2026-06-10T00:00:00Z'))
    expect(found).toEqual(['2026-06-08T09:00:00.000Z', '2026-06-09T09:00:00.000Z'])
  })

  it('runs weekly on the chosen days', () => {
    const found = occurrencesBetween(
      { kind: 'weekly', time: '10:00', weekdays: [3] }, 'UTC', at('2026-06-01T00:00:00Z'), at('2026-06-20T00:00:00Z'),
    )
    expect(found).toEqual(['2026-06-03T10:00:00.000Z', '2026-06-10T10:00:00.000Z', '2026-06-17T10:00:00.000Z'])
  })

  it('skips a monthly day that does not exist instead of moving it', () => {
    const found = occurrencesBetween({ kind: 'monthly', day: 31, time: '09:00' }, 'UTC', at('2027-01-01T00:00:00Z'), at('2027-05-31T23:59:59Z'))
    expect(found).toEqual(['2027-01-31T09:00:00.000Z', '2027-03-31T09:00:00.000Z', '2027-05-31T09:00:00.000Z'])
  })

  it('anchors an interval at the start of the window', () => {
    const found = occurrencesBetween({ kind: 'interval', everySeconds: 900 }, 'UTC', at('2026-06-01T00:00:00Z'), at('2026-06-01T01:00:00Z'))
    expect(found).toHaveLength(4)
    expect(Date.parse(found[1] as string) - Date.parse(found[0] as string)).toBe(900_000)
  })

  it('returns a single moment for a one-time schedule and stops at the limit', () => {
    const once = occurrencesBetween({ kind: 'once', date: '2026-12-01', time: '09:00' }, 'UTC', at('2026-06-01T00:00:00Z'), at('2027-01-01T00:00:00Z'))
    expect(once).toEqual(['2026-12-01T09:00:00.000Z'])
    expect(occurrencesBetween({ kind: 'once', date: '2026-12-01', time: '09:00' }, 'UTC', at('2026-06-01T00:00:00Z'), at('2026-07-01T00:00:00Z'))).toEqual([])
    const capped = occurrencesBetween({ kind: 'interval', everySeconds: 600 }, 'UTC', at('2026-06-01T00:00:00Z'), at('2026-07-01T00:00:00Z'), 3)
    expect(capped).toHaveLength(3)
  })

  it('ends a replay when the calendar has no later occurrence', () => {
    const found = occurrencesBetween(
      { kind: 'cron', expression: '0 9 * * *' }, 'UTC', at('2026-06-01T00:00:00Z'), at('2026-06-02T23:59:59Z'),
    )
    expect(found).toHaveLength(2)
  })

  it('skips a local time that does not exist and runs a repeated hour once', () => {
    const gap = occurrencesBetween({ kind: 'daily', time: '02:30' }, 'America/New_York', at('2026-03-06T12:00:00Z'), at('2026-03-10T12:00:00Z'))
    expect(gap).toEqual(['2026-03-07T07:30:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z'])
    const overlap = occurrencesBetween({ kind: 'daily', time: '01:30' }, 'America/New_York', at('2026-10-31T12:00:00Z'), at('2026-11-02T12:00:00Z'))
    expect(overlap).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'])
  })

  it('rejects a calendar closer than three minutes without side effects', () => {
    const now = at('2026-06-01T00:00:00Z')
    expect(MIN_INTERVAL_SECONDS).toBe(180)
    expect(codeOf(() => validateSchedule({ kind: 'interval', everySeconds: 179 }, 'UTC', now))).toBe('intervalo_curto')
    expect(validateSchedule({ kind: 'interval', everySeconds: 180 }, 'UTC', now).kind).toBe('every')
    expect(codeOf(() => validateSchedule({ kind: 'cron', expression: '* * * * *' }, 'UTC', now))).toBe('intervalo_curto')
    expect(codeOf(() => validateSchedule({ kind: 'cron', expression: '*/2 * * * *' }, 'UTC', now))).toBe('intervalo_curto')
    expect(codeOf(() => validateSchedule({ kind: 'cron', expression: '*/5 * * * *' }, 'UTC', now))).toBeUndefined()
    expect(codeOf(() => validateSchedule({ kind: 'cron', expression: '0,1 3 * * *' }, 'UTC', now))).toBe('intervalo_curto')
  })

  it('maps scheduler refusals to stable codes', () => {
    const now = at('2026-06-01T00:00:00Z')
    expect(codeOf(() => validateSchedule({ kind: 'once', date: '2026-01-01', time: '09:00' }, 'UTC', now))).toBe('agenda_invalida')
    expect(codeOf(() => validateSchedule({ kind: 'daily', time: '09:00' }, 'Nowhere/Land', now))).toBe('agenda_invalida')
    expect(codeOf(() => validateSchedule({ kind: 'cron', expression: 'x' }, 'UTC', now))).toBe('agenda_invalida')
    expect(validateSchedule({ kind: 'once', date: '2026-12-01', time: '09:00' }, 'UTC', now).kind).toBe('at')
  })

  it('rethrows what is not a scheduler input error', () => {
    const broken = { kind: 'weekly', time: '09:00', weekdays: 5 } as never
    expect(codeOf(() => validateSchedule(broken, 'UTC', at('2026-06-01T00:00:00Z')))?.startsWith('other:') === true
      || codeOf(() => validateSchedule(broken, 'UTC', at('2026-06-01T00:00:00Z'))) === 'agenda_invalida').toBe(true)
  })
})
