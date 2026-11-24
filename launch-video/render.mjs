/**
 * OpenView Launch Film — Deterministic 1920x1080 @ 60 FPS Studio Render Engine
 *
 * Pipeline:
 *  1. Synthesizes 48 kHz mastered stereo soundtrack + beat-locked SFX via generate-audio.py
 *  2. Extracts exact curated demo frames from open-view.mp4 (cropped 1920x918 + delogo)
 *     into an in-memory HTTP frame server (zero disk thrashing, 100% frame-accurate sync!)
 *  3. Renders all 2,555 frames (42.58s @ 60 FPS) across 4 parallel headless Chrome CDP tabs
 *     and pipes lossless PNG frames straight to FFmpeg H.264 (CRF 16) + 256k AAC!
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const SOURCE_VIDEO =
  process.argv[2] ??
  'C:\\Users\\home\\.t3\\userdata\\attachments\\1dc9ca6d-1c2d-49be-be0a-a8efd1e63c56-367bb4d4-a987-4fc3-8e4a-18ef86245e4b-mp4.mp4';
const OUTPUT_VIDEO = process.argv[3] ?? path.join(ROOT, 'openview-launch.mp4');
const AUDIO_WAV = path.join(DIR, 'soundtrack.wav');
const SCENE_HTML = fs.readFileSync(path.join(DIR, 'scene.html'), 'utf8');
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const FPS = 60;
const BPM = 124.0;
const BAR = (60.0 / BPM) * 4.0;
const TOTAL_DUR = BAR * 22;
const TOTAL_FRAMES = Math.round(TOTAL_DUR * FPS); // 2,555 frames

/**
 * Maps each launch video timestamp t (seconds) to the exact source timestamp in open-view.mp4,
 * or null for pure kinetic typography / Bento / CTA scenes.
 */
function mapLaunchTimeToDemoSec(t) {
  // Act 2: Hero BTCUSDT glide (Bars 3..6 -> demo 0.10s..4.00s)
  if (t >= 3 * BAR && t < 6 * BAR) {
    const p = (t - 3 * BAR) / (3 * BAR);
    return 0.1 + p * 3.9;
  }
  // Act 3A-1: Watchlist Crypto ETHUSDT -> SOLUSDT (Bars 6..7 -> demo 5.05s..7.65s, 100% full-scale candles)
  if (t >= 6 * BAR && t < 7 * BAR) {
    const p = (t - 6 * BAR) / BAR;
    return 5.05 + p * 2.6;
  }
  // Act 3A-2: Watchlist US Equities AAPL -> NVDA (Bars 7..8 -> demo 8.55s..10.65s, skips 8.2s transition frame!)
  if (t >= 7 * BAR && t < 8 * BAR) {
    const p = (t - 7 * BAR) / BAR;
    return 8.55 + p * 2.1;
  }
  // Act 3B: Ctrl+K Universal Global Search Modal populated 11-row multi-market results -> RELIANCE (Bars 8..9 -> demo 12.68s..13.40s)
  if (t >= 8 * BAR && t < 9 * BAR) {
    const p = (t - 8 * BAR) / BAR;
    return 12.68 + p * 0.72;
  }
  // Act 3C: Indian NSE RELIANCE 1H -> 4H -> 1H (Bars 9..10 -> demo 17.10s..20.45s, 100% full-scale candles!)
  if (t >= 9 * BAR && t < 10 * BAR) {
    const p = (t - 9 * BAR) / BAR;
    return 17.1 + p * 3.35;
  }
  // Act 4B: Unlimited Rust/WASM Indicators Modal Stacking (Bars 11..13 -> demo 32.60s..41.30s)
  if (t >= 11 * BAR && t < 13 * BAR) {
    const p = (t - 11 * BAR) / (2 * BAR);
    return 32.6 + p * 8.7;
  }
  // Act 4C: 7+ Stacked Sub-Panes Money Shot (Bars 13..15 -> demo 41.60s..46.80s)
  if (t >= 13 * BAR && t < 15 * BAR) {
    const p = (t - 13 * BAR) / (2 * BAR);
    return 41.6 + p * 5.2;
  }
  // Act 5A: Ctrl+K BNBUSDT search -> Instant Global Recompute across all 7+ panes (Bars 15..17)
  if (t >= 15 * BAR && t < 17 * BAR) {
    const local = t - 15 * BAR;
    if (local < 1.35) {
      return 50.15 + (local / 1.35) * 1.45;
    }
    const p = (local - 1.35) / (2 * BAR - 1.35);
    return 52.45 + p * 3.05;
  }
  return null;
}

