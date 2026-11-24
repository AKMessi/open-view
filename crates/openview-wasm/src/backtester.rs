use crate::ta;

pub struct BacktestSummary {
    pub initial_capital: f64,
    pub final_equity: f64,
    pub net_profit: f64,
    pub net_profit_pct: f64,
    pub total_trades: usize,
    pub winning_trades: usize,
    pub win_rate_pct: f64,
    pub profit_factor: f64,
    pub max_drawdown_pct: f64,
    pub sharpe_ratio: f64,
    pub total_fees: f64,
    pub equity_curve: Vec<f64>,
    pub trade_pnls: Vec<f64>,
}

/// Deterministic Rust/WASM Strategy Backtester with Gap-Open Slippage Fill Realism.
/// Strategy IDs:
/// - 0: EMA Crossover (fast/slow)
/// - 1: RSI Mean Reversion (buy < 30, exit > 70)
/// - 2: SuperTrend Trend Following (period=fast, factor=slow/10)
pub fn run_backtest(
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
) -> BacktestSummary {
    let n = open.len().min(high.len()).min(low.len()).min(close.len());
    let mut equity_curve = Vec::with_capacity(n);
    let mut trade_pnls: Vec<f64> = Vec::new();

    if n < 30 || initial_capital <= 0.0 {
        return BacktestSummary {
            initial_capital,
            final_equity: initial_capital,
            net_profit: 0.0,
            net_profit_pct: 0.0,
            total_trades: 0,
            winning_trades: 0,
            win_rate_pct: 0.0,
            profit_factor: 0.0,
            max_drawdown_pct: 0.0,
            sharpe_ratio: 0.0,
            total_fees: 0.0,
            equity_curve: vec![initial_capital; n],
            trade_pnls,
        };
    }

    // Precompute strategy signals
    let (sig_a, sig_b): (Vec<f64>, Vec<f64>) = match strategy_id {
        1 => (ta::rsi(close, param_a.max(2)), vec![f64::NAN; n]),
        2 => {
            let factor = (param_b as f64 / 10.0).max(1.0);
            ta::supertrend(high, low, close, param_a.max(3), factor)
        }
        _ => (ta::ema(close, param_a.max(2)), ta::ema(close, param_b.max(3))),
    };

    let fee_rate = fee_bps / 10_000.0;
    let slip_rate = slippage_bps / 10_000.0;

    let mut cash = initial_capital;
    let mut qty = 0.0;
    let mut entry_price = 0.0;
    let mut entry_fee = 0.0;
    let mut sl_price = 0.0;
    let mut tp_price = 0.0;
    let mut total_fees = 0.0;
    let mut peak_equity = initial_capital;
    let mut max_dd_pct = 0.0;
    let mut pending_entry = false;
    let mut pending_exit = false;

    for i in 0..n {
        // 1. Execute orders triggered at previous bar's close at current bar.open (no lookahead!)
        if pending_entry && qty == 0.0 && open[i] > 0.0 {
            let fill = open[i] * (1.0 + slip_rate);
            let alloc = cash * 0.98;
            let fee = alloc * fee_rate;
            qty = (alloc - fee) / fill;
            entry_price = fill;
            entry_fee = fee;
            cash -= qty * fill + fee;
            total_fees += fee;
            sl_price = if stop_loss_pct > 0.0 {
                entry_price * (1.0 - stop_loss_pct / 100.0)
            } else {
                0.0
            };
            tp_price = if take_profit_pct > 0.0 {
                entry_price * (1.0 + take_profit_pct / 100.0)
            } else {
                f64::INFINITY
            };
            pending_entry = false;
        } else if pending_exit && qty > 0.0 {
            let fill = open[i] * (1.0 - slip_rate);
            let proceeds = qty * fill;
            let fee = proceeds * fee_rate;
            cash += proceeds - fee;
            total_fees += fee;
            let pnl = (fill - entry_price) * qty - entry_fee - fee;
            trade_pnls.push(pnl);
            qty = 0.0;
            pending_exit = false;
        }

        // 2. Check intrabar Stop-Loss & Take-Profit with Gap-Open Fill Realism
        if qty > 0.0 {
            let hit_sl = sl_price > 0.0 && low[i] <= sl_price;
            let hit_tp = tp_price.is_finite() && high[i] >= tp_price;

            if hit_sl && (!hit_tp || (open[i] - low[i]).abs() <= (open[i] - high[i]).abs()) {
                // Gap-open rule: if open <= sl_price, fill at open * (1 - slip), NEVER at impossible sl_price!
                let base_fill = if open[i] <= sl_price { open[i] } else { sl_price };
                let fill = base_fill * (1.0 - slip_rate);
                let proceeds = qty * fill;
                let fee = proceeds * fee_rate;
                cash += proceeds - fee;
                total_fees += fee;
                trade_pnls.push((fill - entry_price) * qty - entry_fee - fee);
                qty = 0.0;
            } else if hit_tp {
                let fill = if open[i] >= tp_price { open[i] } else { tp_price };
                let proceeds = qty * fill;
                let fee = proceeds * fee_rate;
                cash += proceeds - fee;
                total_fees += fee;
                trade_pnls.push((fill - entry_price) * qty - entry_fee - fee);
                qty = 0.0;
            }
        }

        // 3. Evaluate bar-close strategy signals for next bar open execution
        if i > 0 {
            match strategy_id {
                1 => {
                    // RSI Mean Reversion
                    let r = sig_a[i];
                    if !r.is_nan() {
                        if qty == 0.0 && r < 30.0 {
                            pending_entry = true;
                        } else if qty > 0.0 && r > 70.0 {
                            pending_exit = true;
                        }
                    }
                }
                2 => {
                    // SuperTrend direction flip
                    let d_prev = sig_b[i - 1];
                    let d_curr = sig_b[i];
                    if !d_prev.is_nan() && !d_curr.is_nan() {
                        if qty == 0.0 && d_prev < 0.0 && d_curr > 0.0 {
                            pending_entry = true;
                        } else if qty > 0.0 && d_prev > 0.0 && d_curr < 0.0 {
                            pending_exit = true;
                        }
                    }
                }
                _ => {
                    // EMA Crossover
                    let f0 = sig_a[i - 1];
                    let s0 = sig_b[i - 1];
                    let f1 = sig_a[i];
                    let s1 = sig_b[i];
                    if !f0.is_nan() && !s0.is_nan() && !f1.is_nan() && !s1.is_nan() {
                        if qty == 0.0 && f0 <= s0 && f1 > s1 {
                            pending_entry = true;
                        } else if qty > 0.0 && f0 >= s0 && f1 < s1 {
                            pending_exit = true;
                        }
                    }
                }
            }
        }

        let eq = cash + qty * close[i];
        equity_curve.push(eq);
        if eq > peak_equity {
            peak_equity = eq;
        }
        let dd = if peak_equity > 0.0 {
            ((peak_equity - eq) / peak_equity) * 100.0
        } else {
            0.0
        };
        if dd > max_dd_pct {
            max_dd_pct = dd;
        }
    }

    // Close open position at final bar for reporting
    if qty > 0.0 {
        let fill = close[n - 1];
        let proceeds = qty * fill;
        let fee = proceeds * fee_rate;
        cash += proceeds - fee;
        total_fees += fee;
        trade_pnls.push((fill - entry_price) * qty - entry_fee - fee);
        qty = 0.0;
        if let Some(last_eq) = equity_curve.last_mut() {
            *last_eq = cash;
        }
    }

    let final_equity = cash + qty * close[n - 1];
    let net_profit = final_equity - initial_capital;
    let net_profit_pct = (net_profit / initial_capital) * 100.0;
    let total_trades = trade_pnls.len();
    let mut winning_trades = 0usize;
    let mut gross_profit = 0.0;
    let mut gross_loss = 0.0;
    for &p in &trade_pnls {
        if p > 0.0 {
            winning_trades += 1;
            gross_profit += p;
        } else {
            gross_loss += -p;
        }
    }
    let win_rate_pct = if total_trades > 0 {
        (winning_trades as f64 / total_trades as f64) * 100.0
    } else {
        0.0
    };
    let profit_factor = if gross_loss > 0.0 {
        gross_profit / gross_loss
    } else if gross_profit > 0.0 {
        99.99
    } else {
        0.0
    };

    // Bar-return Sharpe Ratio approximation (annualized assuming 252 trading periods)
    let mut rets = Vec::with_capacity(n.saturating_sub(1));
    for i in 1..equity_curve.len() {
        let prev = equity_curve[i - 1];
        if prev > 0.0 {
            rets.push((equity_curve[i] - prev) / prev);
        }
    }
    let sharpe_ratio = if rets.len() > 2 {
        let mean = rets.iter().sum::<f64>() / (rets.len() as f64);
        let var = rets.iter().map(|r| (r - mean) * (r - mean)).sum::<f64>() / (rets.len() as f64);
        let std = var.sqrt();
        if std > 1e-12 {
            (mean / std) * (252.0_f64).sqrt()
        } else {
            0.0
        }
    } else {
        0.0
    };

    BacktestSummary {
        initial_capital,
        final_equity,
        net_profit,
        net_profit_pct,
        total_trades,
        winning_trades,
        win_rate_pct,
        profit_factor,
        max_drawdown_pct: max_dd_pct,
        sharpe_ratio,
        total_fees,
        equity_curve,
        trade_pnls,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backtester_runs_ema_cross_and_respects_gap_down_sl() {
        let n = 120;
        let mut o = Vec::with_capacity(n);
        let mut h = Vec::with_capacity(n);
        let mut l = Vec::with_capacity(n);
        let mut c = Vec::with_capacity(n);
        let mut p = 100.0;
        for i in 0..n {
            // Uptrend then sudden -15% overnight gap crash at bar 80
            if i == 80 {
                p *= 0.85;
            } else if i < 80 {
                p += if i < 20 { -0.2 } else { 0.8 };
            } else {
                p += 0.2;
            }
            o.push(p);
            h.push(p + 1.0);
            l.push(p - 1.0);
            c.push(p + 0.3);
        }

        let res = run_backtest(&o, &h, &l, &c, 0, 5, 15, 2.0, 0.0, 5.0, 2.0, 100_000.0);
        assert!(res.total_trades >= 1);
        assert!(
            res.max_drawdown_pct > 10.0,
            "gap-down past 2% SL must fill at open (-15%) and impact drawdown realistically, got {}",
            res.max_drawdown_pct
        );
        assert!(res.total_fees > 0.0);
    }
}
