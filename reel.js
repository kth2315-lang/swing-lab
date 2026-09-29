// '오늘의 오잘공' 15초 릴스 만들기
import { log, once, sleep, nowMs } from './util.js';
import { frameAt } from './swing.js';
import { drawSkeleton } from './draw.js';
import { METRIC_ORDER, METRIC_LABEL } from './refs.js';
import { pickMime } from './camera.js';

const CW = 720;
const CH = 1280;

export async function makeReel({ host, video, clipUrl, analysis, info, onProgress }) {
  const canvas = document.createElement('canvas');
  canvas.width = CW;
  canvas.height = CH;
  canvas.style.cssText = 'width:150px;height:267px;border-radius:10px;background:#0E2718';
  host?.append(canvas);
  const g = canvas.getContext('2d');
  if (!canvas.captureStream) throw new Error('이 기기는 릴스 만들기를 지원하지 않아요.');
  const mime = pickMime();
  if (mime === null) throw new Error('이 기기는 녹화를 지원하지 않아요.');

  video.muted = true;
  video.playsInline = true;
  video.src = clipUrl;
  if (video.readyState < 1) await once(video, 'loadedmetadata', 10000);

  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();

  const ph = analysis.phases;
  const total = 15;
  let elapsed = 0;
  const tick = (sec) => {
    elapsed += sec;
    onProgress?.(Math.min(1, elapsed / total));
  };

  // 1) 제목 카드
  await holdCard(1.6, () => titleCard(g, info), tick);
  // 2) 실제 속도
  const a = Math.max(0, ph.take.t - 0.4);
  const b = ph.finish.t + 0.3;
  await playSegment(g, video, analysis, a, b, 1, '실제 속도', tick);
  // 3) 슬로모션 (톱 ~ 임팩트 직후를 약 7초로)
  const sa = Math.max(0, ph.top.t - 0.35);
  const sb = ph.impact.t + 0.45;
  const rate = Math.max(0.1, Math.min(0.5, (sb - sa) / 7));
  await playSegment(g, video, analysis, sa, sb, rate, `슬로모션 ×${rate.toFixed(2)}`, tick);
  // 4) 지표 카드
  await holdCard(Math.max(1.8, total - elapsed), () => statsCard(g, info), tick);

  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: rec.mimeType || mime || 'video/mp4' });
}

async function holdCard(sec, draw, tick) {
  const t0 = nowMs();
  while (nowMs() - t0 < sec * 1000) {
    draw();
    await sleep(33);
  }
  tick(sec);
}

async function playSegment(g, video, analysis, from, to, rate, label, tick) {
  video.pause();
  video.currentTime = from;
  await once(video, 'seeked', 4000);
  video.playbackRate = rate;
  const t0 = nowMs();
  try {
    await video.play();
  } catch (e) {
    log(`릴스 재생 실패: ${e.message}`, 'error');
    return;
  }
  const limit = ((to - from) / rate) * 1000 + 3000;
  while (video.currentTime < to && !video.ended && nowMs() - t0 < limit) {
    drawFrame(g, video, analysis, label);
    await new Promise((r) => requestAnimationFrame(r));
  }
  video.pause();
  video.playbackRate = 1;
  tick((nowMs() - t0) / 1000);
}

function drawFrame(g, video, analysis, label) {
  g.fillStyle = '#0E2718';
  g.fillRect(0, 0, CW, CH);
  const vw = video.videoWidth || analysis.vw;
  const vh = video.videoHeight || analysis.vh;
  const sc = Math.min(CW / vw, (CH - 200) / vh);
  const dw = vw * sc;
  const dh = vh * sc;
  const dx = (CW - dw) / 2;
  const dy = 120 + (CH - 200 - dh) / 2;
  try {
    g.drawImage(video, dx, dy, dw, dh);
  } catch {
    /* 첫 장면 준비 전 */
  }
  const f = frameAt(analysis.frames, video.currentTime);
  if (f) drawSkeleton(g, f.lms, { x: dx, y: dy, w: dw, h: dh }, { scale: 2 });
  g.fillStyle = '#fff';
  g.font = '700 40px -apple-system, "Apple SD Gothic Neo", sans-serif';
  g.textAlign = 'left';
  g.fillText('오늘의 오잘공', 40, 72);
  g.font = '500 30px -apple-system, "Apple SD Gothic Neo", sans-serif';
  g.fillStyle = '#F2B705';
  g.textAlign = 'right';
  g.fillText(label, CW - 40, 72);
}

function titleCard(g, info) {
  g.fillStyle = '#1D4A2E';
  g.fillRect(0, 0, CW, CH);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.font = '800 88px -apple-system, "Apple SD Gothic Neo", sans-serif';
  g.fillText('오늘의 오잘공', CW / 2, CH / 2 - 60);
  g.font = '500 38px -apple-system, "Apple SD Gothic Neo", sans-serif';
  g.fillText(`${info.date} · ${info.club}`, CW / 2, CH / 2 + 20);
  g.fillStyle = '#F2B705';
  g.font = '800 64px -apple-system, "Apple SD Gothic Neo", sans-serif';
  g.fillText(`${info.score}점`, CW / 2, CH / 2 + 120);
}

function statsCard(g, info) {
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, CW, CH);
  g.fillStyle = '#1A2740';
  g.textAlign = 'left';
  g.font = '800 54px -apple-system, "Apple SD Gothic Neo", sans-serif';
  g.fillText('스윙 리포트', 60, 170);
  g.font = '500 32px -apple-system, "Apple SD Gothic Neo", sans-serif';
  g.fillStyle = '#56685E';
  g.fillText(`${info.club} · ${info.date}`, 60, 225);
  let y = 330;
  const color = { good: '#2FA85A', warn: '#E0A100', bad: '#D2283C', na: '#B7C4BC' };
  for (const k of METRIC_ORDER) {
    const m = info.metrics[k];
    if (!m || m.grade === 'na') continue;
    g.fillStyle = color[m.grade];
    g.fillRect(60, y - 36, 12, 48);
    g.fillStyle = '#1A2740';
    g.font = '700 36px -apple-system, "Apple SD Gothic Neo", sans-serif';
    g.fillText(METRIC_LABEL[k], 96, y);
    g.textAlign = 'right';
    g.font = '600 36px -apple-system, "Apple SD Gothic Neo", sans-serif';
    g.fillText(m.text, CW - 60, y);
    g.textAlign = 'left';
    y += 92;
  }
  g.fillStyle = '#1D4A2E';
  g.font = '800 44px -apple-system, "Apple SD Gothic Neo", sans-serif';
  g.fillText(`점수 ${info.score}`, 60, CH - 120);
}

