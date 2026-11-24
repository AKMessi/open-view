/// OpenView Technical Analysis Core (Rust -> WASM)
/// Engineered for strict TradingView numerical parity:
/// - Wilder's RMA (alpha = 1 / period, SMA-seeded) for RSI, ATR, ADX, SuperTrend
/// - SMA-seeded EMA (alpha = 2 / (period + 1)) for EMA, MACD, Keltner
/// - Population Standard Deviation (ddof = 0) for Bollinger Bands
/// - Session-anchored VWAP using exchange SessionCalendar break flags (IST 09:15, ET 09:30, FX 17:00 ET, UTC 00:00)

pub fn sma(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    if period == 0 || n < period {
        return out;
    }

    let mut sum = 0.0;
    let mut nan_count = 0usize;
    for i in 0..n {
        let v = values[i];
        if v.is_nan() {
            nan_count += 1;
        } else {
            sum += v;
        }
        if i >= period {
            let old = values[i - period];
            if old.is_nan() {
                nan_count -= 1;
            } else {
                sum -= old;
            }
        }
        if i + 1 >= period && nan_count == 0 {
            out[i] = sum / (period as f64);
        }
    }
    out
}

pub fn ema(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    if period == 0 || n < period {
        return out;
    }

    let alpha = 2.0 / ((period as f64) + 1.0);
    let mut seed_sum = 0.0;
    let mut seed_count = 0usize;
    let mut prev = f64::NAN;

    for i in 0..n {
        let v = values[i];
        if v.is_nan() {
            continue;
        }
        if prev.is_nan() {
            seed_sum += v;
            seed_count += 1;
            if seed_count == period {
                prev = seed_sum / (period as f64);
                out[i] = prev;
            }
        } else {
            prev = alpha * v + (1.0 - alpha) * prev;
            out[i] = prev;
        }
    }
    out
}

pub fn rma(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    if period == 0 || n < period {
        return out;
    }

    let alpha = 1.0 / (period as f64);
    let mut seed_sum = 0.0;
    let mut seed_count = 0usize;
    let mut prev = f64::NAN;

    for i in 0..n {
        let v = values[i];
        if v.is_nan() {
            continue;
        }
        if prev.is_nan() {
            seed_sum += v;
            seed_count += 1;
            if seed_count == period {
                prev = seed_sum / (period as f64);
                out[i] = prev;
            }
        } else {
            prev = alpha * v + (1.0 - alpha) * prev;
            out[i] = prev;
        }
    }
    out
}

pub fn wma(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    if period == 0 || n < period {
        return out;
    }
    let denom = ((period * (period + 1)) / 2) as f64;
    for i in (period - 1)..n {
        let mut weighted = 0.0;
        let mut has_nan = false;
        for k in 0..period {
            let v = values[i + 1 - period + k];
            if v.is_nan() {
                has_nan = true;
                break;
            }
            weighted += v * ((k + 1) as f64);
        }
        if !has_nan {
            out[i] = weighted / denom;
        }
    }
    out
}

pub fn hma(values: &[f64], period: usize) -> Vec<f64> {
    if period < 2 {
        return values.to_vec();
    }
    let half = (period / 2).max(1);
    let sqrt_p = (period as f64).sqrt().round().max(1.0) as usize;
    let wma_half = wma(values, half);
    let wma_full = wma(values, period);
    let diff: Vec<f64> = wma_half
        .iter()
        .zip(wma_full.iter())
        .map(|(&a, &b)| 2.0 * a - b)
        .collect();
    wma(&diff, sqrt_p)
}

pub fn vwma(values: &[f64], volume: &[f64], period: usize) -> Vec<f64> {
    let n = values.len().min(volume.len());
    let mut out = vec![f64::NAN; n];
    if period == 0 || n < period {
        return out;
    }
    let mut pv_sum = 0.0;
    let mut v_sum = 0.0;
    for i in 0..n {
        pv_sum += values[i] * volume[i];
        v_sum += volume[i];
        if i >= period {
            pv_sum -= values[i - period] * volume[i - period];
            v_sum -= volume[i - period];
        }
        if i + 1 >= period && v_sum > 0.0 {
            out[i] = pv_sum / v_sum;
        }
    }
    out
}

