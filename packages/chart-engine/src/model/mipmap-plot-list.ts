import type { OHLCVBar } from '@openview/protocol';

export const CHUNK_CAPACITY = 4096;

interface BarChunk {
  /** Logical integer barIndex of local slot 0 (can be negative after left-scroll prepend). */
  startIndex: number;
  length: number;
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

export interface PlotBarView {
  barIndex: number;
  endBarIndex: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MipmapLevel {
  stride: number;
  /** bucketKey -> bucket index in contiguous arrays */
  firstBucket: number;
  count: number;
  barIndex: Float64Array;
  endBarIndex: Float64Array;
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

const MIPMAP_STRIDES = [2, 4, 8, 16, 32, 64, 128] as const;

function createChunk(startIndex: number): BarChunk {
  return {
    startIndex,
    length: 0,
    time: new Float64Array(CHUNK_CAPACITY),
    open: new Float64Array(CHUNK_CAPACITY),
    high: new Float64Array(CHUNK_CAPACITY),
    low: new Float64Array(CHUNK_CAPACITY),
    close: new Float64Array(CHUNK_CAPACITY),
    volume: new Float64Array(CHUNK_CAPACITY),
  };
}

/**
 * Chunked Structure-of-Arrays OHLCV store with:
 * - O(1) negative-index left-scroll prepending (zero shifting of existing bars)
 * - Integer barIndex primary keys (supports duplicate timestamps for Renko/Range/Tick)
 * - Index-aligned power-of-2 Mipmap Pyramid (2x..128x) eliminating 1px zoomed-out pan shimmer
 */
export class MipmapPlotList {
  private chunks: BarChunk[] = [];
  private totalCount = 0;
  private version = 0;

  private mipmaps: MipmapLevel[] = [];
  private mipmapVersion = -1;

  // Cached Heikin Ashi transform aligned 1:1 to barIndex
  private haVersion = -1;
  private haFirstIndex = 0;
  private haOpen = new Float64Array(0);
  private haHigh = new Float64Array(0);
  private haLow = new Float64Array(0);
  private haClose = new Float64Array(0);

  get length(): number {
    return this.totalCount;
  }

  get dataVersion(): number {
    return this.version;
  }

  firstIndex(): number {
    const first = this.chunks[0];
    return first ? first.startIndex : 0;
  }

  lastIndex(): number {
    const last = this.chunks[this.chunks.length - 1];
    return last ? last.startIndex + last.length - 1 : -1;
  }

  clear(): void {
    this.chunks = [];
    this.totalCount = 0;
    this.version++;
  }

  setBars(bars: readonly OHLCVBar[]): void {
    this.clear();
    if (bars.length === 0) return;

    let offset = 0;
    let logicalStart = 0;
    while (offset < bars.length) {
      const chunk = createChunk(logicalStart);
      const take = Math.min(CHUNK_CAPACITY, bars.length - offset);
      for (let i = 0; i < take; i++) {
        const b = bars[offset + i]!;
        chunk.time[i] = b.time;
        chunk.open[i] = b.open;
        chunk.high[i] = b.high;
        chunk.low[i] = b.low;
        chunk.close[i] = b.close;
        chunk.volume[i] = b.volume;
      }
      chunk.length = take;
      this.chunks.push(chunk);
      offset += take;
      logicalStart += take;
    }
    this.totalCount = bars.length;
    this.version++;
  }

  /**
   * O(1) chunked prepend for left-scroll historical lazy loading.
   * Assigns contiguous negative logical indices below current firstIndex() so all
   * existing bar indices & viewport coordinates remain 100% stable!
   */
  prependBars(olderBars: readonly OHLCVBar[]): number {
    if (olderBars.length === 0) return 0;
    if (this.totalCount === 0) {
      this.setBars(olderBars);
      return olderBars.length;
    }

    const newChunks: BarChunk[] = [];
    let logicalStart = this.firstIndex() - olderBars.length;
    let offset = 0;
    while (offset < olderBars.length) {
      const chunk = createChunk(logicalStart);
      const take = Math.min(CHUNK_CAPACITY, olderBars.length - offset);
      for (let i = 0; i < take; i++) {
        const b = olderBars[offset + i]!;
        chunk.time[i] = b.time;
        chunk.open[i] = b.open;
        chunk.high[i] = b.high;
        chunk.low[i] = b.low;
        chunk.close[i] = b.close;
        chunk.volume[i] = b.volume;
      }
      chunk.length = take;
      newChunks.push(chunk);
      offset += take;
      logicalStart += take;
    }

    // Splice references only — zero copying of existing TypedArrays
    this.chunks = [...newChunks, ...this.chunks];
    this.totalCount += olderBars.length;
    this.version++;
    return olderBars.length;
  }

  /**
   * Append a new bar, or update the rightmost bar in-place if bar.time matches
   * (unless allowDuplicateTimestamp is true for non-time charts like Renko/Range).
   */
  upsertBar(bar: OHLCVBar, allowDuplicateTimestamp = false): { appended: boolean; barIndex: number } {
    const lastChunk = this.chunks[this.chunks.length - 1];
    if (lastChunk && lastChunk.length > 0 && !allowDuplicateTimestamp) {
      const slot = lastChunk.length - 1;
      if (lastChunk.time[slot] === bar.time) {
        lastChunk.open[slot] = bar.open;
        lastChunk.high[slot] = bar.high;
        lastChunk.low[slot] = bar.low;
        lastChunk.close[slot] = bar.close;
        lastChunk.volume[slot] = bar.volume;
        this.version++;
        return { appended: false, barIndex: lastChunk.startIndex + slot };
      }
    }

    let target = lastChunk;
    const nextIdx = this.totalCount === 0 ? 0 : this.lastIndex() + 1;
    if (!target || target.length >= CHUNK_CAPACITY) {
      target = createChunk(nextIdx);
      this.chunks.push(target);
    }
    const slot = target.length;
    target.time[slot] = bar.time;
    target.open[slot] = bar.open;
    target.high[slot] = bar.high;
    target.low[slot] = bar.low;
    target.close[slot] = bar.close;
    target.volume[slot] = bar.volume;
    target.length++;
    this.totalCount++;
    this.version++;
    return { appended: true, barIndex: nextIdx };
  }

  private findChunkForIndex(barIndex: number): { chunk: BarChunk; slot: number } | null {
    if (this.chunks.length === 0) return null;
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.chunks[mid]!;
      if (barIndex < c.startIndex) {
        hi = mid - 1;
      } else if (barIndex >= c.startIndex + c.length) {
        lo = mid + 1;
      } else {
        return { chunk: c, slot: barIndex - c.startIndex };
      }
    }
    return null;
  }

  getBar(barIndex: number): PlotBarView | null {
    const loc = this.findChunkForIndex(barIndex);
    if (!loc) return null;
    const { chunk, slot } = loc;
    return {
      barIndex,
      endBarIndex: barIndex,
      time: chunk.time[slot]!,
      open: chunk.open[slot]!,
      high: chunk.high[slot]!,
      low: chunk.low[slot]!,
      close: chunk.close[slot]!,
      volume: chunk.volume[slot]!,
    };
  }

  getLastBar(): PlotBarView | null {
    if (this.totalCount === 0) return null;
    return this.getBar(this.lastIndex());
  }

  /**
   * Binary search for the nearest barIndex with time <= targetTime (or first bar if earlier).
   */
  findIndexByTime(targetTime: number): number {
    if (this.totalCount === 0) return 0;
    const firstIdx = this.firstIndex();
    const lastIdx = this.lastIndex();
    let lo = firstIdx;
    let hi = lastIdx;
    let ans = firstIdx;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const b = this.getBar(mid);
      if (!b) break;
      if (b.time <= targetTime) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  /**
   * Compute min/max price and max volume over [fromIdx, toIdx] using mipmap acceleration when zoomed out.
   */
  getPriceBounds(
    fromIdx: number,
    toIdx: number,
    barSpacingPx: number,
    useHeikinAshi = false,
  ): { minPrice: number; maxPrice: number; maxVolume: number } | null {
    if (this.totalCount === 0) return null;
    const clampedFrom = Math.max(this.firstIndex(), fromIdx);
    const clampedTo = Math.min(this.lastIndex(), toIdx);
    if (clampedFrom > clampedTo) return null;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let maxVolume = 0;

    if (useHeikinAshi) {
      this.ensureHeikinAshi();
      const base = this.haFirstIndex;
      for (let idx = clampedFrom; idx <= clampedTo; idx++) {
        const i = idx - base;
        const hi = this.haHigh[i]!;
        const lo = this.haLow[i]!;
        if (lo < minPrice) minPrice = lo;
        if (hi > maxPrice) maxPrice = hi;
        const loc = this.findChunkForIndex(idx);
        if (loc) {
          const v = loc.chunk.volume[loc.slot]!;
          if (v > maxVolume) maxVolume = v;
        }
      }
    } else {
      const level = this.selectMipmapLevel(barSpacingPx);
      if (level) {
        const bFrom = Math.max(level.firstBucket, Math.floor(clampedFrom / level.stride));
        const bTo = Math.min(
          level.firstBucket + level.count - 1,
          Math.floor(clampedTo / level.stride),
        );
        for (let b = bFrom; b <= bTo; b++) {
          const slot = b - level.firstBucket;
          const lo = level.low[slot]!;
          const hi = level.high[slot]!;
          const vol = level.volume[slot]!;
          if (lo < minPrice) minPrice = lo;
          if (hi > maxPrice) maxPrice = hi;
          if (vol > maxVolume) maxVolume = vol;
        }
      } else {
        this.forEachRawBar(clampedFrom, clampedTo, (_idx, _t, _o, h, l, _c, v) => {
          if (l < minPrice) minPrice = l;
          if (h > maxPrice) maxPrice = h;
          if (v > maxVolume) maxVolume = v;
        });
      }
    }

    if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) return null;
    return { minPrice, maxPrice, maxVolume };
  }

  /**
   * Select the coarsest pan-invariant mipmap level whose bucket stride covers <= 1.75 CSS pixels.
   * Returns null when L0 raw bars should be drawn directly.
   */
  selectMipmapLevel(barSpacingPx: number): MipmapLevel | null {
    if (barSpacingPx >= 1.25 || this.totalCount < 2048) return null;
    this.ensureMipmaps();
    let chosen: MipmapLevel | null = null;
    for (const lvl of this.mipmaps) {
      if (lvl.stride * barSpacingPx <= 2.0) {
        chosen = lvl;
      } else {
        break;
      }
    }
    return chosen;
  }

  /**
   * Iterate visible bars (raw L0 or pan-invariant mipmap bucket) with zero per-bar object allocation.
   */
  forEachVisible(
    fromIdx: number,
    toIdx: number,
    barSpacingPx: number,
    useHeikinAshi: boolean,
    visitor: (
      barIndex: number,
      endBarIndex: number,
      time: number,
      open: number,
      high: number,
      low: number,
      close: number,
      volume: number,
    ) => void,
  ): { levelStride: number; drawnCount: number } {
    if (this.totalCount === 0) return { levelStride: 1, drawnCount: 0 };
    const clampedFrom = Math.max(this.firstIndex(), fromIdx);
    const clampedTo = Math.min(this.lastIndex(), toIdx);
    if (clampedFrom > clampedTo) return { levelStride: 1, drawnCount: 0 };

    if (useHeikinAshi) {
      this.ensureHeikinAshi();
      const base = this.haFirstIndex;
      let count = 0;
      this.forEachRawBar(clampedFrom, clampedTo, (idx, t, _o, _h, _l, _c, v) => {
        const i = idx - base;
        visitor(idx, idx, t, this.haOpen[i]!, this.haHigh[i]!, this.haLow[i]!, this.haClose[i]!, v);
        count++;
      });
      return { levelStride: 1, drawnCount: count };
    }

    const level = this.selectMipmapLevel(barSpacingPx);
    if (level) {
      const bFrom = Math.max(level.firstBucket, Math.floor(clampedFrom / level.stride));
      const bTo = Math.min(
        level.firstBucket + level.count - 1,
        Math.floor(clampedTo / level.stride),
      );
      let count = 0;
      for (let b = bFrom; b <= bTo; b++) {
        const slot = b - level.firstBucket;
        visitor(
          level.barIndex[slot]!,
          level.endBarIndex[slot]!,
          level.time[slot]!,
          level.open[slot]!,
          level.high[slot]!,
          level.low[slot]!,
          level.close[slot]!,
          level.volume[slot]!,
        );
        count++;
      }
      return { levelStride: level.stride, drawnCount: count };
    }

    let count = 0;
    this.forEachRawBar(clampedFrom, clampedTo, (idx, t, o, h, l, c, v) => {
      visitor(idx, idx, t, o, h, l, c, v);
      count++;
    });
    return { levelStride: 1, drawnCount: count };
  }

  private forEachRawBar(
    clampedFrom: number,
    clampedTo: number,
    fn: (
      barIndex: number,
      time: number,
      open: number,
      high: number,
      low: number,
      close: number,
      volume: number,
    ) => void,
  ): void {
    // Binary search starting chunk once
    let lo = 0;
    let hi = this.chunks.length - 1;
    let chunkIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.chunks[mid]!;
      if (clampedFrom < c.startIndex) {
        hi = mid - 1;
      } else if (clampedFrom >= c.startIndex + c.length) {
        lo = mid + 1;
      } else {
        chunkIdx = mid;
        break;
      }
    }

    for (let ci = chunkIdx; ci < this.chunks.length; ci++) {
      const chunk = this.chunks[ci]!;
      if (chunk.startIndex > clampedTo) break;
      const startSlot = Math.max(0, clampedFrom - chunk.startIndex);
      const endSlot = Math.min(chunk.length - 1, clampedTo - chunk.startIndex);
      for (let s = startSlot; s <= endSlot; s++) {
        fn(
          chunk.startIndex + s,
          chunk.time[s]!,
          chunk.open[s]!,
          chunk.high[s]!,
          chunk.low[s]!,
          chunk.close[s]!,
          chunk.volume[s]!,
        );
      }
    }
  }

