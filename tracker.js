// 공 추적 (측후방 영상, 임팩트 직후 보이는 구간만)
// 보이는 동안은 실제로 따라가고, 방향(좌·우 출발)을 구해요. 그 뒤는 계산으로 이어 그려요.
import { once, clamp, log } from './util.js';
import { LAUNCH } from './field.js';

const RW = 240; // 계산용으로 줄인 가로 크기

export function farPoint(hand) {
  return { x: hand === 'R' ? 0.74 : 0.26, y: 0.3 };
}

export async function trackBall(video, url, { impactT, ball, hand = 'R', club = '7I' } = {}) {
  if (!ball || !Number.isFinite(impactT)) return { ok: false, reason: '공 위치나 임팩트 시각이 없어요' };
  if (video.src !== url) {
    video.src = url;
    if (video.readyState < 1) await once(video, 'loadedmetadata', 8000);
  }
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { ok: false, reason: '영상 크기를 알 수 없어요' };
  const far = farPoint(hand);
  const x0 = clamp(Math.min(ball.x, far.x) - 0.2, 0, 1);
  const x1 = clamp(Math.max(ball.x, far.x) + 0.2, 0, 1);
  const y0 = clamp(far.y - 0.28, 0, 1);
  const y1 = clamp(ball.y + 0.04, 0, 1);
  const sx = x0 * vw;
  const sy = y0 * vh;
  const sw = Math.max(8, (x1 - x0) * vw);
  const sh = Math.max(8, (y1 - y0) * vh);
  const RH = Math.max(40, Math.round((RW * sh) / sw));
  const cv = document.createElement('canvas');
  cv.width = RW;
  cv.height = RH;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    g.drawImage(video, sx, sy, sw, sh, 0, 0, RW, RH);
    const d = g.getImageData(0, 0, RW, RH).data;
    const gray = new Uint8Array(RW * RH);
    for (let i = 0, j = 0; i < gray.length; i += 1, j += 4) gray[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return gray;
  };

  // 임팩트 직전부터 0.7초 뒤까지 한 장면씩 모아요 (느리게 재생)
  const frames = [];
  video.pause();
  video.muted = true;
  video.currentTime = Math.max(0, impactT - 0.12);
  await once(video, 'seeked', 3000);
  video.playbackRate = 0.25;
  await new Promise((resolve) => {
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      video.pause();
      resolve();
    };
    const safety = setTimeout(end, 6000);
    const onVF = (_n, meta) => {
      if (done) return;
      const mt = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : video.currentTime;
      try {
        if (!frames.length || mt > frames[frames.length - 1].t) frames.push({ t: mt, gray: grab() });
      } catch (e) {
        log(`공 추적용 화면을 읽지 못했어요 (${e.message})`, 'error');
        clearTimeout(safety);
        end();
        return;
      }
      if (mt > impactT + 0.7 || frames.length > 70 || video.ended) {
        clearTimeout(safety);
        end();
        return;
      }
      video.requestVideoFrameCallback(onVF);
    };
    video.requestVideoFrameCallback(onVF);
    video.play().catch(() => {
      clearTimeout(safety);
      end();
    });
  });
  video.playbackRate = 1;
  return findTrack(frames, { impactT, ball, far, box: { x0, x1, y0, y1 }, W: RW, H: RH, club });
}

