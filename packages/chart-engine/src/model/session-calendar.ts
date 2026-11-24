import type { ExchangeCalendarId, Resolution } from '@openview/protocol';

export interface LocalDateTimeParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  weekday: number; // 0=Sun..6=Sat
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
  isoDate: string; // YYYY-MM-DD
  offsetMinutes: number; // e.g. +330 for Asia/Kolkata, -240 for EDT, -300 for EST
}

export interface SpecialSessionOverride {
  date: string; // YYYY-MM-DD in exchange local timezone
  openMinutes: number; // minutes since local midnight
  closeMinutes: number;
  reason: string;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const localPartsCache = new Map<string, LocalDateTimeParts>();
const MAX_LOCAL_PARTS_CACHE = 8192;

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, fmt);
  }
  return fmt;
}

function buildFixedOffsetParts(epochMs: number, offsetMinutes: number): LocalDateTimeParts {
  const d = new Date(epochMs + offsetMinutes * 60_000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const weekday = d.getUTCDay();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const second = d.getUTCSeconds();
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, weekday, hour, minute, second, isoDate, offsetMinutes };
}

export function getLocalParts(epochMs: number, timezone: string): LocalDateTimeParts {
  // Zero-Intl O(1) fast paths for UTC (Crypto) and Asia/Kolkata (India NSE/BSE/MCX, fixed UTC+5:30, no DST)
  if (timezone === 'UTC' || timezone === 'Etc/UTC') {
    return buildFixedOffsetParts(epochMs, 0);
  }
  if (timezone === 'Asia/Kolkata' || timezone === 'Asia/Calcutta') {
    return buildFixedOffsetParts(epochMs, 330);
  }

  // Minute-bucketed memoization for DST timezones (America/New_York, etc.)
  // Eliminates 1,000+ Intl.DateTimeFormat.formatToParts calls per pan/zoom frame!
  const minuteBucket = Math.floor(epochMs / 60_000);
  const second = Math.floor(((epochMs % 60_000) + 60_000) % 60_000 / 1000);
  const cacheKey = `${timezone}:${minuteBucket}`;
  const cached = localPartsCache.get(cacheKey);
  if (cached) {
    return cached.second === second ? cached : { ...cached, second };
  }

  const parts = getFormatter(timezone).formatToParts(new Date(minuteBucket * 60_000));
  let year = 1970;
  let month = 1;
  let day = 1;
  let weekday = 0;
  let hour = 0;
  let minute = 0;

  for (const p of parts) {
    switch (p.type) {
      case 'year':
        year = Number(p.value);
        break;
      case 'month':
        month = Number(p.value);
        break;
      case 'day':
        day = Number(p.value);
        break;
      case 'weekday':
        weekday = WEEKDAY_MAP[p.value] ?? 0;
        break;
      case 'hour':
        hour = Number(p.value) % 24;
        break;
      case 'minute':
        minute = Number(p.value);
        break;
    }
  }

  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMinutes = Math.round((asUtcMs - minuteBucket * 60_000) / 60_000);
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const baseResult: LocalDateTimeParts = {
    year,
    month,
    day,
    weekday,
    hour,
    minute,
    second: 0,
    isoDate,
    offsetMinutes,
  };

  if (localPartsCache.size >= MAX_LOCAL_PARTS_CACHE) {
    localPartsCache.clear();
  }
  localPartsCache.set(cacheKey, baseResult);
  return second === 0 ? baseResult : { ...baseResult, second };
}

/**
 * Convert an exchange-local wall-clock time (YYYY-MM-DD + minuteOfDay) into UTC epoch ms.
 * Handles DST transitions accurately using a 2-pass offset refinement.
 */
export function localWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string,
): number {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const pass1 = getLocalParts(guessUtc, timezone);
  const refined = guessUtc - pass1.offsetMinutes * 60_000;
  const pass2 = getLocalParts(refined, timezone);
  return guessUtc - pass2.offsetMinutes * 60_000;
}