  private ensureHeikinAshi(): void {
    if (this.haVersion === this.version) return;
    const n = this.totalCount;
    this.haFirstIndex = this.firstIndex();
    if (this.haOpen.length !== n) {
      this.haOpen = new Float64Array(n);
      this.haHigh = new Float64Array(n);
      this.haLow = new Float64Array(n);
      this.haClose = new Float64Array(n);
    }
    let prevO = 0;
    let prevC = 0;
    let i = 0;
    this.forEachRawBar(this.firstIndex(), this.lastIndex(), (_idx, _t, o, h, l, c) => {
      const haC = (o + h + l + c) * 0.25;
      const haO = i === 0 ? (o + c) * 0.5 : (prevO + prevC) * 0.5;
      const haH = Math.max(h, haO, haC);
      const haL = Math.min(l, haO, haC);
      this.haOpen[i] = haO;
      this.haHigh[i] = haH;
      this.haLow[i] = haL;
      this.haClose[i] = haC;
      prevO = haO;
      prevC = haC;
      i++;
    });
    this.haVersion = this.version;
  }

  private ensureMipmaps(): void {
    if (this.mipmapVersion === this.version) return;
    this.mipmaps = [];
    if (this.totalCount === 0) {
      this.mipmapVersion = this.version;
      return;
    }

    const firstIdx = this.firstIndex();
    const lastIdx = this.lastIndex();

    // Build Level 1 (stride = 2) directly from L0 chunks
    let prev = this.buildLevelFromRaw(firstIdx, lastIdx, MIPMAP_STRIDES[0]);
    this.mipmaps.push(prev);

    // Build higher levels bottom-up in O(N) total across all levels
    for (let li = 1; li < MIPMAP_STRIDES.length; li++) {
      const stride = MIPMAP_STRIDES[li]!;
      if (prev.count < 128) break;
      prev = this.buildLevelFromPrev(prev, stride);
      this.mipmaps.push(prev);
    }

    this.mipmapVersion = this.version;
  }

