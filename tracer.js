// 스윙 트레이서: 영상에서 클럽 헤드가 지나간 길 찾기 (폰 안에서만 계산해요)
import { log, once, clamp, nowMs } from './util.js';
import { getLandmarker, detect } from './pose.js';
import { analyzeSwing } from './swing.js';
import { createClubTracker, densify } from './clubtrack.js';

const WORK = 384; // 계산용으로 줄인 그림의 긴 변 (px)

// 영상 한 구간을 한 장면씩 돌려 가며 관절 + 작은 흑백 그림을 모아 클럽 헤드를 찾아요.
// video: 화면에 보이는 <video> (보여야 iOS가 장면을 넘겨줘요)
export async function traceVideo(video, url, { from = 0, to = null, hand = 'R', impactHint = null, maxFrames = 420, onProgress, onFrame, debug = null } = {}) {
  const lm = await getLandmarker('analysis');
  video.muted = true;
  video.playsInline = true;
  if (video.src !== url) video.src = url;
  if (video.readyState < 1 && !(await once(video, 'loadedmetadata', 15000))) throw new Error('영상을 열지 못했어요.');
  if (!Number.isFinite(video.duration)) {
    video.currentTime = 1e7;
    await once(video, 'durationchange', 3000);
  }
  const dur = Number.isFinite(video.duration) ? video.duration : to ?? 10;
  const end = clamp(to ?? dur, 0.2, dur);
  const start = clamp(from, 0, Math.max(0, end - 0.2));
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error('영상 크기를 알 수 없어요.');
  const sc = WORK / Math.max(vw, vh);
  const W = Math.max(32, Math.round(vw * sc));
  const H = Math.max(32, Math.round(vh * sc));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const tr = createClubTracker({ W, H, hand, debug });
  const poseFrames = [];
  const minStep = Math.max(0, (end - start) / maxFrames) * 0.9;

  video.currentTime = start;
  await once(video, 'seeked', 4000);
  // 첫 인식은 준비(컴파일)에 시간이 걸려요 → 멈춘 상태에서 미리 한 번 돌려 둬요
  try {
    detect(lm, video);
  } catch {
    /* 무시 */
  }
  let rate = 0.5;
  video.playbackRate = rate;
  const costs = [];
  let lastMt = -1;
  let fpsEst = 60;
  let count = 0;
  let skipped = 0;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.pause();
      resolve();
    };
    // 장면이 10초 넘게 안 넘어오면 멈춘 걸로 보고 끝내요
    let safety = setTimeout(finish, 15000);
    const onVF = (_now, meta) => {
      if (done) return;
      clearTimeout(safety);
      safety = setTimeout(finish, 10000);
      const mt = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : video.currentTime;
      if (mt > end || video.ended) {
        clearTimeout(safety);
        finish();
        return;
      }
      if (mt > lastMt + minStep) {
        if (lastMt >= 0 && mt - lastMt > 0.001) {
          const gap = mt - lastMt;
          if (fpsEst && gap > 1.6 / fpsEst && gap > minStep * 1.6) skipped += 1;
          fpsEst = fpsEst * 0.8 + Math.min(240, 1 / gap) * 0.2;
        }
        lastMt = mt;
        // 계산이 장면 간격보다 오래 걸리면 영상을 잠깐 세워서 장면을 하나도 놓치지 않게 해요
        const avgCost = costs.length ? costs.slice(-6).reduce((a, b) => a + b, 0) / Math.min(6, costs.length) : 50;
        const holdIt = avgCost > (1000 / (Math.max(fpsEst, 1) * rate)) * 0.6;
        if (holdIt) video.pause();
        const t0 = nowMs();
        let gray = null;
        try {
          g.drawImage(video, 0, 0, W, H);
          const d = g.getImageData(0, 0, W, H).data;
          gray = new Uint8Array(W * H);
          for (let i = 0, j = 0; i < gray.length; i += 1, j += 4) gray[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
        } catch (e) {
          log(`장면 읽기 오류: ${e.message || e}`, 'error');
        }
        let r = null;
        try {
          r = detect(lm, video);
        } catch (e) {
          log(`관절 인식 오류: ${e.message || e}`, 'error');
        }
        if (gray) tr.push(gray, r?.lms || null, mt);
        if (r) poseFrames.push({ t: mt, lms: r.lms, world: r.world });
        count += 1;
        onFrame?.({ t: mt, lms: r?.lms || null });
        costs.push(nowMs() - t0);
        onProgress?.(clamp((mt - start) / (end - start), 0, 1));
        if (costs.length % 8 === 0) {
          const avg = costs.slice(-8).reduce((a, b) => a + b, 0) / 8;
          const want = clamp(1000 / (Math.max(fpsEst, 1) * (avg + 12)), 0.25, 1);
          if (Math.abs(want - rate) > 0.04) {
            rate = want;
            video.playbackRate = rate;
          }
        }
        video.requestVideoFrameCallback(onVF);
        if (holdIt && !done) video.play().catch(() => finish());
        return;
      }
      video.requestVideoFrameCallback(onVF);
    };
    video.requestVideoFrameCallback(onVF);
    video.addEventListener('ended', finish, { once: true });
    video.play().catch((e) => {
      log(`트레이서 분석용 재생 실패: ${e.message}`, 'error');
      finish();
    });
  });
  video.playbackRate = 1;
  log(`트레이서: 장면 ${count}개(건너뜀 ${skipped}) · 관절 ${poseFrames.length}개 · 계산 ${W}×${H}`);

  const club = tr.finish();
  const swing = analyzeSwing(poseFrames, { view: 'face', hand, vw, vh, impactHint });
  const res = buildTrace({ club, swing, W, H, vw, vh, poseFrames, start, end });
  res.frames = count;
  res.skipped = skipped;
  return res;
}