/**
 * True if America/New_York is currently in Daylight Saving Time (EDT = UTC-4 vs EST = UTC-5).
 * Governs BOTH Forex NY-Close rollover (21:00 UTC vs 22:00 UTC) AND MCX evening close (23:30 vs 23:55 IST).
 */
export function isUsDst(epochMs: number): boolean {
  return getLocalParts(epochMs, 'America/New_York').offsetMinutes === -240;
}

export function resolutionToMs(resolution: Resolution): number {
  switch (resolution) {
    case '1S': return 1_000;
    case '5S': return 5_000;
    case '15S': return 15_000;
    case '30S': return 30_000;
    case '1': return 60_000;
    case '3': return 180_000;
    case '5': return 300_000;
    case '15': return 900_000;
    case '30': return 1_800_000;
    case '45': return 2_700_000;
    case '60': return 3_600_000;
    case '120': return 7_200_000;
    case '240': return 14_400_000;
    case '1D': return 86_400_000;
    case '1W': return 604_800_000;
    case '1M': return 2_592_000_000;
  }
}

export interface SessionWindow {
  openUtcMs: number;
  closeUtcMs: number;
  sessionDate: string;
}

const DEFAULT_NSE_SPECIAL_SESSIONS: readonly SpecialSessionOverride[] = [
  { date: '2025-02-01', openMinutes: 9 * 60 + 15, closeMinutes: 15 * 60 + 30, reason: 'Union Budget Saturday' },
  { date: '2025-10-21', openMinutes: 13 * 60 + 45, closeMinutes: 14 * 60 + 45, reason: 'Diwali Muhurat 2025' },
  { date: '2026-02-01', openMinutes: 9 * 60 + 15, closeMinutes: 15 * 60 + 30, reason: 'Union Budget Sunday' },
  { date: '2026-11-08', openMinutes: 18 * 60, closeMinutes: 19 * 60, reason: 'Diwali Muhurat 2026' },
];

export class SessionCalendar {
  private readonly specialByExchange = new Map<ExchangeCalendarId, Map<string, SpecialSessionOverride>>();

  constructor(customSpecialSessions?: Partial<Record<ExchangeCalendarId, readonly SpecialSessionOverride[]>>) {
    const nseMap = new Map<string, SpecialSessionOverride>();
    for (const s of DEFAULT_NSE_SPECIAL_SESSIONS) nseMap.set(s.date, s);
    this.specialByExchange.set('NSE', nseMap);

    if (customSpecialSessions) {
      for (const [ex, list] of Object.entries(customSpecialSessions)) {
        if (!list) continue;
        const m = this.specialByExchange.get(ex as ExchangeCalendarId) ?? new Map();
        for (const s of list) m.set(s.date, s);
        this.specialByExchange.set(ex as ExchangeCalendarId, m);
      }
    }
  }

  getTimezone(calendarId: ExchangeCalendarId): string {
    switch (calendarId) {
      case 'CRYPTO':
        return 'UTC';
      case 'FOREX_OTC':
      case 'US_EQUITY':
        return 'America/New_York';
      case 'NSE':
      case 'MCX':
        return 'Asia/Kolkata';
    }
  }