  private buildLevelFromRaw(firstIdx: number, lastIdx: number, stride: number): MipmapLevel {
    const firstBucket = Math.floor(firstIdx / stride);
    const lastBucket = Math.floor(lastIdx / stride);
    const count = lastBucket - firstBucket + 1;

    const barIndex = new Float64Array(count);
    const endBarIndex = new Float64Array(count);
    const time = new Float64Array(count);
    const open = new Float64Array(count);
    const high = new Float64Array(count);
    const low = new Float64Array(count);
    const close = new Float64Array(count);
    const volume = new Float64Array(count);
    const initialized = new Uint8Array(count);

    this.forEachRawBar(firstIdx, lastIdx, (idx, t, o, h, l, c, v) => {
      const slot = Math.floor(idx / stride) - firstBucket;
      if (initialized[slot] === 0) {
        initialized[slot] = 1;
        barIndex[slot] = idx;
        endBarIndex[slot] = idx;
        time[slot] = t;
        open[slot] = o;
        high[slot] = h;
        low[slot] = l;
        close[slot] = c;
        volume[slot] = v;
      } else {
        endBarIndex[slot] = idx;
        if (h > high[slot]!) high[slot] = h;
        if (l < low[slot]!) low[slot] = l;
        close[slot] = c;
        volume[slot] = volume[slot]! + v;
      }
    });

    return { stride, firstBucket, count, barIndex, endBarIndex, time, open, high, low, close, volume };
  }

