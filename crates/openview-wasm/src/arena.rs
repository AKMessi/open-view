use wasm_bindgen::prelude::*;

/// Zero-copy resident OHLCV bar arena living inside the Web Worker / Node Worker WASM heap.
/// Live market updates push a single 48-byte incremental delta (6 x f64) instead of cloning arrays.
#[wasm_bindgen]
pub struct BarArena {
    time: Vec<f64>,
    open: Vec<f64>,
    high: Vec<f64>,
    low: Vec<f64>,
    close: Vec<f64>,
    volume: Vec<f64>,
}

#[wasm_bindgen]
impl BarArena {
    #[wasm_bindgen(constructor)]
    pub fn new(initial_capacity: usize) -> Self {
        let cap = initial_capacity.max(256);
        Self {
            time: Vec::with_capacity(cap),
            open: Vec::with_capacity(cap),
            high: Vec::with_capacity(cap),
            low: Vec::with_capacity(cap),
            close: Vec::with_capacity(cap),
            volume: Vec::with_capacity(cap),
        }
    }

    pub fn len(&self) -> usize {
        self.time.len()
    }

    pub fn clear(&mut self) {
        self.time.clear();
        self.open.clear();
        self.high.clear();
        self.low.clear();
        self.close.clear();
        self.volume.clear();
    }

    /// Bulk-load flattened bars: [t0, o0, h0, l0, c0, v0, t1, ...]
    pub fn set_bars_interleaved(&mut self, interleaved: &[f64]) {
        self.clear();
        let count = interleaved.len() / 6;
        self.time.reserve(count);
        self.open.reserve(count);
        self.high.reserve(count);
        self.low.reserve(count);
        self.close.reserve(count);
        self.volume.reserve(count);
        for chunk in interleaved.chunks_exact(6) {
            self.time.push(chunk[0]);
            self.open.push(chunk[1]);
            self.high.push(chunk[2]);
            self.low.push(chunk[3]);
            self.close.push(chunk[4]);
            self.volume.push(chunk[5]);
        }
    }

    /// Push a new bar or mutate the rightmost bar in-place (48-byte delta).
    /// Returns true if a new bar was appended, false if the rightmost bar was updated.
    pub fn upsert_bar(
        &mut self,
        time: f64,
        open: f64,
        high: f64,
        low: f64,
        close: f64,
        volume: f64,
    ) -> bool {
        if let Some(&last_t) = self.time.last() {
            if (last_t - time).abs() < f64::EPSILON {
                let idx = self.time.len() - 1;
                self.open[idx] = open;
                self.high[idx] = high;
                self.low[idx] = low;
                self.close[idx] = close;
                self.volume[idx] = volume;
                return false;
            }
        }
        self.time.push(time);
        self.open.push(open);
        self.high.push(high);
        self.low.push(low);
        self.close.push(close);
        self.volume.push(volume);
        true
    }

    pub fn last_close(&self) -> f64 {
        self.close.last().copied().unwrap_or(f64::NAN)
    }

    pub fn compute_sma_close(&self, period: usize) -> Vec<f64> {
        crate::ta::sma(&self.close, period)
    }

    pub fn compute_rsi_close(&self, period: usize) -> Vec<f64> {
        crate::ta::rsi(&self.close, period)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_upserts_in_place_and_appends() {
        let mut arena = BarArena::new(16);
        assert!(arena.upsert_bar(1000.0, 10.0, 12.0, 9.0, 11.0, 100.0));
        assert_eq!(arena.len(), 1);
        // Update same bar timestamp
        assert!(!arena.upsert_bar(1000.0, 10.0, 13.0, 9.0, 12.5, 150.0));
        assert_eq!(arena.len(), 1);
        assert_eq!(arena.last_close(), 12.5);
        // Append next bar
        assert!(arena.upsert_bar(2000.0, 12.5, 14.0, 12.0, 13.5, 80.0));
        assert_eq!(arena.len(), 2);
        assert_eq!(arena.last_close(), 13.5);
    }
}