  /**
   * Returns the exact active session window [openUtcMs, closeUtcMs) containing epochMs.
   * - NSE: 09:15-15:30 IST (with Diwali Muhurat & Union Budget special session overrides)
   * - MCX: 09:00-23:30 IST (US EDT) or 09:00-23:55 IST (US EST)
   * - US_EQUITY: 09:30-16:00 ET (or 04:00-20:00 ET when extendedHours = true)
   * - FOREX_OTC: 17:00 America/New_York -> next day 17:00 America/New_York (DST-aware!)
   * - CRYPTO: 00:00-24:00 UTC
   */
  getSessionWindow(
    epochMs: number,
    calendarId: ExchangeCalendarId,
    extendedHours = false,
  ): SessionWindow {
    if (calendarId === 'CRYPTO') {
      const d = new Date(epochMs);
      const openUtcMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
      return {
        openUtcMs,
        closeUtcMs: openUtcMs + 86_400_000,
        sessionDate: d.toISOString().slice(0, 10),
      };
    }

    if (calendarId === 'FOREX_OTC') {
      const tz = 'America/New_York';
      const p = getLocalParts(epochMs, tz);
      const mins = p.hour * 60 + p.minute;
      const rollover = 17 * 60; // 17:00 NY Close
      // If local time < 17:00 ET, this trading day opened yesterday at 17:00 ET
      const anchorDate = new Date(Date.UTC(p.year, p.month - 1, p.day));
      if (mins < rollover) {
        anchorDate.setUTCDate(anchorDate.getUTCDate() - 1);
      }
      const nextDate = new Date(anchorDate.getTime() + 86_400_000);
      const openUtcMs = localWallTimeToUtcMs(
        anchorDate.getUTCFullYear(),
        anchorDate.getUTCMonth() + 1,
        anchorDate.getUTCDate(),
        rollover,
        tz,
      );
      const closeUtcMs = localWallTimeToUtcMs(
        nextDate.getUTCFullYear(),
        nextDate.getUTCMonth() + 1,
        nextDate.getUTCDate(),
        rollover,
        tz,
      );
      const tradingDayLabel = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDate.getUTCDate()).padStart(2, '0')}`;
      return { openUtcMs, closeUtcMs, sessionDate: tradingDayLabel };
    }

    if (calendarId === 'NSE') {
      const tz = 'Asia/Kolkata';
      const p = getLocalParts(epochMs, tz);
      const special = this.specialByExchange.get('NSE')?.get(p.isoDate);
      const openMin = special ? special.openMinutes : extendedHours ? 9 * 60 : 9 * 60 + 15;
      const closeMin = special ? special.closeMinutes : 15 * 60 + 30;
      return {
        openUtcMs: localWallTimeToUtcMs(p.year, p.month, p.day, openMin, tz),
        closeUtcMs: localWallTimeToUtcMs(p.year, p.month, p.day, closeMin, tz),
        sessionDate: p.isoDate,
      };
    }

    if (calendarId === 'MCX') {
      const tz = 'Asia/Kolkata';
      const p = getLocalParts(epochMs, tz);
      const special = this.specialByExchange.get('MCX')?.get(p.isoDate);
      const openMin = special ? special.openMinutes : 9 * 60;
      const closeMin = special
        ? special.closeMinutes
        : isUsDst(epochMs)
          ? 23 * 60 + 30
          : 23 * 60 + 55;
      return {
        openUtcMs: localWallTimeToUtcMs(p.year, p.month, p.day, openMin, tz),
        closeUtcMs: localWallTimeToUtcMs(p.year, p.month, p.day, closeMin, tz),
        sessionDate: p.isoDate,
      };
    }

    // US_EQUITY
    const tz = 'America/New_York';
    const p = getLocalParts(epochMs, tz);
    const openMin = extendedHours ? 4 * 60 : 9 * 60 + 30;
    const closeMin = extendedHours ? 20 * 60 : 16 * 60;
    return {
      openUtcMs: localWallTimeToUtcMs(p.year, p.month, p.day, openMin, tz),
      closeUtcMs: localWallTimeToUtcMs(p.year, p.month, p.day, closeMin, tz),
      sessionDate: p.isoDate,
    };
  }

  /**
   * Maps any raw tick/bar timestamp to its exact exchange-session-anchored bar open timestamp!
   * Guarantees:
   * - NSE 1H candles open at 09:15, 10:15, 11:15, 12:15, 13:15, 14:15, 15:15 IST (never 09:00/10:00!)
   * - Hard session close invariant: intraday buckets never span across sessionClose -> next sessionOpen.
   * - FX 1D and 4H candles anchor to 17:00 America/New_York (auto-shifting 21:00/22:00 UTC for DST!).
   */
  bucketBarTimestamp(
    epochMs: number,
    resolution: Resolution,
    calendarId: ExchangeCalendarId,
    extendedHours = false,
  ): { openTime: number; closeTime: number } {
    const win = this.getSessionWindow(epochMs, calendarId, extendedHours);

    if (resolution === '1D') {
      return { openTime: win.openUtcMs, closeTime: win.closeUtcMs };
    }

    if (resolution === '1W') {
      const tz = this.getTimezone(calendarId);
      const p = getLocalParts(win.openUtcMs, tz);
      // Roll back to Monday (or Sunday 17:00 ET for FX)
      const diffToMonday = calendarId === 'FOREX_OTC' ? p.weekday : (p.weekday + 6) % 7;
      const startDate = new Date(Date.UTC(p.year, p.month - 1, p.day - diffToMonday));
      const openMin =
        calendarId === 'FOREX_OTC'
          ? 17 * 60
          : calendarId === 'NSE'
            ? 9 * 60 + 15
            : calendarId === 'US_EQUITY'
              ? 9 * 60 + 30
              : 0;
      const openTime = localWallTimeToUtcMs(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth() + 1,
        startDate.getUTCDate(),
        openMin,
        tz,
      );
      return { openTime, closeTime: openTime + 7 * 86_400_000 };
    }

    if (resolution === '1M') {
      const tz = this.getTimezone(calendarId);
      const p = getLocalParts(win.openUtcMs, tz);
      const openTime = localWallTimeToUtcMs(p.year, p.month, 1, 0, tz);
      const nextMonth = p.month === 12 ? { y: p.year + 1, m: 1 } : { y: p.year, m: p.month + 1 };
      const closeTime = localWallTimeToUtcMs(nextMonth.y, nextMonth.m, 1, 0, tz);
      return { openTime, closeTime };
    }

    const stepMs = resolutionToMs(resolution);
    const clampedMs = Math.max(win.openUtcMs, Math.min(epochMs, win.closeUtcMs - 1));
    const elapsed = clampedMs - win.openUtcMs;
    const bucketIdx = Math.floor(elapsed / stepMs);
    const openTime = win.openUtcMs + bucketIdx * stepMs;
    // Hard Session-Close Invariant: never let closing stub bleed past session close
    const closeTime = Math.min(openTime + stepMs, win.closeUtcMs);
    return { openTime, closeTime };
  }

  isSessionBreak(
    prevBarMs: number,
    currBarMs: number,
    calendarId: ExchangeCalendarId,
    _extendedHours = false,
  ): boolean {
    if (calendarId === 'CRYPTO') {
      return Math.floor(prevBarMs / 86_400_000) !== Math.floor(currBarMs / 86_400_000);
    }
    if (calendarId === 'NSE' || calendarId === 'MCX') {
      // Fixed UTC+5:30 day boundary comparison (zero Intl calls!)
      return (
        Math.floor((prevBarMs + 19_800_000) / 86_400_000) !==
        Math.floor((currBarMs + 19_800_000) / 86_400_000)
      );
    }
    if (calendarId === 'US_EQUITY') {
      return (
        getLocalParts(prevBarMs, 'America/New_York').isoDate !==
        getLocalParts(currBarMs, 'America/New_York').isoDate
      );
    }
    // FOREX_OTC: 17:00 America/New_York rollover boundary
    const p1 = getLocalParts(prevBarMs, 'America/New_York');
    const p2 = getLocalParts(currBarMs, 'America/New_York');
    const d1 = p1.hour >= 17 ? p1.day + 1 : p1.day;
    const d2 = p2.hour >= 17 ? p2.day + 1 : p2.day;
    return p1.year !== p2.year || p1.month !== p2.month || d1 !== d2;
  }

  isSpecialSession(isoDate: string, calendarId: ExchangeCalendarId): SpecialSessionOverride | null {
    return this.specialByExchange.get(calendarId)?.get(isoDate) ?? null;
  }
}
