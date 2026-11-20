import { Errors } from '../errors'

export interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domWildcard: boolean
  dowWildcard: boolean
}

function parseField(raw: string, min: number, max: number, label: string, mapSevenToZero = false): Set<number> {
  const field = raw.trim()
  if (!field) {
    throw Errors.invalidParams(`Empty cron field for ${label}`)
  }

  const values = new Set<number>()
  for (const part of field.split(',')) {
    const token = part.trim()
    if (!token) {
      throw Errors.invalidParams(`Invalid empty token in cron ${label}: "${raw}"`)
    }

    const slashParts = token.split('/')
    if (slashParts.length > 2) {
      throw Errors.invalidParams(`Invalid step syntax in cron ${label}: "${token}"`)
    }

    const rangeExpr = slashParts[0]!
    let step = 1
    if (slashParts.length === 2) {
      if (!/^\d+$/.test(slashParts[1]!)) {
        throw Errors.invalidParams(`Invalid step value in cron ${label}: "${token}"`)
      }
      step = Number(slashParts[1])
      if (!Number.isInteger(step) || step < 1) {
        throw Errors.invalidParams(`Step must be >= 1 in cron ${label}: "${token}"`)
      }
    }

    let start: number
    let end: number
    if (rangeExpr === '*') {
      start = min
      end = max
    } else if (rangeExpr.includes('-')) {
      const bounds = rangeExpr.split('-')
      if (bounds.length !== 2 || !/^\d+$/.test(bounds[0]!) || !/^\d+$/.test(bounds[1]!)) {
        throw Errors.invalidParams(`Invalid range in cron ${label}: "${token}"`)
      }
      start = Number(bounds[0])
      end = Number(bounds[1])
      if (start < min || end > max || start > end) {
        throw Errors.invalidParams(`Range out of bounds (${min}-${max}) in cron ${label}: "${token}"`)
      }
    } else {
      if (!/^\d+$/.test(rangeExpr)) {
        throw Errors.invalidParams(`Invalid value in cron ${label}: "${token}"`)
      }
      start = Number(rangeExpr)
      end = slashParts.length === 2 ? max : start
      if (start < min || start > max) {
        throw Errors.invalidParams(`Value out of bounds (${min}-${max}) in cron ${label}: "${token}"`)
      }
    }

    for (let v = start; v <= end; v += step) {
      values.add(mapSevenToZero && v === 7 ? 0 : v)
    }
  }

  if (values.size === 0) {
    throw Errors.invalidParams(`Cron ${label} resolved to no matching values`)
  }
  return values
}

const MAX_DAYS_BY_MONTH: Record<number, number> = {
  1: 31,
  2: 29,
  3: 31,
  4: 30,
  5: 31,
  6: 30,
  7: 31,
  8: 31,
  9: 30,
  10: 31,
  11: 30,
  12: 31
}

export function parseCronExpression(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw Errors.invalidParams(`Cron expression must have exactly 5 fields, got ${fields.length}: "${expr}"`)
  }
  const [minRaw, hourRaw, domRaw, monRaw, dowRaw] = fields as [string, string, string, string, string]
  const daysOfMonth = parseField(domRaw, 1, 31, 'dayOfMonth')
  const months = parseField(monRaw, 1, 12, 'month')
  const dowWildcard = dowRaw.trim() === '*'

  if (dowWildcard) {
    let hasValidCalendarDate = false
    for (const month of months) {
      const maxDay = MAX_DAYS_BY_MONTH[month] ?? 31
      for (const day of daysOfMonth) {
        if (day <= maxDay) {
          hasValidCalendarDate = true
          break
        }
      }
      if (hasValidCalendarDate) break
    }
    if (!hasValidCalendarDate) {
      throw Errors.invalidParams(`Cron expression "${expr}" matches no valid calendar date`)
    }
  }

  return {
    minutes: parseField(minRaw, 0, 59, 'minute'),
    hours: parseField(hourRaw, 0, 23, 'hour'),
    daysOfMonth,
    months,
    daysOfWeek: parseField(dowRaw, 0, 7, 'dayOfWeek', true),
    domWildcard: domRaw.trim() === '*',
    dowWildcard
  }
}

export function computeNextCronRun(expr: string, afterMs: number): number {
  const cron = parseCronExpression(expr)
  const startMs = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  const limitMs = afterMs + 4 * 366 * 86_400_000
  const cursor = new Date(startMs)

  while (cursor.getTime() <= limitMs) {
    const prevMs = cursor.getTime()
    const month = cursor.getMonth() + 1
    if (!cron.months.has(month)) {
      cursor.setMonth(cursor.getMonth() + 1, 1)
      cursor.setHours(0, 0, 0, 0)
      if (cursor.getTime() <= prevMs) cursor.setTime(prevMs + 60_000)
      continue
    }

    const domMatch = cron.daysOfMonth.has(cursor.getDate())
    const dowMatch = cron.daysOfWeek.has(cursor.getDay())
    // Standard cron treats restricted DOM + DOW as union, and wildcard pairs as intersection.
    const dayMatches =
      !cron.domWildcard && !cron.dowWildcard ? domMatch || dowMatch : domMatch && dowMatch
    if (!dayMatches) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      if (cursor.getTime() <= prevMs) cursor.setTime(prevMs + 60_000)
      continue
    }

    if (!cron.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      if (cursor.getTime() <= prevMs) cursor.setTime(prevMs + 60_000)
      continue
    }

    if (!cron.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      if (cursor.getTime() <= prevMs) cursor.setTime(prevMs + 60_000)
      continue
    }

    return cursor.getTime()
  }

  throw Errors.invalidParams(`Cron expression "${expr}" has no occurrence within 4 years`)
}