// 클럽 길 + 스윙 구간 → 그리기용 자료 (0~1 좌표)
export function buildTrace({ club, swing, W, H, vw, vh, poseFrames, start = 0, end = null }) {
  const out = { ok: false, vw, vh, points: [], phases: null, quality: 0, mode: 'club', reason: '' };
  let pts = club?.ok ? club.points : [];
  let phases = swing?.ok ? { take: swing.phases.take.t, top: swing.phases.top.t, impact: swing.phases.impact.t, finish: swing.phases.finish.t } : null;
  if (!phases && pts.length > 8) phases = phasesFromPath(pts);
  if (!phases) {
    out.reason = '스윙 동작을 찾지 못했어요. 전신과 클럽이 다 나오게 찍어 주세요.';
    return out;
  }
  // 품질: 백스윙 시작 ~ 피니시 사이에서 클럽이 뚜렷이 보인 장면 비율
  const inSwing = pts.filter((p) => p.t >= phases.take && p.t <= phases.finish);
  const good = inSwing.filter((p) => p.conf >= 0.35).length;
  out.quality = inSwing.length ? good / inSwing.length : 0;
  if (out.quality < 0.3 && poseFrames?.length) {
    // 클럽이 잘 안 보이면 손이 지나간 길로 그려요
    out.mode = 'hands';
    pts = poseFrames
      .map((f) => {
        const l = f.lms;
        const ok = [15, 16].every((i) => (l[i]?.v ?? 1) >= 0.3);
        if (!ok) return null;
        return { t: f.t, a: 0, r: 0, px: 0, py: 0, hx: ((l[15].x + l[16].x) / 2) * W, hy: ((l[15].y + l[16].y) / 2) * H, conf: 1 };
      })
      .filter(Boolean);
  }
  const dense = out.mode === 'club' ? densify(pts) : pts;
  const t0 = phases.take - 0.25;
  const t1 = phases.finish + 0.35;
  out.points = dense
    .filter((p) => p.t >= t0 && p.t <= t1)
    .map((p) => ({ t: p.t, x: p.hx / W, y: p.hy / H, c: Math.round((p.conf ?? 1) * 100) / 100 }));
  // 속도 (화면 대각선 기준 초당) — 효과 세기에 써요
  const diag = Math.hypot(1, vh / vw);
  for (let i = 0; i < out.points.length; i += 1) {
    const a = out.points[Math.max(0, i - 1)];
    const b = out.points[Math.min(out.points.length - 1, i + 1)];
    const dt = b.t - a.t;
    out.points[i].v = dt > 0 ? Math.hypot((b.x - a.x), (b.y - a.y) * (vh / vw)) / diag / dt : 0;
  }
  out.phases = phases;
  out.ok = out.points.length >= 6;
  out.span = [start, end];
  if (!out.ok) out.reason = '클럽이 지나간 길을 찾지 못했어요.';
  return out;
}

// 관절로 구간을 못 찾았을 때: 헤드 속도로 대강 정해요
export function phasesFromPath(pts) {
  const sp = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dt = b.t - a.t;
    return dt > 0 ? Math.hypot(b.hx - a.hx, b.hy - a.hy) / dt : 0;
  });
  let iImp = 0;
  for (let i = 1; i < sp.length; i += 1) if (sp[i] > sp[iImp]) iImp = i;
  const peak = sp[iImp];
  if (!peak) return null;
  let iTake = iImp;
  while (iTake > 0 && sp[iTake] > peak * 0.05) iTake -= 1;
  let iTop = iTake;
  let minS = Infinity;
  for (let i = iTake + 1; i < iImp; i += 1) {
    if (pts[i].t > pts[iImp].t - 0.08) break;
    if (sp[i] < minS) {
      minS = sp[i];
      iTop = i;
    }
  }
  let iFin = iImp;
  while (iFin < sp.length - 1 && (sp[iFin] > peak * 0.06 || pts[iFin].t - pts[iImp].t < 0.3)) iFin += 1;
  return { take: pts[iTake].t, top: pts[iTop].t, impact: pts[iImp].t, finish: pts[iFin].t };
}
