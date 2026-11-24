/// Core Technical Analysis primitives with strict TradingView numerical parity:
/// - Wilder's RMA (alpha = 1 / period, SMA-seeded)
/// - SMA-seeded EMA (alpha = 2 / (period + 1))
/// - Bollinger Bands with population standard deviation (ddof = 0)

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
        // TradingView uses population stdev (ddof = 0)
        let stdev = (var_sum / (period as f64)).sqrt();
        upper[i] = mean + mult * stdev;
        lower[i] = mean - mult * stdev;
    }

    (basis, upper, lower)
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
        // Classic Wilder 14-period RSI textbook sequence
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
        // Mean = 5.0, Population stdev = 2.0 -> upper = 9.0, lower = 1.0
        assert!((basis[7] - 5.0).abs() < 1e-12);
        assert!((upper[7] - 9.0).abs() < 1e-12);
        assert!((lower[7] - 1.0).abs() < 1e-12);
    }
}