  private buildLevelFromPrev(prev: MipmapLevel, stride: number): MipmapLevel {
    const firstBucket = Math.floor((prev.firstBucket * prev.stride) / stride);
    const lastBucket = Math.floor(((prev.firstBucket + prev.count - 1) * prev.stride) / stride);
    const count = lastBucket - firstBucket + 1;

    const barIndex = new Float64Array(count);
    const endBarIndex = new Float64Array(count);
    const time = new Float64Array(count);
    const open = new Float64Array(count);
    const high = new Float64Array(count);
    const low = new Float64Array(count);
    const close = new Float64Array(count);
    const volume = new Float64Array(count);
    const initialized = new Uint8Array(count);

    for (let i = 0; i < prev.count; i++) {
      const idx = prev.barIndex[i]!;
      const slot = Math.floor(idx / stride) - firstBucket;
      if (initialized[slot] === 0) {
        initialized[slot] = 1;
        barIndex[slot] = idx;
        endBarIndex[slot] = prev.endBarIndex[i]!;
        time[slot] = prev.time[i]!;
        open[slot] = prev.open[i]!;
        high[slot] = prev.high[i]!;
        low[slot] = prev.low[i]!;
        close[slot] = prev.close[i]!;
        volume[slot] = prev.volume[i]!;
      } else {
        endBarIndex[slot] = prev.endBarIndex[i]!;
        if (prev.high[i]! > high[slot]!) high[slot] = prev.high[i]!;
        if (prev.low[i]! < low[slot]!) low[slot] = prev.low[i]!;
        close[slot] = prev.close[i]!;
        volume[slot] = volume[slot]! + prev.volume[i]!;
      }
    }

    return { stride, firstBucket, count, barIndex, endBarIndex, time, open, high, low, close, volume };
  }
}
