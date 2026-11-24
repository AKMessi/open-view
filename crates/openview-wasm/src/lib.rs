use wasm_bindgen::prelude::*;

pub mod arena;
pub mod backtester;
pub mod ta;

pub use arena::BarArena;

#[wasm_bindgen]
pub fn openview_wasm_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub fn ta_sma(values: &[f64], period: usize) -> Vec<f64> {
    ta::sma(values, period)
}

#[wasm_bindgen]
pub fn ta_ema(values: &[f64], period: usize) -> Vec<f64> {
    ta::ema(values, period)
}

#[wasm_bindgen]
pub fn ta_rma(values: &[f64], period: usize) -> Vec<f64> {
    ta::rma(values, period)
}

#[wasm_bindgen]
pub fn ta_wma(values: &[f64], period: usize) -> Vec<f64> {
    ta::wma(values, period)
}

#[wasm_bindgen]
pub fn ta_hma(values: &[f64], period: usize) -> Vec<f64> {
    ta::hma(values, period)
}

#[wasm_bindgen]
pub fn ta_vwma(values: &[f64], volume: &[f64], period: usize) -> Vec<f64> {
    ta::vwma(values, volume, period)
}

#[wasm_bindgen]
pub fn ta_rsi(values: &[f64], period: usize) -> Vec<f64> {
    ta::rsi(values, period)
}

/// Returns flattened [macd..., signal..., histogram...] (length 3 * N)
#[wasm_bindgen]
pub fn ta_macd(values: &[f64], fast: usize, slow: usize, signal: usize) -> Vec<f64> {
    let (m, s, h) = ta::macd(values, fast, slow, signal);
    let mut out = Vec::with_capacity(values.len() * 3);
    out.extend_from_slice(&m);
    out.extend_from_slice(&s);
    out.extend_from_slice(&h);
    out
}

#[wasm_bindgen]
pub fn ta_atr(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    ta::atr(high, low, close, period)
}

/// Returns flattened [basis..., upper..., lower...] (length 3 * N)
#[wasm_bindgen]
pub fn ta_bollinger_bands(values: &[f64], period: usize, mult: f64) -> Vec<f64> {
    let (basis, upper, lower) = ta::bollinger_bands(values, period, mult);
    let mut out = Vec::with_capacity(values.len() * 3);
    out.extend_from_slice(&basis);
    out.extend_from_slice(&upper);
    out.extend_from_slice(&lower);
    out
}

/// Returns flattened [basis..., upper..., lower...] (length 3 * N)
#[wasm_bindgen]
pub fn ta_keltner_channels(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    period: usize,
    mult: f64,
) -> Vec<f64> {
    let (basis, upper, lower) = ta::keltner_channels(high, low, close, period, mult);
    let mut out = Vec::with_capacity(close.len() * 3);
    out.extend_from_slice(&basis);
    out.extend_from_slice(&upper);
    out.extend_from_slice(&lower);
    out
}

/// Returns flattened [mid..., upper..., lower...] (length 3 * N)
#[wasm_bindgen]
pub fn ta_donchian_channels(high: &[f64], low: &[f64], period: usize) -> Vec<f64> {
    let (mid, upper, lower) = ta::donchian_channels(high, low, period);
    let mut out = Vec::with_capacity(high.len() * 3);
    out.extend_from_slice(&mid);
    out.extend_from_slice(&upper);
    out.extend_from_slice(&lower);
    out
}

/// Returns flattened [supertrendLine..., direction...] (length 2 * N)
#[wasm_bindgen]
pub fn ta_supertrend(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    period: usize,
    factor: f64,
) -> Vec<f64> {
    let (line, dir) = ta::supertrend(high, low, close, period, factor);
    let mut out = Vec::with_capacity(close.len() * 2);
    out.extend_from_slice(&line);
    out.extend_from_slice(&dir);
    out
}

