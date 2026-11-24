"""
OpenView Launch Film — Studio Soundtrack & Motion SFX Synthesizer (48 kHz Stereo)
124 BPM · F# Minor / A Major · 22 Bars (42.5806s)
Exact musical choreography locked to every visual beat, cut, riser, and bass drop.
"""
import math
import os
import wave
import numpy as np
from scipy.signal import butter, filtfilt, lfilter

SR = 48_000
BPM = 124.0
BEAT = 60.0 / BPM          # 0.4838709677 s
BAR = BEAT * 4.0           # 1.9354838710 s
NUM_BARS = 22
DURATION = BAR * NUM_BARS  # 42.580645 s
N = int(round(DURATION * SR))

rng = np.random.default_rng(20261125)


def midi_to_hz(m: float) -> float:
    return 440.0 * (2.0 ** ((m - 69.0) / 12.0))


def add_stereo(buf: np.ndarray, start_s: float, sig_l: np.ndarray, sig_r: np.ndarray | None = None, gain: float = 1.0):
    i0 = int(round(start_s * SR))
    if i0 >= N:
        return
    if sig_r is None:
        sig_r = sig_l
    length = min(len(sig_l), N - max(0, i0))
    if i0 < 0:
        cut = -i0
        if cut >= len(sig_l):
            return
        sig_l = sig_l[cut:]
        sig_r = sig_r[cut:]
        i0 = 0
        length = min(len(sig_l), N)
    if length <= 0:
        return
    buf[0, i0:i0 + length] += sig_l[:length] * gain
    buf[1, i0:i0 + length] += sig_r[:length] * gain


def lp_filter(x: np.ndarray, cutoff_hz: float, order: int = 3) -> np.ndarray:
    nyq = SR * 0.5
    wn = max(0.001, min(0.98, cutoff_hz / nyq))
    b, a = butter(order, wn, btype='low')
    return lfilter(b, a, x)


def hp_filter(x: np.ndarray, cutoff_hz: float, order: int = 2) -> np.ndarray:
    nyq = SR * 0.5
    wn = max(0.001, min(0.98, cutoff_hz / nyq))
    b, a = butter(order, wn, btype='high')
    return lfilter(b, a, x)


def bp_filter(x: np.ndarray, lo_hz: float, hi_hz: float, order: int = 2) -> np.ndarray:
    nyq = SR * 0.5
    w0 = max(0.001, min(0.95, lo_hz / nyq))
    w1 = max(w0 + 0.005, min(0.98, hi_hz / nyq))
    b, a = butter(order, [w0, w1], btype='band')
    return lfilter(b, a, x)


def synth_kick(punch: float = 1.0) -> np.ndarray:
    dur = 0.34
    t = np.arange(int(dur * SR)) / SR
    # Pitch drop from 165 Hz -> 46 Hz
    freq = 46.0 + 125.0 * np.exp(-t * 36.0)
    phase = 2.0 * np.pi * np.cumsum(freq) / SR
    body = np.sin(phase) * np.exp(-t * 9.5)
    # Crisp transient click
    click = np.sin(2.0 * np.pi * 2400.0 * t) * np.exp(-t * 140.0) * 0.32
    raw = np.tanh((body * 1.45 + click) * 1.35 * punch)
    return raw * 0.88


def synth_clap() -> np.ndarray:
    dur = 0.22
    t = np.arange(int(dur * SR)) / SR
    noise = rng.standard_normal(len(t))
    # Layered micro-bursts for crisp modern clap/snare
    env = (
        np.exp(-((t - 0.000) / 0.006) ** 2) * 0.65
        + np.exp(-((t - 0.011) / 0.007) ** 2) * 0.80
        + np.exp(-((t - 0.021) / 0.048) ** 2) * 0.90 * (t >= 0.016)
    )
    tone = np.sin(2.0 * np.pi * 215.0 * t) * np.exp(-t * 26.0) * 0.35
    return bp_filter(noise * env, 850, 6800, 2) * 0.72 + tone


