import { SessionCalendar } from '@openview/chart-engine/model';
import type { ExchangeCalendarId, OHLCVBar, Resolution } from '@openview/protocol';

export interface ReplaySnapshot {
  active: boolean;
  playing: boolean;
  cursorIndex: number;
  totalBaseBars: number;
  cursorTime: number;
  speedBarsPerSec: number;
}

/**
 * Zero-Lookahead Master-Clock Multi-Timeframe Bar Replay Engine.
 *
 * Eliminates the classic multi-TF replay lookahead bug:
 * Instead of slicing pre-built higher-timeframe arrays (which leaks future highs/lows/closes),
 * MasterReplayClock advances a base-resolution cursor and dynamically aggregates EVERY
 * higher-timeframe chart (`5m`, `15m`, `1H`, `4H`, `1D`) strictly from base bars <= cursorIndex!
 */
export class MasterReplayClock {
  private readonly calendar = new SessionCalendar();
  private baseBars: readonly OHLCVBar[] = [];
  private cursorIndex = 0;
  private active = false;
  private playing = false;
  private speedBarsPerSec = 2;
  private timer: ReturnType<typeof setInterval> | null = null;

  private listeners = new Set<(snap: ReplaySnapshot, latestBaseBar: OHLCVBar | null) => void>();

  onChange(fn: (snap: ReplaySnapshot, latestBaseBar: OHLCVBar | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): ReplaySnapshot {
    return {
      active: this.active,
      playing: this.playing,
      cursorIndex: this.cursorIndex,
      totalBaseBars: this.baseBars.length,
      cursorTime: this.baseBars[this.cursorIndex]?.time ?? 0,
      speedBarsPerSec: this.speedBarsPerSec,
    };
  }

  start(baseBars: readonly OHLCVBar[], startCursorIndex?: number): void {
    this.pause();
    this.baseBars = baseBars;
    if (baseBars.length === 0) {
      this.active = false;
      this.cursorIndex = 0;
      this.emit();
      return;
    }
    const defaultStart = Math.max(0, Math.floor(baseBars.length * 0.6));
    this.cursorIndex = Math.max(
      0,
      Math.min(baseBars.length - 1, startCursorIndex ?? defaultStart),
    );
    this.active = true;
    this.emit();
  }

  stop(): void {
    this.pause();
    this.active = false;
    this.baseBars = [];
    this.cursorIndex = 0;
    this.emit();
  }

  stepForward(steps = 1): boolean {
    if (!this.active || this.baseBars.length === 0) return false;
    if (this.cursorIndex >= this.baseBars.length - 1) {
      this.pause();
      return false;
    }
    this.cursorIndex = Math.min(this.baseBars.length - 1, this.cursorIndex + Math.max(1, steps));
    this.emit();
    if (this.cursorIndex >= this.baseBars.length - 1) {
      this.pause();
    }
    return true;
  }

  stepBack(steps = 1): boolean {
    if (!this.active || this.baseBars.length === 0) return false;
    this.pause();
    this.cursorIndex = Math.max(0, this.cursorIndex - Math.max(1, steps));
    this.emit();
    return true;
  }

  jumpToIndex(index: number): void {
    if (!this.active || this.baseBars.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(this.baseBars.length - 1, Math.floor(index)));
    this.emit();
  }

  play(barsPerSec?: number): void {
    if (!this.active || this.baseBars.length === 0) return;
    if (barsPerSec !== undefined) this.speedBarsPerSec = Math.max(0.25, Math.min(60, barsPerSec));
    this.pause();
    this.playing = true;
    const intervalMs = Math.max(16, Math.round(1000 / this.speedBarsPerSec));
    this.timer = setInterval(() => {
      this.stepForward(1);
    }, intervalMs);
    this.emit();
  }

  pause(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.playing) {
      this.playing = false;
      this.emit();
    }
  }

  setSpeed(barsPerSec: number): void {
    this.speedBarsPerSec = Math.max(0.25, Math.min(60, barsPerSec));
    if (this.playing) {
      this.play(this.speedBarsPerSec);
    } else {
      this.emit();
    }
  }

  /**
   * Synthesizes a zero-lookahead series for ANY target resolution directly from base bars [0..cursorIndex].
   * The rightmost bar is the authentic partially-formed candle up to cursorTime!
   */
  getRolledUpSeries(
    targetResolution: Resolution,
    calendarId: ExchangeCalendarId,
    extendedHours = false,
  ): OHLCVBar[] {
    if (!this.active || this.baseBars.length === 0) return [];
    const out: OHLCVBar[] = [];
    let current: OHLCVBar | null = null;
    let currentOpenTime = -1;

    for (let i = 0; i <= this.cursorIndex; i++) {
      const b = this.baseBars[i]!;
      const { openTime } = this.calendar.bucketBarTimestamp(
        b.time,
        targetResolution,
        calendarId,
        extendedHours,
      );
      if (current && openTime === currentOpenTime) {
        if (b.high > current.high) current.high = b.high;
        if (b.low < current.low) current.low = b.low;
        current.close = b.close;
        current.volume += b.volume;
      } else {
        current = {
          time: openTime,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        };
        currentOpenTime = openTime;
        out.push(current);
      }
    }
    return out;
  }

  private emit(): void {
    const snap = this.getSnapshot();
    const latest = this.active ? (this.baseBars[this.cursorIndex] ?? null) : null;
    for (const fn of this.listeners) fn(snap, latest);
  }
}