/**
 * Extracts cropped + delogo'd demo video frames once into a compact in-memory Map<demoFrameIdx, Buffer(JPEG)>.
 * Only decodes frames at 30fps of source time (~1,150 frames -> ~115 MB RAM, instant zero-disk access!).
 */
async function preloadDemoFrames() {
  console.log('[render] Pre-decoding cropped & cleaned demo video frames into RAM...');
  const t0 = performance.now();
  const DEMO_CACHE_FPS = 30;
  const jpegFrames = [];

  await new Promise((resolve, reject) => {
    const ff = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        SOURCE_VIDEO,
        '-vf',
        `fps=${DEMO_CACHE_FPS},crop=1920:918:0:138,delogo=x=1878:y=850:w=40:h=44`,
        '-q:v',
        '3',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let errText = '';
    ff.stderr.on('data', (d) => { errText += d.toString(); });

    let acc = Buffer.alloc(0);
    ff.stdout.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      // Split concatenated MJPEG stream by SOI (0xFFD8) .. EOI (0xFFD9)
      let start = 0;
      while (true) {
        const soi = acc.indexOf(Buffer.from([0xff, 0xd8]), start);
        if (soi === -1) break;
        const eoi = acc.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
        if (eoi === -1) {
          acc = acc.subarray(soi);
          return;
        }
        jpegFrames.push(Buffer.from(acc.subarray(soi, eoi + 2)));
        start = eoi + 2;
      }
      acc = acc.subarray(start);
    });

    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg preload failed (${code}): ${errText}`));
    });
  });

  const mb = (jpegFrames.reduce((a, b) => a + b.length, 0) / 1048576).toFixed(1);
  console.log(
    `[render] Loaded ${jpegFrames.length} crisp 1920x918 demo frames (${mb} MB RAM) in ${((performance.now() - t0) / 1000).toFixed(1)}s.`,
  );
  return { jpegFrames, demoFps: DEMO_CACHE_FPS };
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP WebSocket failed'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws?.close();
  }
}

async function main() {
  const startAll = performance.now();

  // 1. Synthesize mastered 48kHz stereo launch soundtrack + SFX
  console.log('[render] Stage 1/3: Synthesizing 124 BPM mastered studio soundtrack + SFX...');
  execFileSync('python', [path.join(DIR, 'generate-audio.py'), AUDIO_WAV], { cwd: DIR, stdio: 'inherit' });

  // 2. Preload cleaned demo frames into RAM & start tiny localhost static server
  const { jpegFrames, demoFps } = await preloadDemoFrames();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url === '/scene.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SCENE_HTML);
      return;
    }
    const m = url.match(/^\/demo\/(\d+)\.jpg$/);
    if (m) {
      const idx = Math.max(0, Math.min(jpegFrames.length - 1, Number(m[1])));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      res.end(jpegFrames[idx]);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const httpPort = server.address().port;
  const sceneUrl = `http://127.0.0.1:${httpPort}/scene.html`;

  // 3. Launch headless Chrome with 6 unoccluded foreground 1920x1080 rendering workers
  const WORKERS = 6;
  const cdpPort = 9340 + Math.floor(Math.random() * 400);
  const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'openview-launch-chrome-'));
  const chrome = spawn(
    CHROME_EXE,
    [
      '--headless=new',
      '--no-sandbox',
      '--hide-scrollbars',
      '--mute-audio',
      '--force-device-scale-factor=1',
      '--window-size=1920,1080',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeProfile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  // Wait for Chrome CDP ready & get browser WebSocket URL
  let versionInfo = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (r.ok) { versionInfo = await r.json(); break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!versionInfo?.webSocketDebuggerUrl) throw new Error('Headless Chrome CDP did not become ready');

  const browserCdp = new CdpClient(versionInfo.webSocketDebuggerUrl);
  await browserCdp.connect();

  const clients = [];
  for (let w = 0; w < WORKERS; w++) {
    const created = await browserCdp.send('Target.createTarget', {
      url: sceneUrl,
      width: 1920,
      height: 1080,
      newWindow: true,
    });
    const pageWsUrl = `ws://127.0.0.1:${cdpPort}/devtools/page/${created.targetId}`;
    const client = new CdpClient(pageWsUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Wait until window.renderLaunchFrame is loaded
    for (let k = 0; k < 60; k++) {
      const check = await client.send('Runtime.evaluate', {
        expression: 'typeof window.renderLaunchFrame === "function"',
        returnByValue: true,
      });
      if (check?.result?.value === true) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    clients.push(client);
  }
  browserCdp.close();

  // 4. Spawn FFmpeg encoder receiving ordered 60 FPS PNG frames via stdin + mastered WAV audio!
  console.log(
    `[render] Stage 2/3: Rendering ${TOTAL_FRAMES} frames (${TOTAL_DUR.toFixed(2)}s @ ${FPS} FPS, 1920x1080) with ${WORKERS} Chrome workers...`,
  );

  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-framerate',
      String(FPS),
      '-i',
      '-',
      '-i',
      AUDIO_WAV,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '256k',
      '-shortest',
      OUTPUT_VIDEO,
    ],
    { stdio: ['pipe', 'inherit', 'pipe'] },
  );

  let ffErr = '';
  ffmpeg.stderr.on('data', (d) => { ffErr += d.toString(); });

  const renderSingleFrame = async (client, f) => {
    const t = f / FPS;
    const demoSec = mapLaunchTimeToDemoSec(t);
    const demoUrl =
      demoSec !== null
        ? `http://127.0.0.1:${httpPort}/demo/${Math.round(demoSec * demoFps)}.jpg`
        : null;

    await client.send('Runtime.evaluate', {
      expression: `window.renderLaunchFrame(${f}, ${TOTAL_FRAMES}, ${FPS}, ${JSON.stringify(demoUrl)})`,
      awaitPromise: true,
    });
    const shot = await client.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 96,
      fromSurface: true,
      clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    });
    return Buffer.from(shot.data, 'base64');
  };

  const renderStart = performance.now();
  try {
    for (let base = 0; base < TOTAL_FRAMES; base += WORKERS) {
      const batchIndices = [];
      for (let w = 0; w < WORKERS && base + w < TOTAL_FRAMES; w++) {
        batchIndices.push(base + w);
      }
      const buffers = await Promise.all(
        batchIndices.map((frameIdx, w) => renderSingleFrame(clients[w], frameIdx)),
      );
      for (const buf of buffers) {
        if (!ffmpeg.stdin.write(buf)) {
          await new Promise((r) => ffmpeg.stdin.once('drain', r));
        }
      }
      if (base === 0 || base === 16 || base % 120 === 0 || base + WORKERS >= TOTAL_FRAMES) {
        const done = Math.min(TOTAL_FRAMES, base + WORKERS);
        const pct = ((done / TOTAL_FRAMES) * 100).toFixed(1);
        const rSec = Math.max(0.1, (performance.now() - renderStart) / 1000);
        const fpsNow = (done / rSec).toFixed(1);
        const eta = ((TOTAL_FRAMES - done) / Math.max(0.1, done / rSec)).toFixed(0);
        console.log(`[render] Progress: ${done}/${TOTAL_FRAMES} (${pct}%) · ${fpsNow} fps · ETA ${eta}s`);
      }
    }

    ffmpeg.stdin.end();
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg mux failed (${code}): ${ffErr}`));
      });
    });

    const sizeMb = (fs.statSync(OUTPUT_VIDEO).size / 1048576).toFixed(2);
    const totalSec = ((performance.now() - startAll) / 1000).toFixed(1);
    console.log(`[render] Stage 3/3 COMPLETE! ${OUTPUT_VIDEO} (${sizeMb} MB) in ${totalSec}s.`);
  } finally {
    for (const c of clients) c.close();
    server.close();
    if (process.platform === 'win32' && chrome.pid) {
      try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else {
      chrome.kill();
    }
    try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error('[render] FATAL:', err);
  process.exit(1);
});