pub fn rsi(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    if period == 0 || n <= period {
        return out;
    }

    let mut gains = vec![f64::NAN; n];
    let mut losses = vec![f64::NAN; n];
    for i in 1..n {
        let diff = values[i] - values[i - 1];
        if !diff.is_nan() {
            gains[i] = if diff > 0.0 { diff } else { 0.0 };
            losses[i] = if diff < 0.0 { -diff } else { 0.0 };
        }
    }

    let avg_gain = rma(&gains, period);
    let avg_loss = rma(&losses, period);

    for i in period..n {
        let g = avg_gain[i];
        let l = avg_loss[i];
        if g.is_nan() || l.is_nan() {
            continue;
        }
        if l == 0.0 {
            out[i] = if g == 0.0 { 50.0 } else { 100.0 };
        } else {
            let rs = g / l;
            out[i] = 100.0 - (100.0 / (1.0 + rs));
        }
    }
    out
}

pub fn macd(values: &[f64], fast: usize, slow: usize, signal: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = values.len();
    let fast_ema = ema(values, fast);
    let slow_ema = ema(values, slow);
    let mut macd_line = vec![f64::NAN; n];
    for i in 0..n {
        if !fast_ema[i].is_nan() && !slow_ema[i].is_nan() {
            macd_line[i] = fast_ema[i] - slow_ema[i];
        }
    }
    let signal_line = ema(&macd_line, signal);
    let mut hist = vec![f64::NAN; n];
    for i in 0..n {
        if !macd_line[i].is_nan() && !signal_line[i].is_nan() {
            hist[i] = macd_line[i] - signal_line[i];
        }
    }
    (macd_line, signal_line, hist)
}

pub fn true_range(high: &[f64], low: &[f64], close: &[f64]) -> Vec<f64> {
    let n = high.len().min(low.len()).min(close.len());
    let mut out = vec![f64::NAN; n];
    if n == 0 {
        return out;
    }
    out[0] = high[0] - low[0];
    for i in 1..n {
        let hl = high[i] - low[i];
        let hc = (high[i] - close[i - 1]).abs();
        let lc = (low[i] - close[i - 1]).abs();
        out[i] = hl.max(hc).max(lc);
    }
    out
}

pub fn atr(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    let tr = true_range(high, low, close);
    rma(&tr, period)
}

pub fn bollinger_bands(values: &[f64], period: usize, mult: f64) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = values.len();
    let basis = sma(values, period);
    let mut upper = vec![f64::NAN; n];
    let mut lower = vec![f64::NAN; n];
    if period == 0 || n < period {
        return (basis, upper, lower);
    }

    for i in (period - 1)..n {
        let mean = basis[i];
        if mean.is_nan() {
            continue;
        }
        let mut var_sum = 0.0;
        for &v in &values[(i + 1 - period)..=i] {
            let d = v - mean;
            var_sum += d * d;
        }
        let stdev = (var_sum / (period as f64)).sqrt();
        upper[i] = mean + mult * stdev;
        lower[i] = mean - mult * stdev;
    }

    (basis, upper, lower)
}

pub fn keltner_channels(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    period: usize,
    mult: f64,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = close.len();
    let basis = ema(close, period);
    let atr_vals = atr(high, low, close, period);
    let mut upper = vec![f64::NAN; n];
    let mut lower = vec![f64::NAN; n];
    for i in 0..n {
        if !basis[i].is_nan() && !atr_vals[i].is_nan() {
            upper[i] = basis[i] + mult * atr_vals[i];
            lower[i] = basis[i] - mult * atr_vals[i];
        }
    }
    (basis, upper, lower)
}

pub fn donchian_channels(high: &[f64], low: &[f64], period: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = high.len().min(low.len());
    let mut upper = vec![f64::NAN; n];
    let mut lower = vec![f64::NAN; n];
    let mut mid = vec![f64::NAN; n];
    if period == 0 || n < period {
        return (mid, upper, lower);
    }
    for i in (period - 1)..n {
        let mut hi = f64::NEG_INFINITY;
        let mut lo = f64::INFINITY;
        for j in (i + 1 - period)..=i {
            if high[j] > hi {
                hi = high[j];
            }
            if low[j] < lo {
                lo = low[j];
            }
        }
        upper[i] = hi;
        lower[i] = lo;
        mid[i] = (hi + lo) * 0.5;
    }
    (mid, upper, lower)
}