// 화면 모음에서 공 궤적 찾기 (테스트하기 쉽게 따로 떼어 둠)
export function findTrack(frames, { impactT, ball, far, box, W, H, club }) {
  if (frames.length < 5) return { ok: false, reason: '장면이 부족해요' };
  let refIdx = -1;
  for (let i = 0; i < frames.length; i += 1) if (frames[i].t < impactT - 0.02) refIdx = i;
  if (refIdx < 0) refIdx = 0;
  const ref = frames[refIdx].gray;
  const toR = (p) => ({ x: ((p.x - box.x0) / (box.x1 - box.x0)) * W, y: ((p.y - box.y0) / (box.y1 - box.y0)) * H });
  const toN = (p) => ({ x: box.x0 + (p.x / W) * (box.x1 - box.x0), y: box.y0 + (p.y / H) * (box.y1 - box.y0) });
  const B = toR(ball);
  const F = toR(far);
  const refAng = Math.atan2(F.y - B.y, F.x - B.x);
  const cone = (35 * Math.PI) / 180;

  const cand = [];
  for (let k = refIdx + 1; k < frames.length; k += 1) {
    if (frames[k].t < impactT - 0.01) continue;
    const pts = blobs(frames[k].gray, ref, frames[k - 1].gray, W, H).filter((p) => {
      const dx = p.x - B.x;
      const dy = p.y - B.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 4) return false;
      let a = Math.atan2(dy, dx) - refAng;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      return Math.abs(a) < cone;
    });
    cand.push({ t: frames[k].t, pts });
  }

  // 시작 두 점: 공에서 멀어지고 방향이 같은 한 쌍
  let best = null;
  for (let i = 0; i < Math.min(5, cand.length - 1); i += 1) {
    for (const a of cand[i].pts) {
      for (const b of cand[i + 1].pts) {
        const da = Math.hypot(a.x - B.x, a.y - B.y);
        const db = Math.hypot(b.x - B.x, b.y - B.y);
        if (db <= da + 1) continue;
        const a1 = Math.atan2(a.y - B.y, a.x - B.x);
        const a2 = Math.atan2(b.y - a.y, b.x - a.x);
        let diff = a2 - a1;
        diff = Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff)));
        if (diff > (25 * Math.PI) / 180) continue;
        const score = diff * 10 - Math.min(a.area, 30) * 0.05;
        if (!best || score < best.score) best = { score, i, pts: [{ ...a, t: cand[i].t }, { ...b, t: cand[i + 1].t }] };
      }
    }
  }
  if (!best) return { ok: false, reason: '공을 찾지 못했어요' };
  const track = best.pts;
  let miss = 0;
  for (let k = best.i + 2; k < cand.length && miss < 2; k += 1) {
    const p1 = track[track.length - 1];
    const p0 = track[track.length - 2];
    const vx = p1.x - p0.x;
    const vy = p1.y - p0.y;
    const pred = { x: p1.x + vx * (miss + 1), y: p1.y + vy * (miss + 1) };
    const gate = Math.max(6, Math.hypot(vx, vy) * 0.7);
    let hit = null;
    let hd = gate;
    for (const c of cand[k].pts) {
      const dd = Math.hypot(c.x - pred.x, c.y - pred.y);
      if (dd < hd && Math.hypot(c.x - B.x, c.y - B.y) > Math.hypot(p1.x - B.x, p1.y - B.y)) {
        hd = dd;
        hit = c;
      }
    }
    if (hit) {
      track.push({ ...hit, t: cand[k].t });
      miss = 0;
    } else miss += 1;
  }
  if (track.length < 3) return { ok: false, reason: '공이 너무 짧게 보였어요' };
  const tail = track.slice(-2);
  const tx = (tail[0].x + tail[1].x) / 2 - B.x;
  const ty = (tail[0].y + tail[1].y) / 2 - B.y;
  let alpha = Math.atan2(ty, tx) - refAng;
  alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha));
  const theta = ((LAUNCH[club] || 16) * Math.PI) / 180;
  const phi = Math.atan(Math.tan(alpha) * Math.tan(theta));
  const alphaDeg = (alpha * 180) / Math.PI;
  const phiDeg = (phi * 180) / Math.PI;
  log(`공 추적: ${track.length}장면, 화면 기준 ${alphaDeg.toFixed(1)}°, 출발 방향 ${phiDeg > 0 ? '오른쪽' : '왼쪽'} ${Math.abs(phiDeg).toFixed(1)}°`);
  return { ok: true, pts: track.map((p) => ({ ...toN(p), t: p.t })), alphaDeg, phiDeg, n: track.length };
}