def synth_hihat(open_hat: bool = False) -> np.ndarray:
    dur = 0.19 if open_hat else 0.065
    t = np.arange(int(dur * SR)) / SR
    noise = rng.standard_normal(len(t))
    decay = 16.0 if open_hat else 68.0
    env = np.exp(-t * decay)
    return hp_filter(noise * env, 7200, 2) * (0.28 if open_hat else 0.19)


def synth_supersaw_chord(midi_notes: list[int], dur_s: float, cutoff_hz: float = 2200.0) -> tuple[np.ndarray, np.ndarray]:
    n = int(round(dur_s * SR))
    t = np.arange(n) / SR
    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)
    detunes = [-0.010, -0.004, 0.0, 0.004, 0.010]
    pans = [0.15, 0.35, 0.5, 0.65, 0.85]

    for note in midi_notes:
        f0 = midi_to_hz(note)
        for d, pan in zip(detunes, pans):
            f = f0 * (1.0 + d)
            ph = (t * f + rng.random()) % 1.0
            # Soft band-limited-ish saw + triangle blend for warm Apple/ODESZA sheen
            saw = 2.0 * ph - 1.0
            tri = 2.0 * np.abs(2.0 * ph - 1.0) - 1.0
            osc = 0.65 * saw + 0.35 * tri
            left += osc * (1.0 - pan)
            right += osc * pan

    norm = max(1.0, len(midi_notes) * len(detunes) * 0.42)
    left = lp_filter(left / norm, cutoff_hz, 3)
    right = lp_filter(right / norm, cutoff_hz, 3)

    # Smooth attack/release envelope
    atk = min(n // 4, int(0.06 * SR))
    rel = min(n // 3, int(0.18 * SR))
    env = np.ones(n, dtype=np.float64)
    if atk > 0:
        env[:atk] = np.linspace(0.0, 1.0, atk)
    if rel > 0:
        env[-rel:] = np.linspace(1.0, 0.0, rel)
    return left * env, right * env


def synth_pluck(midi_note: int, dur_s: float = 0.28, bright: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    n = int(round(dur_s * SR))
    t = np.arange(n) / SR
    f = midi_to_hz(midi_note)
    sig = (
        0.55 * np.sin(2.0 * np.pi * f * t)
        + 0.30 * np.sin(2.0 * np.pi * 2.0 * f * t) * np.exp(-t * 14.0)
        + 0.18 * np.sin(2.0 * np.pi * 3.0 * f * t) * np.exp(-t * 24.0)
        + 0.12 * (2.0 * ((t * f) % 1.0) - 1.0) * np.exp(-t * 18.0)
    )
    atk = int(0.004 * SR)
    env = np.exp(-t * 10.5)
    env[:atk] *= np.linspace(0.0, 1.0, atk)
    out = lp_filter(sig * env, 3400.0 * bright, 2)
    # Slight stereo Haas shimmer
    delay = int(0.006 * SR)
    r = np.zeros_like(out)
    r[delay:] = out[:-delay]
    return out, r


def synth_sub_bass(midi_note: int, dur_s: float) -> np.ndarray:
    n = int(round(dur_s * SR))
    t = np.arange(n) / SR
    f = midi_to_hz(midi_note)
    sig = np.sin(2.0 * np.pi * f * t) + 0.28 * np.sin(2.0 * np.pi * 2.0 * f * t)
    sig = np.tanh(sig * 1.25)
    atk = min(n // 5, int(0.015 * SR))
    rel = min(n // 4, int(0.08 * SR))
    env = np.ones(n)
    if atk > 0:
        env[:atk] = np.linspace(0, 1, atk)
    if rel > 0:
        env[-rel:] = np.linspace(1, 0, rel)
    return lp_filter(sig * env, 240.0, 2)


def synth_riser(dur_s: float) -> tuple[np.ndarray, np.ndarray]:
    n = int(round(dur_s * SR))
    t = np.arange(n) / SR
    prog = t / max(1e-6, dur_s)
    # Sweeping pitch synth + rising filtered white noise
    freq = 140.0 * (2.0 ** (prog * 3.4))
    phase = 2.0 * np.pi * np.cumsum(freq) / SR
    tone = np.sin(phase) * (prog ** 2.2) * 0.26
    noise = rng.standard_normal(n)
    # Time-varying simple resonant sweep via chunked bandpass
    swept = np.zeros(n)
    chunks = 16
    csize = n // chunks
    for c in range(chunks):
        s = c * csize
        e = n if c == chunks - 1 else (c + 1) * csize
        p = (c + 0.5) / chunks
        lo = 250.0 + 3800.0 * (p ** 2.0)
        hi = min(14000.0, lo + 2400.0)
        swept[s:e] = bp_filter(noise[s:e], lo, hi, 2) * (p ** 1.8)
    env = np.minimum(1.0, (1.0 - prog) * 40.0)  # Crisp tail cut right on drop!
    l = (tone + swept * 0.55) * env
    r = (tone + np.roll(swept, 90) * 0.55) * env
    return l, r


def synth_impact_drop() -> tuple[np.ndarray, np.ndarray]:
    dur = 1.65
    n = int(dur * SR)
    t = np.arange(n) / SR
    # Cinematic sub-boom (95 Hz -> 34 Hz) + metallic air burst
    freq = 34.0 + 68.0 * np.exp(-t * 9.0)
    phase = 2.0 * np.pi * np.cumsum(freq) / SR
    boom = np.tanh(np.sin(phase) * 1.6) * np.exp(-t * 2.4) * 0.85
    air = bp_filter(rng.standard_normal(n), 300, 5200, 2) * np.exp(-t * 5.2) * 0.32
    return boom + air, boom + np.roll(air, 65)


def synth_whoosh(dur_s: float = 0.28) -> tuple[np.ndarray, np.ndarray]:
    n = int(dur_s * SR)
    t = np.arange(n) / SR
    env = np.sin(np.pi * (t / dur_s)) ** 1.6
    noise = rng.standard_normal(n)
    w = bp_filter(noise, 450, 3600, 2) * env * 0.42
    # Pan left-to-right sweep
    pan = t / dur_s
    return w * (1.0 - pan * 0.65), w * (0.35 + pan * 0.65)


def synth_ui_tick(pitch_hz: float = 1650.0) -> np.ndarray:
    dur = 0.045
    t = np.arange(int(dur * SR)) / SR
    return (
        np.sin(2.0 * np.pi * pitch_hz * t) * np.exp(-t * 95.0) * 0.45
        + np.sin(2.0 * np.pi * pitch_hz * 1.5 * t) * np.exp(-t * 140.0) * 0.22
    )


def apply_stereo_reverb(buf: np.ndarray, wet: float = 0.20) -> np.ndarray:
    """Lush, clean multi-tap stereo algorithmic reverb for cinematic studio depth."""
    delays_l = [int(0.029 * SR), int(0.047 * SR), int(0.071 * SR), int(0.113 * SR), int(0.167 * SR)]
    delays_r = [int(0.031 * SR), int(0.053 * SR), int(0.079 * SR), int(0.127 * SR), int(0.181 * SR)]
    gains = [0.42, 0.34, 0.26, 0.19, 0.13]
    rev = np.zeros_like(buf)
    for d, g in zip(delays_l, gains):
        rev[0, d:] += buf[0, :-d] * g
    for d, g in zip(delays_r, gains):
        rev[1, d:] += buf[1, :-d] * g
    # Damp highs in reverb tail
    rev[0] = lp_filter(rev[0], 4400.0, 2)
    rev[1] = lp_filter(rev[1], 4400.0, 2)
    return buf * (1.0 - wet * 0.35) + rev * wet


def build_soundtrack(out_path: str):
    music = np.zeros((2, N), dtype=np.float64)
    drums = np.zeros((2, N), dtype=np.float64)
    sfx = np.zeros((2, N), dtype=np.float64)

    # Chord progression in F# minor / A major (euphoric modern tech anthem):
    # F#m9 -> Dmaj9 -> Aadd9 -> E6/9
    chords = [
        ([54, 57, 61, 64, 68], 42),  # F#m9 (bass F#2)
        ([50, 54, 57, 61, 64], 38),  # Dmaj9 (bass D2)
        ([57, 61, 64, 68, 71], 45),  # Aadd9 (bass A2)
        ([52, 56, 59, 64, 66], 40),  # E6/9  (bass E2)
    ]
    arp_scale = [66, 69, 73, 76, 78, 81, 85, 81]  # F# minor pentatonic + 9th

    kick = synth_kick(1.0)
    kick_heavy = synth_kick(1.25)
    clap = synth_clap()
    hat_c = synth_hihat(False)
    hat_o = synth_hihat(True)
    impact_l, impact_r = synth_impact_drop()

    # Sidechain gain curve driven by kick timestamps (modern pumping polish!)
    sidechain = np.ones(N, dtype=np.float64)

    def place_kick(t_s: float, heavy: bool = False):
        k = kick_heavy if heavy else kick
        add_stereo(drums, t_s, k, k, 0.88 if heavy else 0.78)
        # Duck music bus cleanly for 180ms on every kick
        i0 = int(round(t_s * SR))
        duck_len = int(0.18 * SR)
        if 0 <= i0 < N:
            L = min(duck_len, N - i0)
            curve = 0.38 + 0.62 * (np.linspace(0.0, 1.0, L) ** 0.75)
            sidechain[i0:i0 + L] = np.minimum(sidechain[i0:i0 + L], curve)

    for bar in range(NUM_BARS):
        t_bar = bar * BAR
        notes, bass_note = chords[bar % 4]

        # ── CHORD PADS & SUB-BASS BY SECTION ───────────────────────────────
        if bar in (0, 1):
            # Act 1A Hook: atmospheric filtered chord swell + pulsing sub heartbeat
            l, r = synth_supersaw_chord(notes, BAR * 1.02, cutoff_hz=950 + bar * 450)
            add_stereo(music, t_bar, l, r, 0.36)
            sub = synth_sub_bass(bass_note, BAR * 0.92)
            add_stereo(music, t_bar, sub, sub, 0.42)
        elif bar == 2:
            # Act 1B Logo Slam: big open bright chord!
            l, r = synth_supersaw_chord(notes, BAR * 1.04, cutoff_hz=3600)
            add_stereo(music, t_bar, l, r, 0.48)
            sub = synth_sub_bass(bass_note, BAR * 0.96)
            add_stereo(music, t_bar, sub, sub, 0.56)
        elif bar == 10:
            # Act 4A Paywall Smasher Interstitial: tense filtered break + riser
            l, r = synth_supersaw_chord(notes, BAR * 0.95, cutoff_hz=1100)
            add_stereo(music, t_bar, l, r, 0.34)
        elif 13 <= bar <= 18:
            # Peak Chorus (Bars 14-19): MASSIVE wide luminous supersaws + octave bass!
            l, r = synth_supersaw_chord(notes, BAR * 1.04, cutoff_hz=4800)
            add_stereo(music, t_bar, l, r, 0.52)
            sub = synth_sub_bass(bass_note, BAR * 0.96)
            add_stereo(music, t_bar, sub, sub, 0.62)
        elif bar >= 19:
            # Act 6 Grand Finale CTA (Bars 20-22): euphoric open major chord resolution!
            final_chord = [57, 61, 64, 68, 73, 76] if bar >= 20 else notes  # A major 9 shimmer
            dur = BAR * (1.8 if bar == 21 else 1.05)
            l, r = synth_supersaw_chord(final_chord, dur, cutoff_hz=3400 if bar < 21 else 2100)
            add_stereo(music, t_bar, l, r, 0.48 if bar < 21 else 0.40)
            sub = synth_sub_bass(45 if bar >= 20 else bass_note, BAR * 0.96)
            add_stereo(music, t_bar, sub, sub, 0.52 if bar < 21 else 0.36)
        else:
            # Main Groove (Bars 4-10, 12-13)
            cut = 2400 + (bar % 4) * 350
            l, r = synth_supersaw_chord(notes, BAR * 1.02, cutoff_hz=cut)
            add_stereo(music, t_bar, l, r, 0.42)
            sub = synth_sub_bass(bass_note, BAR * 0.95)
            add_stereo(music, t_bar, sub, sub, 0.54)

        # ── DRUMS & GROOVE (124 BPM) ──────────────────────────────────────
        if bar in (0, 1):
            # Minimal heartbeat pulse
            place_kick(t_bar, False)
            if bar == 1:
                place_kick(t_bar + 2 * BEAT, False)
        elif bar == 2:
            # Logo drop hit + minimal groove
            place_kick(t_bar, True)
            place_kick(t_bar + 2 * BEAT, False)
            add_stereo(drums, t_bar + 3 * BEAT, clap, clap, 0.55)
        elif bar == 10:
            # Tension snare roll build into Indicator Stacking
            for step in range(8):
                gain = 0.25 + 0.55 * (step / 7.0)
                add_stereo(drums, t_bar + step * (BEAT * 0.5), clap, clap, gain)
        elif bar in (20, 21):
            # Euphoric finale: clean gentle downbeat pulse on Bar 20, then lush reverb fade
            if bar == 20:
                place_kick(t_bar, True)
        else:
            # Full crisp 4-on-the-floor electronic tech groove!
            heavy = 13 <= bar <= 18
            for b in range(4):
                place_kick(t_bar + b * BEAT, heavy and b == 0)
                if b in (1, 3):
                    add_stereo(drums, t_bar + b * BEAT, clap, clap, 0.62 if heavy else 0.52)
                # Crisp 16th hi-hats with upbeat open hat
                for sub_i in range(4):
                    ht = t_bar + (b + sub_i * 0.25) * BEAT
                    if sub_i == 2:
                        add_stereo(drums, ht, hat_o, hat_o, 0.42 if heavy else 0.30)
                    elif sub_i in (1, 3):
                        add_stereo(drums, ht, hat_c, hat_c, 0.26)

        # ── SPARKLING SYNTH ARPEGGIO (Acts 2-5 + Finale shimmer) ──────────
        if (3 <= bar <= 18 and bar != 10) or bar == 19:
            step_count = 8
            for s in range(step_count):
                note_idx = (bar * 3 + s) % len(arp_scale)
                pitch = arp_scale[note_idx] + (12 if (13 <= bar <= 18 and s % 4 == 3) else 0)
                pl, pr = synth_pluck(pitch, 0.26, bright=1.3 if 13 <= bar <= 18 else 0.95)
                add_stereo(music, t_bar + s * (BEAT * 0.5), pl, pr, 0.23 if 13 <= bar <= 18 else 0.17)

    # ── CINEMATIC RISERS, DROPS & UI MOTION SFX ───────────────────────────
    # Red slash on "$60/mo -> $0. Forever." (Bar 1 beat 0 = 1.935s)
    wl, wr = synth_whoosh(0.24)
    add_stereo(sfx, 1.82, wl, wr, 0.85)
    add_stereo(sfx, 1.935, impact_l, impact_r, 0.55)

    # Riser -> Logo Slam at Bar 2 (3.871s)
    rl, rr = synth_riser(1.45)
    add_stereo(sfx, 2 * BAR - 1.45, rl, rr, 0.68)
    add_stereo(sfx, 2 * BAR, impact_l, impact_r, 0.92)

    # Hero window sweep-in whoosh (Bar 3 = 5.806s)
    wl2, wr2 = synth_whoosh(0.32)
    add_stereo(sfx, 3 * BAR - 0.12, wl2, wr2, 0.72)

    # Watchlist click ticks across Bars 6-7 (11.61s..15.48s)
    for k in range(4):
        tk = synth_ui_tick(1400 + k * 140)
        add_stereo(sfx, 6 * BAR + k * BEAT * 1.9, tk, tk, 0.55)

    # Ctrl+K Search modal zoom whoosh (Bar 8 = 15.48s)
    add_stereo(sfx, 8 * BAR - 0.10, wl2, wr2, 0.78)
    for k in range(5):
        tk = synth_ui_tick(1850 + (k % 3) * 180)
        add_stereo(sfx, 8 * BAR + 0.25 + k * 0.14, tk, tk, 0.42)

    # NSE Reliance cut whoosh (Bar 9 = 17.42s)
    add_stereo(sfx, 9 * BAR - 0.10, wl, wr, 0.65)

    # Paywall Smasher hit (Bar 10 = 19.35s) + Riser into Stacking
    add_stereo(sfx, 10 * BAR, impact_l, impact_r, 0.72)
    rl2, rr2 = synth_riser(1.70)
    add_stereo(sfx, 11 * BAR - 1.70, rl2, rr2, 0.72)

    # Unlimited Indicator Stacking counter ticks (Bars 11-12 = 21.29s..25.16s) + BIG DROP Riser!
    for k in range(6):
        tk = synth_ui_tick(1100 + k * 210)
        add_stereo(sfx, 11 * BAR + 0.35 + k * 0.52, tk, tk, 0.68)
    rl3, rr3 = synth_riser(1.85)
    add_stereo(sfx, 13 * BAR - 1.85, rl3, rr3, 0.88)

    # MASSIVE BASS DROP on 7+ Sub-Panes Money Shot (Bar 13 = 25.16s)!
    add_stereo(sfx, 13 * BAR, impact_l, impact_r, 1.05)

    # BNBUSDT Recompute transition whoosh (Bar 15 = 29.03s)
    add_stereo(sfx, 15 * BAR - 0.10, wl2, wr2, 0.72)

    # Bento 6-Card Feature Blitz staggered pops (Bars 17-18 = 32.90s)
    add_stereo(sfx, 17 * BAR - 0.12, wl2, wr2, 0.75)
    for k in range(6):
        tk = synth_ui_tick(1300 + k * 165)
        add_stereo(sfx, 17 * BAR + 0.12 + k * 0.22, tk, tk, 0.52)

    # Grand Finale CTA swell & crystalline chime (Bar 19 = 36.77s)
    add_stereo(sfx, 19 * BAR, impact_l, impact_r, 0.78)
    for idx, note in enumerate([76, 80, 83, 88]):  # E5 G#5 B5 E6 chime
        cl, cr = synth_pluck(note, 1.2, bright=1.4)
        add_stereo(sfx, 19 * BAR + 0.18 + idx * 0.11, cl, cr, 0.32)

    # Apply sidechain compression to music bus + lush reverb
    music_ducked = music * sidechain[None, :]
    music_wet = apply_stereo_reverb(music_ducked, wet=0.26)
    sfx_wet = apply_stereo_reverb(sfx, wet=0.22)

    master = music_wet + drums + sfx_wet

    # Clean fade-in (40ms) and smooth cinematic tail fade-out (last 1.4s)
    fi = int(0.04 * SR)
    fo = int(1.4 * SR)
    master[:, :fi] *= np.linspace(0.0, 1.0, fi)[None, :]
    master[:, -fo:] *= np.linspace(1.0, 0.0, fo)[None, :]

    # Studio soft-clip limiting & normalization to -1.0 dBFS (~0.89 peak)
    master = np.tanh(master * 1.12)
    peak = float(np.max(np.abs(master)))
    if peak > 0:
        master = master * (0.89 / peak)

    pcm16 = np.clip(master.T * 32767.0, -32768, 32767).astype(np.int16)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    chunk_frames = 65536
    with wave.open(out_path, 'wb') as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        for i in range(0, len(pcm16), chunk_frames):
            wf.writeframes(pcm16[i:i + chunk_frames].tobytes())

    print(f'[audio] Mastered {DURATION:.2f}s 48kHz stereo soundtrack -> {out_path} (peak={peak:.2f})')


if __name__ == '__main__':
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'soundtrack.wav')
    build_soundtrack(out)
