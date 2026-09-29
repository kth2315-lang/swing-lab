// 관절 인식 엔진 (구글 MediaPipe, 모든 파일은 우리 주소에서만 불러와요)
import { log, once, clamp, nowMs } from './util.js';

const BASE = new URL('./', location.href).href.replace(/\/$/, '');
let visionMod = null;
let fileset = null;
let models = null; // { lite: bool, full: bool }
const cache = {}; // 'live' | 'analysis' → landmarker
const lastTs = new WeakMap();

export async function checkModels() {
  if (models) return models;
  const has = async (name) => {
    try {
      const r = await fetch(`${BASE}/${name}`, { method: 'HEAD', cache: 'no-store' });
      return r.ok;
    } catch {
      return false;
    }
  };
  const [lite, full] = await Promise.all([has('pose_landmarker_lite.task'), has('pose_landmarker_full.task')]);
  models = { lite, full };
  log(`관절 모델 확인: 가벼운 모델 ${lite ? '있음' : '없음'} · 정확한 모델 ${full ? '있음' : '없음'}`);
  return models;
}

async function vision() {
  if (!visionMod) visionMod = await import('./vision_bundle_esm.js');
  if (!fileset) fileset = await visionMod.FilesetResolver.forVisionTasks(BASE);
  return visionMod;
}

export function connections() {
  return visionMod?.PoseLandmarker?.POSE_CONNECTIONS || [];
}

async function create(modelName) {
  const { PoseLandmarker } = await vision();
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: `${BASE}/${modelName}`, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch (e) {
    log(`GPU 방식이 안 돼서 CPU로 바꿨어요 (${e.message || e})`);
    return PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

export async function getLandmarker(kind) {
  if (cache[kind]) return cache[kind];
  const m = await checkModels();
  if (!m.lite && !m.full) throw new Error('관절 인식 모델 파일(pose_landmarker_lite.task)이 없어요. 깃허브에 함께 올려 주세요.');
  const name = kind === 'analysis' && m.full ? 'pose_landmarker_full.task' : m.lite ? 'pose_landmarker_lite.task' : 'pose_landmarker_full.task';
  const t0 = nowMs();
  cache[kind] = create(name).then(
    (lm) => {
      log(`관절 인식 준비 완료 (${kind === 'live' ? '실시간' : '정밀 분석'}용, ${name}, ${((nowMs() - t0) / 1000).toFixed(1)}초)`);
      return lm;
    },
    (e) => {
      delete cache[kind];
      throw e;
    },
  );
  return cache[kind];
}

// 한 장면에서 관절 찾기. 타임스탬프는 모델마다 계속 커져야 해요.
export function detect(lm, source, t = nowMs()) {
  const prev = lastTs.get(lm) || 0;
  const ts = Math.max(Math.round(t), prev + 1);
  lastTs.set(lm, ts);
  const r = lm.detectForVideo(source, ts);
  const p = r?.landmarks?.[0];
  if (!p) return null;
  const w = r.worldLandmarks?.[0];
  return {
    lms: p.map((q) => ({ x: q.x, y: q.y, z: q.z, v: q.visibility ?? 1 })),
    world: w ? w.map((q) => ({ x: q.x, y: q.y, z: q.z })) : null,
  };
}

// 영상 한 구간을 한 장면씩 돌려 가며 관절을 모아요.
// video: 화면에 보이는 <video> (보여야 iOS가 장면을 넘겨줘요)
export async function analyzeVideo(video, url, { from = 0, to = null, slow = 1, onFrame, onProgress } = {}) {
  const lm = await getLandmarker('analysis');
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  if (video.readyState < 1 && !(await once(video, 'loadedmetadata', 15000))) throw new Error('영상을 열지 못했어요.');

  // 녹화 직후 파일은 길이를 모를 때가 있어요 → 끝으로 보내서 길이를 알아내요
  if (!Number.isFinite(video.duration)) {
    video.currentTime = 1e7;
    await once(video, 'durationchange', 3000);
  }
  const dur = Number.isFinite(video.duration) ? video.duration : to ?? 10;
  const end = clamp(to ?? dur, 0.2, dur);
  const start = clamp(from, 0, Math.max(0, end - 0.2));
  video.currentTime = start;
  await once(video, 'seeked', 4000);

  const frames = [];
  let rate = 0.5;
  const costs = [];
  let lastMt = -1;
  let fpsEst = 60;
  video.playbackRate = rate;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.pause();
      resolve();
    };
    const safety = setTimeout(finish, ((end - start) / 0.12) * 1000 + 15000);
    const onVF = (_now, meta) => {
      if (done) return;
      const mt = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : video.currentTime;
      if (mt > end || video.ended) {
        clearTimeout(safety);
        finish();
        return;
      }
      if (mt > lastMt) {
        if (lastMt >= 0 && mt - lastMt > 0.001) fpsEst = fpsEst * 0.8 + (1 / (mt - lastMt)) * 0.2;
        lastMt = mt;
        const t0 = nowMs();
        let r = null;
        try {
          r = detect(lm, video);
        } catch (e) {
          log(`분석 중 오류: ${e.message || e}`, 'error');
        }
        costs.push(nowMs() - t0);
        if (r) {
          const f = { t: mt / slow, lms: r.lms, world: r.world };
          frames.push(f);
          onFrame?.(f);
        }
        onProgress?.(clamp((mt - start) / (end - start), 0, 1));
        // 처리 속도에 맞춰 재생 속도를 조절해 장면을 놓치지 않게 해요
        if (costs.length % 8 === 0) {
          const avg = costs.slice(-8).reduce((a, b) => a + b, 0) / 8;
          const want = clamp(1000 / (Math.max(fpsEst, 1) * (avg + 10)), 0.12, 1);
          if (Math.abs(want - rate) > 0.05) {
            rate = want;
            video.playbackRate = rate;
          }
        }
      }
      video.requestVideoFrameCallback(onVF);
    };
    video.requestVideoFrameCallback(onVF);
    video.addEventListener('ended', finish, { once: true });
    video.play().catch((e) => {
      log(`분석용 재생 실패: ${e.message}`, 'error');
      finish();
    });
  });
  video.playbackRate = 1;
  return { frames, vw: video.videoWidth, vh: video.videoHeight, duration: dur };
}