/// TradingView-exact SuperTrend:
/// Returns (supertrend_line, direction) where direction = +1.0 (bullish) or -1.0 (bearish).
pub fn supertrend(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    period: usize,
    factor: f64,
) -> (Vec<f64>, Vec<f64>) {
    let n = high.len().min(low.len()).min(close.len());
    let atr_vals = atr(high, low, close, period);
    let mut line = vec![f64::NAN; n];
    let mut dir = vec![f64::NAN; n];
    let mut final_upper = vec![f64::NAN; n];
    let mut final_lower = vec![f64::NAN; n];

    for i in 0..n {
        let a = atr_vals[i];
        if a.is_nan() {
            continue;
        }
        let hl2 = (high[i] + low[i]) * 0.5;
        let basic_upper = hl2 + factor * a;
        let basic_lower = hl2 - factor * a;

        if i == 0 || final_upper[i - 1].is_nan() {
            final_upper[i] = basic_upper;
            final_lower[i] = basic_lower;
            dir[i] = 1.0;
            line[i] = final_lower[i];
            continue;
        }

        let prev_u = final_upper[i - 1];
        let prev_l = final_lower[i - 1];
        let prev_c = close[i - 1];

        final_upper[i] = if basic_upper < prev_u || prev_c > prev_u {
            basic_upper
        } else {
            prev_u
        };
        final_lower[i] = if basic_lower > prev_l || prev_c < prev_l {
            basic_lower
        } else {
            prev_l
        };

        let prev_dir = dir[i - 1];
        if prev_dir < 0.0 {
            if close[i] > final_upper[i] {
                dir[i] = 1.0;
                line[i] = final_lower[i];
            } else {
                dir[i] = -1.0;
                line[i] = final_upper[i];
            }
        } else if close[i] < final_lower[i] {
            dir[i] = -1.0;
            line[i] = final_upper[i];
        } else {
            dir[i] = 1.0;
            line[i] = final_lower[i];
        }
    }

    (line, dir)
}

/// Stochastic Oscillator (%K smoothed, %D)
pub fn stochastic(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    k_period: usize,
    smooth_k: usize,
    d_period: usize,
) -> (Vec<f64>, Vec<f64>) {
    let n = high.len().min(low.len()).min(close.len());
    let mut raw_k = vec![f64::NAN; n];
    if k_period > 0 && n >= k_period {
        for i in (k_period - 1)..n {
            let mut hi = f64::NEG_INFINITY;
            let mut lo = f64::INFINITY;
            for j in (i + 1 - k_period)..=i {
                if high[j] > hi {
                    hi = high[j];
                }
                if low[j] < lo {
                    lo = low[j];
                }
            }
            let denom = hi - lo;
            raw_k[i] = if denom > 0.0 {
                ((close[i] - lo) / denom) * 100.0
            } else {
                50.0
            };
        }
    }
    let k = if smooth_k <= 1 { raw_k } else { sma(&raw_k, smooth_k) };
    let d = sma(&k, d_period);
    (k, d)
}

/// Wilder's ADX / DMI (+DI, -DI, ADX)
pub fn adx_dmi(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    period: usize,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = high.len().min(low.len()).min(close.len());
    let mut plus_dm = vec![f64::NAN; n];
    let mut minus_dm = vec![f64::NAN; n];
    for i in 1..n {
        let up = high[i] - high[i - 1];
        let down = low[i - 1] - low[i];
        plus_dm[i] = if up > down && up > 0.0 { up } else { 0.0 };
        minus_dm[i] = if down > up && down > 0.0 { down } else { 0.0 };
    }
    let tr = true_range(high, low, close);
    let smooth_tr = rma(&tr, period);
    let smooth_plus = rma(&plus_dm, period);
    let smooth_minus = rma(&minus_dm, period);

    let mut plus_di = vec![f64::NAN; n];
    let mut minus_di = vec![f64::NAN; n];
    let mut dx = vec![f64::NAN; n];
    for i in 0..n {
        if smooth_tr[i].is_nan() || smooth_tr[i] == 0.0 || smooth_plus[i].is_nan() {
            continue;
        }
        let pdi = 100.0 * smooth_plus[i] / smooth_tr[i];
        let mdi = 100.0 * smooth_minus[i] / smooth_tr[i];
        plus_di[i] = pdi;
        minus_di[i] = mdi;
        let denom = pdi + mdi;
        dx[i] = if denom > 0.0 {
            100.0 * (pdi - mdi).abs() / denom
        } else {
            0.0
        };
    }
    let adx = rma(&dx, period);
    (plus_di, minus_di, adx)
}