/// Returns flattened [k..., d...] (length 2 * N)
#[wasm_bindgen]
pub fn ta_stochastic(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    k_period: usize,
    smooth_k: usize,
    d_period: usize,
) -> Vec<f64> {
    let (k, d) = ta::stochastic(high, low, close, k_period, smooth_k, d_period);
    let mut out = Vec::with_capacity(close.len() * 2);
    out.extend_from_slice(&k);
    out.extend_from_slice(&d);
    out
}

/// Returns flattened [plusDi..., minusDi..., adx...] (length 3 * N)
#[wasm_bindgen]
pub fn ta_adx_dmi(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    let (p, m, a) = ta::adx_dmi(high, low, close, period);
    let mut out = Vec::with_capacity(close.len() * 3);
    out.extend_from_slice(&p);
    out.extend_from_slice(&m);
    out.extend_from_slice(&a);
    out
}

#[wasm_bindgen]
pub fn ta_cci(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    ta::cci(high, low, close, period)
}

#[wasm_bindgen]
pub fn ta_obv(close: &[f64], volume: &[f64]) -> Vec<f64> {
    ta::obv(close, volume)
}

#[wasm_bindgen]
pub fn ta_mfi(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    volume: &[f64],
    period: usize,
) -> Vec<f64> {
    ta::mfi(high, low, close, volume, period)
}

/// Returns flattened [vwap..., upper1..., lower1...] (length 3 * N)
#[wasm_bindgen]
pub fn ta_session_vwap(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    volume: &[f64],
    session_breaks: &[u8],
) -> Vec<f64> {
    let (vw, u1, l1) = ta::session_vwap(high, low, close, volume, session_breaks);
    let mut out = Vec::with_capacity(close.len() * 3);
    out.extend_from_slice(&vw);
    out.extend_from_slice(&u1);
    out.extend_from_slice(&l1);
    out
}

/// Runs the Rust deterministic strategy backtester and returns a JSON report string
/// containing metrics, downsampled equity curve (<= 300 pts), and trade PnLs.
#[wasm_bindgen]
pub fn backtest_run_json(
    open: &[f64],
    high: &[f64],
    low: &[f64],
    close: &[f64],
    strategy_id: u32,
    param_a: usize,
    param_b: usize,
    stop_loss_pct: f64,
    take_profit_pct: f64,
    fee_bps: f64,
    slippage_bps: f64,
    initial_capital: f64,
) -> String {
    let s = backtester::run_backtest(
        open,
        high,
        low,
        close,
        strategy_id,
        param_a,
        param_b,
        stop_loss_pct,
        take_profit_pct,
        fee_bps,
        slippage_bps,
        initial_capital,
    );
    let step = (s.equity_curve.len() / 240).max(1);
    let mut eq_str = String::with_capacity(2048);
    eq_str.push('[');
    let mut first = true;
    for (idx, val) in s.equity_curve.iter().enumerate() {
        if idx % step == 0 || idx + 1 == s.equity_curve.len() {
            if !first {
                eq_str.push(',');
            }
            first = false;
            eq_str.push_str(&format!("{:.2}", val));
        }
    }
    eq_str.push(']');

    let mut pnl_str = String::with_capacity(512);
    pnl_str.push('[');
    for (idx, p) in s.trade_pnls.iter().take(200).enumerate() {
        if idx > 0 {
            pnl_str.push(',');
        }
        pnl_str.push_str(&format!("{:.2}", p));
    }
    pnl_str.push(']');

    format!(
        "{{\"initialCapital\":{:.2},\"finalEquity\":{:.2},\"netProfit\":{:.2},\"netProfitPct\":{:.2},\"totalTrades\":{},\"winningTrades\":{},\"winRatePct\":{:.2},\"profitFactor\":{:.2},\"maxDrawdownPct\":{:.2},\"sharpeRatio\":{:.2},\"totalFees\":{:.2},\"equityCurve\":{},\"tradePnls\":{}}}",
        s.initial_capital,
        s.final_equity,
        s.net_profit,
        s.net_profit_pct,
        s.total_trades,
        s.winning_trades,
        s.win_rate_pct,
        s.profit_factor,
        s.max_drawdown_pct,
        s.sharpe_ratio,
        s.total_fees,
        eq_str,
        pnl_str,
    )
}
