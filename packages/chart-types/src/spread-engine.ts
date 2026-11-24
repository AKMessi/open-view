import type { OHLCVBar } from '@openview/protocol';

export type SpreadAlignmentMode = 'inner_join' | 'ffill';

type SpreadToken =
  | { type: 'num'; value: number }
  | { type: 'sym'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' }
  | { type: 'lparen' }
  | { type: 'rparen' };

type SpreadAst =
  | { kind: 'num'; value: number }
  | { kind: 'sym'; value: string }
  | { kind: 'unary'; expr: SpreadAst }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: SpreadAst; right: SpreadAst };

export interface ParsedSpread {
  expression: string;
  symbols: string[];
  ast: SpreadAst;
}

export function isSpreadExpression(input: string): boolean {
  const trimmed = input.trim();
  // Must contain an arithmetic operator between symbol/number tokens (not just a single symbol)
  return /[+\-*/]/.test(trimmed) && /[a-zA-Z]/.test(trimmed);
}

function tokenizeSpread(expr: string): SpreadToken[] {
  const tokens: SpreadToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const start = i;
      while (i < expr.length && /[0-9.]/.test(expr[i]!)) i++;
      const n = Number(expr.slice(start, i));
      if (!Number.isFinite(n)) throw new Error(`Invalid number in spread: ${expr.slice(start, i)}`);
      tokens.push({ type: 'num', value: n });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      // Symbols can include prefix colon, digits, dot, bang (e.g. NSE:NIFTY1!, BINANCE:BTCUSDT.P)
      while (i < expr.length && /[a-zA-Z0-9_:.!]/.test(expr[i]!)) i++;
      tokens.push({ type: 'sym', value: expr.slice(start, i).toUpperCase() });
      continue;
    }
    throw new Error(`Unexpected character '${ch}' in spread expression`);
  }
  return tokens;
}

export function parseSpreadExpression(expression: string): ParsedSpread {
  const tokens = tokenizeSpread(expression);
  let pos = 0;
  const symbolsSet = new Set<string>();

  const parseAdd = (): SpreadAst => {
    let left = parseMul();
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t?.type === 'op' && (t.value === '+' || t.value === '-')) {
        pos++;
        left = { kind: 'bin', op: t.value, left, right: parseMul() };
      } else break;
    }
    return left;
  };

  const parseMul = (): SpreadAst => {
    let left = parseUnary();
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t?.type === 'op' && (t.value === '*' || t.value === '/')) {
        pos++;
        left = { kind: 'bin', op: t.value, left, right: parseUnary() };
      } else break;
    }
    return left;
  };

  const parseUnary = (): SpreadAst => {
    const t = tokens[pos];
    if (t?.type === 'op' && t.value === '-') {
      pos++;
      return { kind: 'unary', expr: parseUnary() };
    }
    return parsePrimary();
  };

  const parsePrimary = (): SpreadAst => {
    const t = tokens[pos++];
    if (!t) throw new Error('Unexpected end of spread expression');
    if (t.type === 'num') return { kind: 'num', value: t.value };
    if (t.type === 'sym') {
      symbolsSet.add(t.value);
      return { kind: 'sym', value: t.value };
    }
    if (t.type === 'lparen') {
      const inner = parseAdd();
      if (tokens[pos++]?.type !== 'rparen') throw new Error('Expected ")" in spread expression');
      return inner;
    }
    throw new Error('Invalid token in spread expression');
  };

  const ast = parseAdd();
  if (pos !== tokens.length) throw new Error('Trailing tokens in spread expression');

  return {
    expression: expression.trim().toUpperCase(),
    symbols: [...symbolsSet],
    ast,
  };
}

function evalAst(ast: SpreadAst, values: Record<string, number>): number {
  switch (ast.kind) {
    case 'num':
      return ast.value;
    case 'sym':
      return values[ast.value] ?? Number.NaN;
    case 'unary':
      return -evalAst(ast.expr, values);
    case 'bin': {
      const l = evalAst(ast.left, values);
      const r = evalAst(ast.right, values);
      if (!Number.isFinite(l) || !Number.isFinite(r)) return Number.NaN;
      switch (ast.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return Math.abs(r) < 1e-12 ? Number.NaN : l / r;
      }
    }
  }
}

/**
 * Evaluates a synthetic spread expression (e.g., `FX:XAUUSD/FX:XAGUSD`, `NSE:BANKNIFTY/NSE:NIFTY`)
 * with configurable cross-calendar alignment (`inner_join` vs `ffill`) and GUARANTEED
 * clamped non-inverted historical wicks (`high >= max(open, close)` and `low <= min(open, close)`).
 */
export function evaluateSpreadBars(
  expression: string,
  seriesBySymbol: Record<string, readonly OHLCVBar[]>,
  alignment: SpreadAlignmentMode = 'inner_join',
): OHLCVBar[] {
  const parsed = parseSpreadExpression(expression);
  if (parsed.symbols.length === 0) return [];

  const maps = new Map<string, Map<number, OHLCVBar>>();
  const allTimesSet = new Set<number>();

  for (const sym of parsed.symbols) {
    const bars = seriesBySymbol[sym] ?? [];
    const m = new Map<number, OHLCVBar>();
    for (const b of bars) {
      m.set(b.time, b);
      allTimesSet.add(b.time);
    }
    maps.set(sym, m);
  }

  const allTimes = [...allTimesSet].sort((a, b) => a - b);
  const lastSeen = new Map<string, OHLCVBar>();
  const out: OHLCVBar[] = [];

  // Precompute all corner combinations of high/low across up to 4 legs (<= 16 combos)
  const legCount = parsed.symbols.length;
  const cornerMasks = legCount <= 4 ? 1 << legCount : 2;

  for (const time of allTimes) {
    const rowBars: Record<string, OHLCVBar> = {};
    let missing = false;

    for (const sym of parsed.symbols) {
      const exact = maps.get(sym)?.get(time);
      if (exact) {
        lastSeen.set(sym, exact);
        rowBars[sym] = exact;
      } else if (alignment === 'ffill' && lastSeen.has(sym)) {
        rowBars[sym] = lastSeen.get(sym)!;
      } else {
        missing = true;
        break;
      }
    }
    if (missing) continue;

    const openEnv: Record<string, number> = {};
    const closeEnv: Record<string, number> = {};
    let minVol = Infinity;
    for (const sym of parsed.symbols) {
      const b = rowBars[sym]!;
      openEnv[sym] = b.open;
      closeEnv[sym] = b.close;
      if (b.volume < minVol) minVol = b.volume;
    }

    const open = evalAst(parsed.ast, openEnv);
    const close = evalAst(parsed.ast, closeEnv);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;

    // Clamped Non-Inverted Historical Wicks:
    // Start from body bounds and expand safely over valid High/Low leg combinations
    let high = Math.max(open, close);
    let low = Math.min(open, close);

    for (let mask = 0; mask < cornerMasks; mask++) {
      const env: Record<string, number> = {};
      for (let bit = 0; bit < legCount; bit++) {
        const sym = parsed.symbols[bit]!;
        const b = rowBars[sym]!;
        env[sym] = (mask & (1 << bit)) !== 0 ? b.high : b.low;
      }
      const val = evalAst(parsed.ast, env);
      if (Number.isFinite(val)) {
        if (val > high) high = val;
        if (val < low) low = val;
      }
    }

    out.push({
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(minVol) ? minVol : 0,
    });
  }

  return out;
}