pub fn cci(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    let n = high.len().min(low.len()).min(close.len());
    let tp: Vec<f64> = (0..n).map(|i| (high[i] + low[i] + close[i]) / 3.0).collect();
    let mean = sma(&tp, period);
    let mut out = vec![f64::NAN; n];
    if period == 0 || n < period {
        return out;
    }
    for i in (period - 1)..n {
        let m = mean[i];
        if m.is_nan() {
            continue;
        }
        let mut dev = 0.0;
        for &v in &tp[(i + 1 - period)..=i] {
            dev += (v - m).abs();
        }
        let mean_dev = dev / (period as f64);
        out[i] = if mean_dev > 0.0 {
            (tp[i] - m) / (0.015 * mean_dev)
        } else {
            0.0
        };
    }
    out
}

pub fn obv(close: &[f64], volume: &[f64]) -> Vec<f64> {
    let n = close.len().min(volume.len());
    let mut out = vec![0.0; n];
    for i in 1..n {
        if close[i] > close[i - 1] {
            out[i] = out[i - 1] + volume[i];
        } else if close[i] < close[i - 1] {
            out[i] = out[i - 1] - volume[i];
        } else {
            out[i] = out[i - 1];
        }
    }
    out
}

pub fn mfi(high: &[f64], low: &[f64], close: &[f64], volume: &[f64], period: usize) -> Vec<f64> {
    let n = high.len().min(low.len()).min(close.len()).min(volume.len());
    let mut out = vec![f64::NAN; n];
    if period == 0 || n <= period {
        return out;
    }
    let tp: Vec<f64> = (0..n).map(|i| (high[i] + low[i] + close[i]) / 3.0).collect();
    let mut pos = vec![0.0; n];
    let mut neg = vec![0.0; n];
    for i in 1..n {
        let mf = tp[i] * volume[i];
        if tp[i] > tp[i - 1] {
            pos[i] = mf;
        } else if tp[i] < tp[i - 1] {
            neg[i] = mf;
        }
    }
    let mut pos_sum = 0.0;
    let mut neg_sum = 0.0;
    for i in 1..n {
        pos_sum += pos[i];
        neg_sum += neg[i];
        if i > period {
            pos_sum -= pos[i - period];
            neg_sum -= neg[i - period];
        }
        if i >= period {
            if neg_sum == 0.0 {
                out[i] = if pos_sum == 0.0 { 50.0 } else { 100.0 };
            } else {
                let ratio = pos_sum / neg_sum;
                out[i] = 100.0 - (100.0 / (1.0 + ratio));
            }
        }
    }
    out
}

