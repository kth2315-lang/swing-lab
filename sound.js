// 타구음 감지
import { log, nowMs } from './util.js';

let ctx = null;
export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}
// 버튼을 누른 순간에 불러야 iOS에서 소리 분석이 켜져요
export function unlockAudio() {
  const c = audioCtx();
  if (c && c.state !== 'running') c.resume().catch(() => {});
  return c;
}

export class HitDetector {
  constructor({ threshold = 0.3, onHit } = {}) {
    this.threshold = threshold;
    this.onHit = onHit;
    this.level = 0;
    this.bg = 0.002;
    this.lastHit = 0;
    this.enabled = false;
    this.src = null;
    this.an = null;
    this.buf = null;
    this.raf = 0;
  }

  attach(stream) {
    this.detach();
    const c = unlockAudio();
    if (!c || !stream.getAudioTracks().length) {
      log('마이크 소리를 쓸 수 없어요 (타구음 감지 꺼짐)', 'error');
      return false;
    }
    this.src = c.createMediaStreamSource(stream);
    this.an = c.createAnalyser();
    this.an.fftSize = 1024;
    this.buf = new Float32Array(this.an.fftSize);
    this.src.connect(this.an);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.an.getFloatTimeDomainData(this.buf);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < this.buf.length; i += 1) {
        const x = this.buf[i];
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / this.buf.length);
      const t = nowMs();
      if (this.enabled && peak >= this.threshold && rms > this.bg * 4 && t - this.lastHit > 500) {
        this.lastHit = t;
        this.onHit?.({ t, peak });
      }
      this.bg = this.bg * 0.97 + rms * 0.03;
      this.level = peak;
    };
    loop();
    return true;
  }

  detach() {
    cancelAnimationFrame(this.raf);
    try {
      this.src?.disconnect();
    } catch {
      /* 무시 */
    }
    this.src = null;
    this.an = null;
  }
}

// 불러온 영상 파일 안에서 가장 큰 '딱' 소리 시각 찾기 (초, 영상 기준)
export async function findHitInFile(file) {
  const c = audioCtx();
  if (!c || file.size > 250 * 1024 * 1024) return null;
  try {
    const buf = await file.arrayBuffer();
    const audio = await c.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const sr = audio.sampleRate;
    const win = Math.round(sr * 0.005); // 5ms 단위로 봐요
    let best = null;
    let bg = 1e-4;
    for (let i = 0; i + win < ch.length; i += win) {
      let peak = 0;
      let sum = 0;
      for (let j = i; j < i + win; j += 1) {
        const a = Math.abs(ch[j]);
        if (a > peak) peak = a;
        sum += ch[j] * ch[j];
      }
      const rms = Math.sqrt(sum / win);
      const jump = rms / bg;
      if (peak > 0.08 && jump > 6 && (!best || peak * Math.min(jump, 50) > best.score)) {
        best = { t: i / sr, peak, score: peak * Math.min(jump, 50) };
      }
      bg = bg * 0.98 + rms * 0.02;
    }
    if (best) log(`영상 속 타구음: ${best.t.toFixed(2)}초 (크기 ${best.peak.toFixed(2)})`);
    return best ? best.t : null;
  } catch (e) {
    log(`영상 소리를 읽지 못했어요 (${e.message || e})`);
    return null;
  }
}