// 움직이는 작은 점(공 후보) 찾기
function blobs(cur, ref, prev, W, H) {
  const N = W * H;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i += 1) {
    const a = cur[i] - ref[i];
    const b = cur[i] - prev[i];
    if ((a > 26 || a < -26) && (b > 18 || b < -18)) mask[i] = 1;
  }
  const out = [];
  const stack = [];
  for (let i = 0; i < N; i += 1) {
    if (!mask[i]) continue;
    let area = 0;
    let sx = 0;
    let sy = 0;
    mask[i] = 0;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      const x = j % W;
      const y = (j / W) | 0;
      area += 1;
      sx += x;
      sy += y;
      if (area > 90) continue;
      if (x > 0 && mask[j - 1]) { mask[j - 1] = 0; stack.push(j - 1); }
      if (x < W - 1 && mask[j + 1]) { mask[j + 1] = 0; stack.push(j + 1); }
      if (y > 0 && mask[j - W]) { mask[j - W] = 0; stack.push(j - W); }
      if (y < H - 1 && mask[j + W]) { mask[j + W] = 0; stack.push(j + W); }
    }
    if (area >= 1 && area <= 60) out.push({ x: sx / area, y: sy / area, area });
  }
  return out.length > 40 ? [] : out; // 화면 전체가 흔들리면 믿지 않아요
}

// 볼꼬리 그리기: 실제로 본 구간 + 계산으로 이은 구간
export function drawTrackTracer(g, W, H, ball, hand, track, progress, scale = 1) {
  if (!ball || !track?.pts?.length) return;
  const far = farPoint(hand);
  const P = (p) => ({ x: p.x * W, y: p.y * H });
  const b = P(ball);
  const f = P(far);
  const a = (track.alphaDeg * Math.PI) / 180;
  const vx = f.x - b.x;
  const vy = f.y - b.y;
  const end = { x: b.x + (vx * Math.cos(a) - vy * Math.sin(a)) * 1.02, y: b.y + (vx * Math.sin(a) + vy * Math.cos(a)) * 1.02 };
  const pts = [b, ...track.pts.map(P)];
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const dirx = last.x - prev.x;
  const diry = last.y - prev.y;
  const dl = Math.hypot(dirx, diry) || 1;
  const rest = Math.hypot(end.x - last.x, end.y - last.y);
  const ctrl = { x: last.x + (dirx / dl) * rest * 0.7, y: last.y + (diry / dl) * rest * 0.7 - rest * 0.25 };
  const steps = 40;
  const curve = [];
  for (let i = 1; i <= steps; i += 1) {
    const u = i / steps;
    curve.push({
      x: (1 - u) * (1 - u) * last.x + 2 * (1 - u) * u * ctrl.x + u * u * end.x,
      y: (1 - u) * (1 - u) * last.y + 2 * (1 - u) * u * ctrl.y + u * u * end.y,
    });
  }
  const all = [...pts, ...curve];
  const upto = Math.max(2, Math.round(all.length * clamp(progress, 0, 1)));
  const realN = pts.length;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let pass = 0; pass < 2; pass += 1) {
    g.strokeStyle = pass === 0 ? 'rgba(210,40,60,0.45)' : '#FFFFFF';
    g.lineWidth = (pass === 0 ? 10 : 3.5) * scale;
    g.beginPath();
    for (let i = 0; i < upto; i += 1) {
      if (i === 0) g.moveTo(all[i].x, all[i].y);
      else g.lineTo(all[i].x, all[i].y);
    }
    g.stroke();
  }
  // 실제로 본 점들은 노란 점으로 표시
  g.fillStyle = '#F2B705';
  for (let i = 1; i < Math.min(realN, upto); i += 1) {
    g.beginPath();
    g.arc(pts[i].x, pts[i].y, 3 * scale, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

// 출발 방향(도) → 방향 버튼 이름
export function dirFromPhi(phi) {
  if (phi <= -7) return 'hookL';
  if (phi <= -2) return 'left';
  if (phi < 2) return 'straight';
  if (phi < 7) return 'right';
  return 'sliceR';
}
export const PHI_OF = { hookL: -10, left: -4, straight: 0, right: 4, sliceR: 10 };