/// Session-Anchored VWAP with ±1σ bands.
/// `session_breaks[i] == 1` resets cumulative sums at exchange session open (09:15 IST, 09:30 ET, etc.).
/// Gracefully outputs NaN when volume == 0 across a zero-volume spot index unless proxy volume is passed.
pub fn session_vwap(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    volume: &[f64],
    session_breaks: &[u8],
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = high.len().min(low.len()).min(close.len()).min(volume.len());
    let mut vwap = vec![f64::NAN; n];
    let mut upper1 = vec![f64::NAN; n];
    let mut lower1 = vec![f64::NAN; n];

    let mut cum_pv = 0.0;
    let mut cum_v = 0.0;
    let mut cum_p2v = 0.0;

    for i in 0..n {
        if i == 0 || session_breaks.get(i).copied().unwrap_or(0) != 0 {
            cum_pv = 0.0;
            cum_v = 0.0;
            cum_p2v = 0.0;
        }
        let v = volume[i];
        let tp = (high[i] + low[i] + close[i]) / 3.0;
        if v > 0.0 {
            cum_pv += tp * v;
            cum_v += v;
            cum_p2v += tp * tp * v;
        }
        if cum_v > 0.0 {
            let mean = cum_pv / cum_v;
            let var = (cum_p2v / cum_v - mean * mean).max(0.0);
            let std = var.sqrt();
            vwap[i] = mean;
            upper1[i] = mean + std;
            lower1[i] = mean - std;
        }
    }
    (vwap, upper1, lower1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sma_matches_exact_values() {
        let data = [10.0, 12.0, 14.0, 16.0, 18.0];
        let out = sma(&data, 3);
        assert!(out[0].is_nan());
        assert!(out[1].is_nan());
        assert!((out[2] - 12.0).abs() < 1e-12);
        assert!((out[3] - 14.0).abs() < 1e-12);
        assert!((out[4] - 16.0).abs() < 1e-12);
    }

    #[test]
    fn rsi_wilder_matches_tradingview_reference() {
        let closes = [
            44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
            45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
        ];
        let out = rsi(&closes, 14);
        assert!(out[13].is_nan());
        assert!((out[14] - 70.46414).abs() < 1e-4, "got {}", out[14]);
        assert!((out[15] - 66.24962).abs() < 1e-4, "got {}", out[15]);
        assert!((out[16] - 66.48094).abs() < 1e-4, "got {}", out[16]);
        assert!((out[17] - 69.34685).abs() < 1e-4, "got {}", out[17]);
        assert!((out[18] - 66.29472).abs() < 1e-4, "got {}", out[18]);
        assert!((out[19] - 57.91502).abs() < 1e-4, "got {}", out[19]);
    }

    #[test]
    fn bollinger_bands_use_population_ddof0() {
        let data = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0];
        let (basis, upper, lower) = bollinger_bands(&data, 8, 2.0);
        assert!((basis[7] - 5.0).abs() < 1e-12);
        assert!((upper[7] - 9.0).abs() < 1e-12);
        assert!((lower[7] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn session_vwap_resets_cleanly_at_session_breaks_and_handles_zero_volume() {
        let h = [102.0, 108.0, 202.0];
        let l = [98.0, 102.0, 198.0];
        let c = [100.0, 105.0, 200.0];
        let v = [100.0, 100.0, 50.0];
        let breaks = [1u8, 0u8, 1u8]; // Bar 2 starts new session!
        let (vw, u1, l1) = session_vwap(&h, &l, &c, &v, &breaks);
        assert!((vw[0] - 100.0).abs() < 1e-12);
        assert!((vw[1] - 102.5).abs() < 1e-12);
        assert!((u1[1] - 105.0).abs() < 1e-12);
        assert!((l1[1] - 100.0).abs() < 1e-12);
        // Session reset at index 2 -> VWAP resets strictly to 200.0
        assert!((vw[2] - 200.0).abs() < 1e-12);

        // Zero-volume spot index must produce NaN rather than 0/0 panic
        let zero_v = [0.0, 0.0, 0.0];
        let (zw, _, _) = session_vwap(&h, &l, &c, &zero_v, &breaks);
        assert!(zw[0].is_nan() && zw[1].is_nan() && zw[2].is_nan());
    }

    #[test]
    fn supertrend_flips_direction_on_band_break() {
        let h = [101.0, 102.0, 103.0, 104.0, 105.0, 90.0, 88.0];
        let l = [99.0, 100.0, 101.0, 102.0, 103.0, 85.0, 84.0];
        let c = [100.0, 101.0, 102.0, 103.0, 104.0, 86.0, 85.0];
        let (line, dir) = supertrend(&h, &l, &c, 3, 2.0);
        assert_eq!(dir[4], 1.0);
        assert_eq!(dir[5], -1.0);
        assert!(line[5] > c[5]);
    }

    #[test]
    fn macd_adx_and_stochastic_produce_valid_bounded_series() {
        let n = 80;
        let close: Vec<f64> = (0..n).map(|i| 100.0 + (i as f64) * 0.5 + ((i % 5) as f64)).collect();
        let high: Vec<f64> = close.iter().map(|c| c + 2.0).collect();
        let low: Vec<f64> = close.iter().map(|c| c - 2.0).collect();

        let (m, s, hist) = macd(&close, 12, 26, 9);
        assert!(!m[79].is_nan() && !s[79].is_nan());
        assert!(((m[79] - s[79]) - hist[79]).abs() < 1e-12);

        let (pdi, mdi, adx) = adx_dmi(&high, &low, &close, 14);
        assert!(pdi[79] > mdi[79]);
        assert!(adx[79] >= 0.0 && adx[79] <= 100.0);

        let (k, d) = stochastic(&high, &low, &close, 14, 3, 3);
        assert!(k[79] >= 0.0 && k[79] <= 100.0);
        assert!(d[79] >= 0.0 && d[79] <= 100.0);
    }
}
