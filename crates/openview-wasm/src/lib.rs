use wasm_bindgen::prelude::*;

pub mod arena;
pub mod ta;

pub use arena::BarArena;

#[wasm_bindgen]
pub fn openview_wasm_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Compute Simple Moving Average (SMA) over a Float64 slice.
/// Warmup indices (< period - 1) return f64::NAN.
#[wasm_bindgen]
pub fn ta_sma(values: &[f64], period: usize) -> Vec<f64> {
    ta::sma(values, period)
}

/// Compute Exponential Moving Average (EMA) matching TradingView's SMA-seeded formula.
#[wasm_bindgen]
pub fn ta_ema(values: &[f64], period: usize) -> Vec<f64> {
    ta::ema(values, period)
}

/// Compute Wilder's Running Moving Average (RMA / SMMA), alpha = 1 / period, SMA-seeded.
#[wasm_bindgen]
pub fn ta_rma(values: &[f64], period: usize) -> Vec<f64> {
    ta::rma(values, period)
}

/// Compute Relative Strength Index (RSI) using Wilder's RMA smoothing (TradingView parity).
#[wasm_bindgen]
pub fn ta_rsi(values: &[f64], period: usize) -> Vec<f64> {
    ta::rsi(values, period)
}

/// Compute Bollinger Bands with population standard deviation (ddof = 0, TradingView parity).
/// Returns flattened [basis..., upper..., lower...] of length 3 * values.len().
#[wasm_bindgen]
pub fn ta_bollinger_bands(values: &[f64], period: usize, mult: f64) -> Vec<f64> {
    let (basis, upper, lower) = ta::bollinger_bands(values, period, mult);
    let mut out = Vec::with_capacity(values.len() * 3);
    out.extend_from_slice(&basis);
    out.extend_from_slice(&upper);
    out.extend_from_slice(&lower);
    out
}
