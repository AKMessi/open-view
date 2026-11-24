import { parquetReadObjects } from 'hyparquet';
import type { OHLCVBar } from '@openview/protocol';

function parseTimestampMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Heuristic: values < 1e11 are Unix seconds, convert to ms
    return raw < 1e11 ? raw * 1000 : raw;
  }
  if (typeof raw === 'bigint') {
    const num = Number(raw);
    return num < 1e11 ? num * 1000 : num;
  }
  if (raw instanceof Date) {
    return raw.getTime();
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return n < 1e11 ? n * 1000 : n;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

/**
 * Streaming-friendly zero-dependency CSV OHLCV parser supporting TradingView, Yahoo, NSE,
 * Binance Vision, and generic timestamp/date headers.
 */
export function parseCsvBars(csvText: string): OHLCVBar[] {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headerCols = (lines[0] ?? '')
    .split(',')
    .map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());

  const colOf = (...names: string[]) => headerCols.findIndex((h) => names.includes(h));
  const iTime = colOf('time', 'timestamp', 'date', 'datetime', 'open_time');
  const iOpen = colOf('open', 'o');
  const iHigh = colOf('high', 'h');
  const iLow = colOf('low', 'l');
  const iClose = colOf('close', 'c', 'adj close', 'last');
  const iVol = colOf('volume', 'vol', 'v', 'qty');

  if (iTime === -1 || iOpen === -1 || iHigh === -1 || iLow === -1 || iClose === -1) {
    throw new Error('CSV must include time/date, open, high, low, and close columns');
  }

  const bars: OHLCVBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const cols = line.split(',');
    const time = parseTimestampMs(cols[iTime]?.replace(/^"|"$/g, ''));
    const open = Number(cols[iOpen]);
    const high = Number(cols[iHigh]);
    const low = Number(cols[iLow]);
    const close = Number(cols[iClose]);
    const volume = iVol !== -1 ? Number(cols[iVol] ?? 0) : 0;

    if (
      !Number.isFinite(time) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    bars.push({
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }

  bars.sort((a, b) => a.time - b.time);
  return bars;
}

/**
 * Lightweight (~12 KB) browser & Node Parquet OHLCV reader powered by hyparquet
 * (avoids shipping a ~35 MB DuckDB-WASM binary in the initial web bundle).
 */
export async function parseParquetBars(fileBuffer: ArrayBuffer): Promise<OHLCVBar[]> {
  const rows = await parquetReadObjects({ file: fileBuffer });
  const bars: OHLCVBar[] = [];

  for (const row of rows) {
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      lower[k.toLowerCase()] = v;
    }
    const time = parseTimestampMs(lower.time ?? lower.timestamp ?? lower.date ?? lower.datetime);
    const open = Number(lower.open ?? lower.o);
    const high = Number(lower.high ?? lower.h);
    const low = Number(lower.low ?? lower.l);
    const close = Number(lower.close ?? lower.c);
    const volume = Number(lower.volume ?? lower.vol ?? lower.v ?? 0);

    if (
      !Number.isFinite(time) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    bars.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }

  bars.sort((a, b) => a.time - b.time);
  return bars;
}
