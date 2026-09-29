// 촬영 → 자동 클리핑 → 분석 → 리포트 → 다음 샷
import { $, esc, uid, log, toast, speak, setVoice, voiceEnabled, dateText, shareFile, median, once } from './util.js';
import { METRIC_ORDER, METRIC_LABEL, limits, coachingText, shotScore } from './refs.js';
import * as store from './store.js';
import { openCamera, stopStream, ClipRecorder } from './camera.js';
import { HitDetector, unlockAudio } from './sound.js';
import { getLandmarker, detect, analyzeVideo } from './pose.js';
import { analyzeSwing, keyframes, metricValues, frameAt } from './swing.js';
import { drawSkeleton, drawGuides, alignRef, drawTracer } from './draw.js';
import { makeReel } from './reel.js';
import { S, go, showModal, closeModal, confirmBox, requestWake, releaseWake, clubLabel, fitStage, dpr, saveSlots, saveProfile } from './core.js';
import { openClubPicker } from './screens.js';

let hit = null;

/* =================== 촬영 =================== */
export async function startCapture(opts) {
  unlockAudio();
  stopCaptureLoop();
  const C = {
    ...opts,
    state: 'starting',
    level: null,
    greenSince: 0,
    absentSince: 0,
    poseHist: [],
    lastPose: 0,
    lastLms: null,
    lm: null,
    rec: null,
    hitAt: null,
    raf: 0,
    short: !!(opts.wedge && opts.wedge <= 60),
  };
  S.capture = C;
  go('capture', { push: false });
  $('#capTitle').textContent = opts.mode === 'field' ? '필드 모드 · 측후방' : '스크린 모드 · 정면';
  $('#capSub').textContent = clubLabel(opts.club, opts.wedge);
  $('#capVoice').textContent = voiceEnabled() ? '🔊' : '🔇';
  $('#capHint').textContent = opts.mode === 'field' ? '폰을 공 뒤쪽(측후방)에 세워 주세요' : '폰을 정면에 세우고 2~3m 떨어져 주세요';
  setStatus(C, null, '카메라를 켜는 중…');
  setManual(C);

  try {
    if (!S.cam || S.cam.track.readyState !== 'live') S.cam = await openCamera({ fps: S.profile.fps });
  } catch (e) {
    log(`카메라 오류: ${e.name} ${e.message}`, 'error');
    setStatus(C, 'red', e.name === 'NotAllowedError' ? '카메라·마이크 허용이 필요해요' : '카메라를 켜지 못했어요');
    toast(
      e.name === 'NotAllowedError'
        ? '카메라와 마이크를 허용해야 촬영할 수 있어요. 앱을 닫았다가 다시 열어 허용해 주세요.'
        : `카메라를 켜지 못했어요 (${e.name})`,
      6000,
    );
    return;
  }
  if (C !== S.capture) return;
  const v = $('#camVideo');
  v.srcObject = S.cam.stream;
  await v.play().catch(() => {});
  if (v.readyState < 1) await once(v, 'loadedmetadata', 4000);
  layoutCapture();
  requestWake();

  if (!hit) hit = new HitDetector({ onHit });
  hit.threshold = S.profile.threshold;
  hit.attach(S.cam.stream);
  hit.enabled = true;
  $('#capThr').style.left = `${hit.threshold * 100}%`;

  C.state = opts.view === 'dtl' && !C.ball ? 'ball' : 'position';
  if (C.state === 'ball') {
    setStatus(C, 'yellow', '화면에서 공 위치를 눌러 주세요');
    speak('화면에서 공 위치를 눌러 주세요');
  } else {
    setStatus(C, null, '관절 인식을 준비하는 중…');
  }
  setManual(C);
  getLandmarker('live')
    .then((lm) => {
      if (C !== S.capture) return;
      C.lm = lm;
      if (C.state === 'position') setStatus(C, null, '자리를 잡아 주세요');
    })
    .catch((e) => {
      if (C !== S.capture) return;
      setStatus(C, 'red', '관절 인식을 켜지 못했어요');
      toast(e.message, 7000);
      log(e.message, 'error');
    });
  loop(C);
}

function layoutCapture() {
  fitStage($('#camStage'), $('#camVideo'), $('#camCanvas'), window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', () => {
  if (S.screen === 'capture') layoutCapture();
});
$('#camVideo').addEventListener('resize', () => {
  if (S.screen === 'capture') layoutCapture();
});

function loop(C) {
  const v = $('#camVideo');
  const cv = $('#camCanvas');
  const g = cv.getContext('2d');
  const step = (now) => {
    if (C !== S.capture || C.state === 'done') return;
    C.raf = requestAnimationFrame(step);
    if (C.lm && v.readyState >= 2 && now - C.lastPose >= 66 && ['position', 'armed', 'post'].includes(C.state)) {
      C.lastPose = now;
      let r = null;
      try {
        r = detect(C.lm, v, now);
      } catch (e) {
        log(`실시간 인식 오류: ${e.message || e}`, 'error');
      }
      C.lastLms = r ? r.lms : null;
      remember(C, now, r);
      if (C.state === 'position' || C.state === 'armed') evaluate(C, now);
    }
    g.clearRect(0, 0, cv.width, cv.height);
    const k = dpr();
    drawGuides(g, cv.width, cv.height, { view: C.view, hand: S.profile.hand, ball: C.ball, level: C.level, scale: k, fast: C.fast });
    if (C.lastLms) drawSkeleton(g, C.lastLms, { x: 0, y: 0, w: cv.width, h: cv.height }, { scale: k * 0.8, color: 'rgba(255,255,255,0.85)' });
    if (hit) $('#capMeter').style.width = `${Math.min(1, hit.level) * 100}%`;
  };
  C.raf = requestAnimationFrame(step);
}

function remember(C, now, r) {
  const l = r?.lms;
  if (l) {
    const hands = { x: (l[15].x + l[16].x) / 2, y: (l[15].y + l[16].y) / 2 };
    const sx = (l[11].x + l[12].x) / 2;
    const sy = (l[11].y + l[12].y) / 2;
    const hx = (l[23].x + l[24].x) / 2;
    const hy = (l[23].y + l[24].y) / 2;
    C.poseHist.push({ t: now, hands, torso: Math.hypot(sx - hx, sy - hy) || 0.2 });
  }
  while (C.poseHist.length && now - C.poseHist[0].t > 4000) C.poseHist.shift();
}

export function evalPosition(l, view, hand, fast) {
  const ok = (i) => (l[i]?.v ?? 0) >= 0.5;
  if (![0, 11, 12, 23, 24].every(ok)) return { level: 'red', msg: '몸이 다 안 보여요', say: '전신이 화면에 나오게 서 주세요' };
  const feet = [27, 28, 29, 30].filter(ok);
  if (!feet.length) return { level: 'red', msg: '발이 안 보여요 · 조금 뒤로', say: '발이 보이게 조금 뒤로 가 주세요' };
  const top = l[0].y - 0.07;
  const foot = Math.max(...feet.map((i) => l[i].y));
  const h = foot - top;
  if (top < 0.01 || foot > 0.985 || h > 0.9) return { level: 'red', msg: '너무 가까워요 · 뒤로 조금', say: '너무 가까워요. 뒤로 조금 가 주세요' };
  if (h < 0.38) return { level: 'yellow', msg: '너무 멀어요 · 앞으로 조금', say: '조금 앞으로 와 주세요' };
  if (fast) return { level: 'green', msg: '준비 완료' };
  if (foot < 0.82) return { level: 'yellow', msg: '조금 앞으로 · 발을 노란 선에', say: '조금 앞으로 와서 발을 노란 선에 맞춰 주세요' };
  if (foot > 0.94) return { level: 'yellow', msg: '조금 뒤로 · 발을 노란 선에', say: '조금 뒤로 가서 발을 노란 선에 맞춰 주세요' };
  const hipX = (l[23].x + l[24].x) / 2;
  const want = view === 'face' ? 0.5 : hand === 'R' ? 0.33 : 0.67;
  if (Math.abs(hipX - want) > 0.1) return { level: 'yellow', msg: '실루엣 위치에 맞춰 서 주세요', say: '흰색 실루엣 위치에 맞춰 서 주세요' };
  return { level: 'green', msg: '준비 완료' };
}

function still(C, now) {
  const w = C.poseHist.filter((p) => now - p.t <= 700);
  if (w.length < 4) return false;
  const tor = median(w.map((p) => p.torso)) || 0.2;
  const xs = w.map((p) => p.hands.x);
  const ys = w.map((p) => p.hands.y);
  const range = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return range / tor < 0.15;
}

function evaluate(C, now) {
  const res = C.lastLms ? evalPosition(C.lastLms, C.view, S.profile.hand, C.fast) : { level: 'red', msg: '사람이 안 보여요', say: '전신이 화면에 나오게 서 주세요' };
  if (C.state === 'position') {
    setStatus(C, res.level, res.msg);
    if (res.level !== 'green' && res.say) speak(res.say);
    if (res.level === 'green') {
      if (!C.greenSince) C.greenSince = now;
      if (now - C.greenSince >= 800 && still(C, now)) arm(C);
    } else {
      C.greenSince = 0;
    }
  } else if (C.state === 'armed') {
    if (!C.lastLms) {
      if (!C.absentSince) C.absentSince = now;
      if (now - C.absentSince > 5000) disarm(C, '자리를 비워서 녹화를 멈췄어요');
    } else {
      C.absentSince = 0;
    }
    if (C.rec && now - C.rec.startedAt > 30000 && still(C, now)) {
      C.rec.cancel();
      C.rec.start();
      log('30초 동안 샷이 없어 녹화를 새로 시작했어요');
    }
  }
}

function arm(C) {
  try {
    C.rec = new ClipRecorder(S.cam.stream);
    C.rec.start();
  } catch (e) {
    setStatus(C, 'red', '녹화를 시작하지 못했어요');
    log(e.message, 'error');
    return;
  }
  C.state = 'armed';
  C.absentSince = 0;
  setStatus(C, 'green', '준비 완료 · 스윙하세요');
  speak('준비 완료. 스윙하세요.', { force: true });
  setManual(C);
}

function disarm(C, msg) {
  C.rec?.cancel();
  C.rec = null;
  C.state = 'position';
  C.greenSince = 0;
  setStatus(C, 'yellow', msg);
  setManual(C);
}

function onHit({ t, peak }) {
  const C = S.capture;
  if (!C || C.state !== 'armed' || !C.rec) return;
  const w = C.poseHist.filter((p) => p.t >= t - 1600 && p.t <= t + 150);
  let ok = true;
  if (w.length >= 5) {
    const ys = w.map((p) => p.hands.y / p.torso);
    const range = Math.max(...ys) - Math.min(...ys);
    ok = range >= (C.short ? 0.2 : 0.45);
    log(`소리 감지 (크기 ${peak.toFixed(2)}) · 손 움직임 ${range.toFixed(2)} → ${ok ? '내 샷으로 인정' : '주변 소리로 보고 무시'}`);
  } else {
    log(`소리 감지 (크기 ${peak.toFixed(2)}) · 관절 정보가 부족해 소리만으로 인정`);
  }
  if (!ok) return;
  C.state = 'post';
  C.hitAt = t;
  setStatus(C, 'green', '타구 감지! 마무리 녹화 중…');
  setManual(C);
  setTimeout(() => finishCapture(C), 3000);
}

async function finishCapture(C, { manual = false } = {}) {
  if (C !== S.capture || !C.rec) return;
  C.state = 'done';
  cancelAnimationFrame(C.raf);
  if (hit) hit.enabled = false;
  const res = await C.rec.stop();
  C.rec = null;
  if (!res || !res.blob.size) {
    toast('녹화된 영상이 없어요. 다시 준비할게요.');
    startCapture(baseOpts(C));
    return;
  }
  const impactHint = !manual && C.hitAt ? (C.hitAt - res.startedAt) / 1000 : null;
  await runAnalysis({
    blob: res.blob,
    mime: res.mime,
    impactHint,
    clipSeconds: res.seconds,
    view: C.view,
    club: C.club,
    wedge: C.wedge,
    mode: C.mode,
    ball: C.ball,
    capture: baseOpts(C),
  });
}

function baseOpts(C) {
  return { mode: C.mode, view: C.view, club: C.club, wedge: C.wedge, fast: C.fast, ball: C.ball, fieldShot: C.fieldShot, onReport: C.onReport, onTracer: C.onTracer, onCancel: C.onCancel };
}

function setStatus(C, level, msg) {
  C.level = level;
  const el = $('#capStatus');
  el.className = `cam-status ${level || ''}`;
  el.querySelector('span').textContent = msg;
}

function setManual(C) {
  const b = $('#capManual');
  if (C.state === 'armed') {
    b.textContent = '방금 친 샷 분석하기';
    b.disabled = false;
  } else if (C.state === 'post' || C.state === 'done') {
    b.textContent = '분석 준비 중…';
    b.disabled = true;
  } else {
    b.textContent = '수동으로 녹화 시작';
    b.disabled = C.state !== 'position';
  }
}

$('#capManual').addEventListener('click', () => {
  const C = S.capture;
  if (!C) return;
  if (C.state === 'position') arm(C);
  else if (C.state === 'armed') {
    C.state = 'post';
    setManual(C);
    finishCapture(C, { manual: true });
  }
});
$('#capVoice').addEventListener('click', () => {
  setVoice(!voiceEnabled());
  S.profile.voice = voiceEnabled();
  saveProfile();
  $('#capVoice').textContent = voiceEnabled() ? '🔊' : '🔇';
});
$('#capBack').addEventListener('click', async () => {
  const C = S.capture;
  if (!C) {
    go('home', { push: false });
    return;
  }
  if (C.mode === 'field') {
    stopCaptureLoop();
    closeCamera();
    C.onCancel?.();
    return;
  }
  const ok = await confirmBox({ title: '연습을 끝낼까요?', text: '지금까지 분석한 샷은 기록에 남아요.', ok: '연습 끝내기', cancel: '계속하기' });
  if (ok) endScreenSession();
});
$('#camStage').addEventListener('click', (e) => {
  const C = S.capture;
  if (!C || C.view !== 'dtl' || !['ball', 'position'].includes(C.state)) return;
  const r = $('#camStage').getBoundingClientRect();
  C.ball = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  if (C.state === 'ball') {
    C.state = 'position';
    setStatus(C, null, '좋아요. 이제 자리를 잡아 주세요');
    speak('좋아요. 이제 자리를 잡아 주세요', { force: true });
    setManual(C);
  }
});

export function stopCaptureLoop() {
  const C = S.capture;
  if (C) {
    cancelAnimationFrame(C.raf);
    C.rec?.cancel();
    C.state = 'done';
  }
  S.capture = null;
  if (hit) hit.enabled = false;
}
export function closeCamera() {
  hit?.detach();
  if (S.cam) stopStream(S.cam.stream);
  S.cam = null;
  $('#camVideo').srcObject = null;
  releaseWake();
}

// 다른 앱에 갔다 오면 카메라가 멈춰 있어요 → 같은 조건으로 다시 켜요
export function captureVisible() {
  if (S.screen !== 'capture' || !S.capture) return;
  const C = S.capture;
  requestWake();
  if (!S.cam || S.cam.track.readyState !== 'live' || S.cam.track.muted) {
    log('앱으로 돌아와서 카메라를 다시 켜요');
    const o = baseOpts(C);
    stopCaptureLoop();
    if (S.cam) stopStream(S.cam.stream);
    S.cam = null;
    startCapture(o);
  }
}

/* =================== 분석 =================== */
export async function runAnalysis(p) {
  go('analyze', { push: false });
  const bar = $('#anBar');
  bar.style.width = '0%';
  $('#anText').textContent = '스윙을 한 장면씩 분석하는 중…';
  const url = p.url || URL.createObjectURL(p.blob);
  const v = $('#anVideo');
  const cv = $('#anCanvas');
  const g = cv.getContext('2d');
  const sizeIt = () => fitStage($('#anStage'), v, cv, Math.min(window.innerWidth - 40, 420), window.innerHeight * 0.6);
  v.onloadedmetadata = sizeIt;

  let from = p.from ?? null;
  let to = p.to ?? null;
  if (from == null && to == null) {
    if (p.impactHint != null) {
      from = Math.max(0, p.impactHint - 2.4);
      to = p.impactHint + 1.4;
    } else if (p.clipSeconds) {
      from = Math.max(0, p.clipSeconds - 7);
    }
  }
  let out;
  try {
    out = await analyzeVideo(v, url, {
      from: from ?? 0,
      to,
      slow: p.slow || 1,
      onProgress: (x) => { bar.style.width = `${Math.round(x * 100)}%`; },
      onFrame: (f) => {
        if (!cv.width) sizeIt();
        g.clearRect(0, 0, cv.width, cv.height);
        drawSkeleton(g, f.lms, { x: 0, y: 0, w: cv.width, h: cv.height }, { scale: dpr() });
      },
    });
  } catch (e) {
    log(`분석 실패: ${e.message || e}`, 'error');
    analysisFailed(p, e.message || String(e));
    return;
  }
  $('#anText').textContent = '지표를 계산하는 중…';
  const analysis = analyzeSwing(out.frames, {
    view: p.view,
    hand: S.profile.hand,
    vw: out.vw,
    vh: out.vh,
    impactHint: p.impactHint,
    short: !!(p.wedge && p.wedge <= 60),
  });
  log(`분석 완료: 장면 ${out.frames.length}개 · ${analysis.ok ? '성공' : analysis.reason}`);
  const shot = {
    id: uid(),
    at: Date.now(),
    sessionId: S.session?.id,
    club: p.club,
    wedge: p.wedge || null,
    view: p.view,
    mode: p.mode,
    blob: p.blob,
    mime: p.mime || p.blob?.type || 'video/mp4',
    url,
    analysis,
    metrics: analysis.metrics,
    tag: null,
    saved: false,
    discarded: false,
    ball: p.ball || null,
    slow: p.slow || 1,
    tracer: null,
    capture: p.capture || null,
    fieldShot: p.capture?.fieldShot || null,
  };
  shot.score = analysis.ok ? shotScore(shot.metrics, null) : 0;
  await noteShot(shot);
  openReport(shot);
}

function analysisFailed(p, msg) {
  showModal(
    `<h3>분석하지 못했어요</h3><p>${esc(msg)}</p><div class="stack"><button class="btn primary" data-a="retry">${p.mode === 'import' ? '다른 영상 고르기' : '다시 찍기'}</button><button class="btn ghost" data-a="home">처음으로</button></div>`,
    (c) => {
      c.querySelector('[data-a=retry]').onclick = () => {
        closeModal();
        if (p.mode === 'import') go('import', { push: false });
        else startCapture(p.capture);
      };
      c.querySelector('[data-a=home]').onclick = () => {
        closeModal();
        leaveFlow();
      };
    },
    { lock: true },
  );
}

/* =================== 세션·오잘공 후보 =================== */
export async function newSession(type, extra = {}) {
  if (S.best && S.best.url) URL.revokeObjectURL(S.best.url);
  S.best = null;
  S.session = { id: uid(), type, startedAt: Date.now(), status: 'active', shots: [], ...extra };
  await saveSession();
  return S.session;
}
export async function saveSession() {
  if (!S.session) return;
  try {
    await store.put('sessions', S.session);
  } catch (e) {
    log(`기록 저장 실패: ${e.message}`, 'error');
  }
}
function shotRecord(shot) {
  return {
    id: shot.id,
    at: shot.at,
    club: shot.club,
    wedge: shot.wedge,
    view: shot.view,
    mode: shot.mode,
    score: shot.score,
    tag: shot.tag,
    ok: !!shot.analysis.ok,
    metrics: metricValues(shot.metrics),
    kf: shot.analysis.ok ? keyframes(shot.analysis) : null,
    fieldShotId: shot.fieldShot?.id || null,
  };
}
async function noteShot(shot) {
  const s = S.session;
  if (!s) return;
  const rec = shotRecord(shot);
  s.shots = s.shots || [];
  const i = s.shots.findIndex((x) => x.id === shot.id);
  if (i >= 0) s.shots[i] = rec;
  else s.shots.push(rec);
  const isBetter = shot.analysis.ok && shot.blob && (!S.best || S.best.sessionId !== s.id || S.best.shotId === shot.id || shot.score > S.best.score);
  if (isBetter) {
    if (S.best && S.best.shotId !== shot.id && S.best.url && S.best.url !== S.shot?.url) URL.revokeObjectURL(S.best.url);
    const a = shot.analysis;
    S.best = {
      sessionId: s.id,
      shotId: shot.id,
      score: shot.score,
      blob: shot.blob,
      url: shot.url,
      analysis: { frames: a.frames, phases: a.phases, vw: a.vw, vh: a.vh, view: a.view, hand: a.hand },
      info: { date: dateText(shot.at), club: clubLabel(shot.club, shot.wedge), score: shot.score, metrics: metricValues(shot.metrics) },
    };
    s.bestId = shot.id;
    store.put('clips', { id: s.id, shotId: shot.id, blob: shot.blob, analysis: S.best.analysis, info: S.best.info }).catch((e) => log(`후보 영상 보관 실패: ${e.message}`));
  }
  await saveSession();
}
function releaseShot(shot) {
  if (!shot) return;
  if (S.best?.shotId !== shot.id && shot.url && shot.mode !== 'import') URL.revokeObjectURL(shot.url);
  if (S.best?.shotId !== shot.id) shot.blob = null;
}

/* =================== 리포트 =================== */
const R = { compare: 'tour', phase: null, rate: 0.25, bestRef: null };

export function openReport(shot) {
  S.shot = shot;
  R.compare = 'tour';
  R.phase = null;
  R.bestRef = null;
  go('report', { push: false });
  $('#repTitle').textContent = `${clubLabel(shot.club, shot.wedge)} · ${shot.view === 'face' ? '정면' : '측후방'}`;
  updateScoreLabel(shot);
  const warn = !shot.analysis.ok ? shot.analysis.reason : shot.analysis.warning;
  $('#repWarn').hidden = !warn;
  $('#repWarn').textContent = warn || '';
  setupPlayer(shot);
  renderCompareChips(shot);
  renderMetrics(shot);
  renderCoach(shot);
  $$chips('#repTag', 'tag', shot.tag);
  $('#repTracer').hidden = shot.mode !== 'field';
  if (shot.mode === 'field') {
    $$chips('#trDir', 'dir', shot.tracer?.dir);
    $$chips('#trLen', 'len', shot.tracer?.len);
  }
  $('#repSave').disabled = !shot.blob;
  $('#repSave').textContent = shot.saved ? '저장했어요' : '사진 앱에 저장';
  $('#repDiscard').disabled = !shot.blob || shot.discarded;
  renderNext(shot);
  loadBestRef(shot);
}

function $$chips(sel, key, current) {
  document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset[key] === current));
}
function updateScoreLabel(shot) {
  $('#repScore').textContent = shot.analysis.ok ? `${shot.score}점` : '';
}

function setupPlayer(shot) {
  const v = $('#plVideo');
  const cv = $('#plCanvas');
  v.pause();
  v.muted = true;
  v.src = shot.url;
  const size = () => {
    fitStage($('#plStage'), v, cv, Math.min(window.innerWidth, 560), window.innerHeight * 0.5);
    drawReport();
  };
  v.onloadedmetadata = () => {
    size();
    const ph = shot.analysis.phases;
    if (ph) v.currentTime = Math.max(0, (ph.take.t - 0.3) * (shot.slow || 1));
  };
  v.onseeked = drawReport;
  v.onpause = () => {
    $('#plPlay').textContent = '재생';
    drawReport();
  };
  v.onplay = () => {
    $('#plPlay').textContent = '일시정지';
    tickPlayer();
  };
  document.querySelectorAll('#plSpeed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) === R.rate));
  document.querySelectorAll('#plPhase button').forEach((b) => b.classList.remove('on'));
}
function tickPlayer() {
  const v = $('#plVideo');
  const hasVF = 'requestVideoFrameCallback' in v;
  const cb = () => {
    if (v.paused || S.screen !== 'report') return;
    const ph = S.shot?.analysis?.phases;
    const k = S.shot?.slow || 1;
    if (ph && v.currentTime >= (ph.finish.t + 0.4) * k) v.currentTime = Math.max(0, (ph.take.t - 0.3) * k);
    drawReport();
    if (hasVF) v.requestVideoFrameCallback(cb);
    else requestAnimationFrame(cb);
  };
  if (hasVF) v.requestVideoFrameCallback(cb);
  else requestAnimationFrame(cb);
}
function drawReport() {
  const shot = S.shot;
  if (!shot) return;
  const v = $('#plVideo');
  const cv = $('#plCanvas');
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const a = shot.analysis;
  if (!a?.frames?.length) return;
  const rect = { x: 0, y: 0, w: cv.width, h: cv.height };
  if (v.paused && R.phase && a.ok) {
    const ref = refFor(R.compare);
    const kf = ref?.keyframes;
    if (kf && kf.view === shot.view && kf[R.phase]) {
      const mine = a.frames[a.phases[R.phase].i].lms;
      const al = alignRef(kf[R.phase], { w: kf.vw, h: kf.vh }, mine, { w: a.vw, h: a.vh }, kf.hand !== a.hand);
      if (al) drawSkeleton(g, al, rect, { color: 'rgba(80,190,255,0.95)', joint: '#50BEFF', scale: dpr(), dash: [6, 5] });
    }
  }
  const tt = v.currentTime / (shot.slow || 1);
  const f = frameAt(a.frames, tt);
  if (f) drawSkeleton(g, f.lms, rect, { scale: dpr() });
  if (shot.tracer && shot.ball && a.ok) {
    const prog = v.paused && R.phase === 'finish' ? 1 : (tt - a.phases.impact.t) / 1.4;
    if (prog > 0) drawTracer(g, cv.width, cv.height, shot.ball, shot.tracer.dir, prog, dpr());
  }
}

document.querySelectorAll('#plSpeed button').forEach((b) => {
  b.addEventListener('click', () => {
    R.rate = Number(b.dataset.rate);
    $('#plVideo').playbackRate = R.rate;
    document.querySelectorAll('#plSpeed button').forEach((x) => x.classList.toggle('on', x === b));
  });
});
document.querySelectorAll('#plPhase button').forEach((b) => {
  b.addEventListener('click', () => {
    const shot = S.shot;
    const ph = shot?.analysis?.phases?.[b.dataset.ph];
    if (!ph) {
      toast('스윙 구간을 찾지 못해 이동할 수 없어요');
      return;
    }
    const v = $('#plVideo');
    v.pause();
    R.phase = b.dataset.ph;
    v.currentTime = ph.t * (shot.slow || 1);
    document.querySelectorAll('#plPhase button').forEach((x) => x.classList.toggle('on', x === b));
  });
});
$('#plPlay').addEventListener('click', () => {
  const v = $('#plVideo');
  const ph = S.shot?.analysis?.phases;
  const k = S.shot?.slow || 1;
  if (v.paused) {
    R.phase = null;
    document.querySelectorAll('#plPhase button').forEach((x) => x.classList.remove('on'));
    if (ph && (v.currentTime < (ph.take.t - 0.4) * k || v.currentTime > (ph.finish.t + 0.35) * k)) v.currentTime = Math.max(0, (ph.take.t - 0.3) * k);
    v.playbackRate = R.rate;
    v.play().catch(() => {});
  } else {
    v.pause();
  }
});

// 비교 기준: 투어 범위 / 내 베스트 / 1~10번 칸
function refFor(key) {
  if (key === 'best') return R.bestRef;
  if (key && key.startsWith('slot')) {
    const s = S.slots[Number(key.slice(4))];
    return s?.data ? { name: s.name, metrics: s.data.metrics, keyframes: s.data.keyframes } : null;
  }
  return null;
}
function renderCompareChips(shot) {
  const items = [
    { key: 'tour', name: '투어 범위' },
    { key: 'best', name: '내 베스트', empty: !R.bestRef },
    ...S.slots.map((s, i) => ({ key: `slot${i}`, name: `${i + 1}. ${s.name}`, empty: !s.data })),
  ];
  const box = $('#repCompare');
  box.innerHTML = items.map((it) => `<button data-k="${it.key}" class="${R.compare === it.key ? 'on' : ''} ${it.empty ? 'empty' : ''}">${esc(it.name)}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.k;
      if (k !== 'tour' && !refFor(k)) {
        toast(k === 'best' ? '같은 클럽·구도의 이전 기록이 아직 없어요' : '비어 있는 칸이에요. 영상 불러오기에서 기준 스윙을 저장하면 채워져요');
        return;
      }
      R.compare = k;
      renderCompareChips(shot);
      renderMetrics(shot);
      renderCoach(shot);
      drawReport();
    };
  });
}
async function loadBestRef(shot) {
  let best = null;
  try {
    const sessions = await store.all('sessions');
    for (const s of sessions) {
      for (const r of s.shots || []) {
        if (r.id === shot.id || !r.ok || r.club !== shot.club || r.view !== shot.view) continue;
        if (!best || r.score > best.score) best = r;
      }
    }
  } catch {
    /* 기록이 없으면 넘어가요 */
  }
  if (S.shot !== shot) return;
  R.bestRef = best ? { name: `내 베스트(${dateText(best.at)})`, metrics: best.metrics, keyframes: best.kf || null } : null;
  renderCompareChips(shot);
}

const UNIT = { tempo: '', sway: 'cm', spine: '°', reversePivot: '°', arc: '%', chickenWing: '°', head: 'cm' };
function deltaText(k, d) {
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return `기준 대비 ${sign}${Math.abs(d).toFixed(1)}${UNIT[k] || ''}`;
}
function targetText(k, short) {
  if (k === 'head') return '목표 좌우 8cm · 상하 5cm 이내';
  const L = limits(k, { short });
  return L ? `목표 ${L.text}` : '';
}
function renderMetrics(shot) {
  const ref = R.compare === 'tour' ? null : refFor(R.compare);
  const short = !!(shot.wedge && shot.wedge <= 60);
  const word = { good: '좋아요', warn: '조금 아쉬워요', bad: '고쳐 봐요', na: '' };
  $('#repMetrics').innerHTML = METRIC_ORDER.map((k) => {
    const m = shot.metrics[k] || { grade: 'na', text: '–' };
    let right = '';
    if (m.grade !== 'na') {
      if (!ref) right = targetText(k, short);
      else {
        const rv = ref.metrics?.[k]?.value;
        right = Number.isFinite(rv) && Number.isFinite(m.value) ? deltaText(k, m.value - rv) : '기준 값 없음';
      }
    }
    const sub = m.detail || word[m.grade] || '';
    return `<div class="metric ${m.grade}"><i class="bar-g"></i><div><b>${METRIC_LABEL[k]}</b><small>${esc(sub)}</small></div><div class="val">${esc(m.text)}<small>${esc(right)}</small></div></div>`;
  }).join('');
}
function renderCoach(shot) {
  if (!shot.analysis.ok) {
    $('#repCoach').innerHTML = `<b>분석 결과가 없어요</b><p>${esc(shot.analysis.reason || '')}</p>`;
    return;
  }
  const c = coachingText(shot.metrics, S.profile.hand);
  let cmp = '';
  const ref = R.compare === 'tour' ? null : refFor(R.compare);
  if (ref) {
    const scale = { tempo: 0.5, sway: 4, spine: 4, reversePivot: 4, arc: 6, chickenWing: 12, head: 4 };
    let top = null;
    for (const k of Object.keys(scale)) {
      const a = shot.metrics[k]?.value;
      const b = ref.metrics?.[k]?.value;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const z = Math.abs(a - b) / scale[k];
      if (!top || z > top.z) top = { k, d: a - b, z };
    }
    cmp = top
      ? `<div class="cmp">비교 기준 [${esc(ref.name)}] · 가장 큰 차이는 ${METRIC_LABEL[top.k]} (${deltaText(top.k, top.d)})</div>`
      : `<div class="cmp">비교 기준 [${esc(ref.name)}] · 같이 잴 수 있는 지표가 없어요 (구도가 다를 수 있어요)</div>`;
  }
  $('#repCoach').innerHTML = `<b>${esc(c.title)}</b><p>${esc(c.body)}</p>${cmp}`;
}

document.querySelectorAll('#repTag button').forEach((b) => {
  b.addEventListener('click', async () => {
    const shot = S.shot;
    if (!shot) return;
    shot.tag = shot.tag === b.dataset.tag ? null : b.dataset.tag;
    shot.score = shot.analysis.ok ? shotScore(shot.metrics, shot.tag) : 0;
    $$chips('#repTag', 'tag', shot.tag);
    updateScoreLabel(shot);
    await noteShot(shot);
  });
});
document.querySelectorAll('#trDir button, #trLen button').forEach((b) => {
  b.addEventListener('click', () => {
    const shot = S.shot;
    if (!shot) return;
    shot.tracer = { dir: shot.tracer?.dir || 'straight', len: shot.tracer?.len || 'normal', ...(b.dataset.dir ? { dir: b.dataset.dir } : { len: b.dataset.len }) };
    $$chips('#trDir', 'dir', shot.tracer.dir);
    $$chips('#trLen', 'len', shot.tracer.len);
    shot.capture?.onTracer?.(shot);
    const v = $('#plVideo');
    const ph = shot.analysis.phases;
    if (ph) {
      R.phase = null;
      v.currentTime = Math.max(0, (ph.impact.t - 0.2) * (shot.slow || 1));
      v.playbackRate = 0.5;
      v.play().catch(() => {});
    }
  });
});
$('#repSave').addEventListener('click', async () => {
  const shot = S.shot;
  if (!shot?.blob) return;
  const d = new Date(shot.at);
  const p = (n) => String(n).padStart(2, '0');
  const ext = /mp4|quicktime/.test(shot.mime) ? 'mp4' : 'webm';
  const r = await shareFile(shot.blob, `swing-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`);
  if (r === 'shared') {
    shot.saved = true;
    $('#repSave').textContent = '저장했어요';
    toast("공유 창에서 '비디오 저장'을 눌렀다면 사진 앱에 들어갔어요");
  } else if (r === 'downloaded') {
    shot.saved = true;
    toast('파일 앱에 내려받았어요');
  }
});
$('#repDiscard').addEventListener('click', () => {
  const shot = S.shot;
  if (!shot) return;
  shot.discarded = true;
  $('#repDiscard').disabled = true;
  toast(S.best?.shotId === shot.id ? '사진 앱에는 저장하지 않아요. 오잘공 후보라 연습이 끝날 때까지만 보관해요.' : '이 영상은 저장하지 않고 지울게요.');
});

function renderNext(shot) {
  const box = $('#repNext');
  let html = '';
  if (shot.mode === 'screen') {
    html = `<button class="btn primary" data-a="same">① 같은 조건으로 다음 샷</button><button class="btn ghost" data-a="club">② 클럽·거리 바꾸기</button><button class="btn ghost" data-a="end">③ 연습 끝내기 (오잘공 릴스)</button>`;
  } else if (shot.mode === 'import') {
    html = `<button class="btn primary" data-a="slot">비교 기준으로 저장 (1~10번)</button><button class="btn ghost" data-a="again">다른 영상 불러오기</button><button class="btn ghost" data-a="home">처음으로</button>`;
  } else {
    html = `<button class="btn primary" data-a="field">다음 샷으로 이동</button>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => nextAction(b.dataset.a, shot);
  });
}
$('#repBack').addEventListener('click', () => {
  const shot = S.shot;
  if (!shot) {
    go('home', { push: false });
    return;
  }
  nextAction(shot.mode === 'screen' ? 'same' : shot.mode === 'import' ? 'again' : 'field', shot);
});

function nextAction(a, shot) {
  $('#plVideo').pause();
  if (a === 'slot') {
    slotPicker(shot);
    return;
  }
  if (a !== 'end') releaseShot(shot);
  if (a === 'same') startCapture(shot.capture);
  else if (a === 'club') {
    openClubPicker({
      title: '클럽·거리 바꾸기',
      club: shot.club,
      wedge: shot.wedge,
      cta: '이 클럽으로 촬영',
      onDone: (club, wedge) => {
        S.lastClub = club;
        startCapture({ ...shot.capture, club, wedge });
      },
    });
  } else if (a === 'end') {
    releaseShot(shot);
    endScreenSession();
  } else if (a === 'again') go('import', { push: false });
  else if (a === 'home') leaveFlow();
  else if (a === 'field') {
    if (shot.capture?.onReport) shot.capture.onReport(shot);
    else leaveFlow();
  }
}

function slotPicker(shot) {
  if (!shot.analysis.ok) {
    toast('분석이 된 샷만 저장할 수 있어요');
    return;
  }
  const rows = S.slots
    .map((s, i) => `<button class="btn ghost" data-i="${i}" style="text-align:left">${i + 1}. ${esc(s.name)}${s.data ? ' (덮어쓰기)' : ''}</button>`)
    .join('');
  showModal(
    `<h3>어느 칸에 저장할까요?</h3><p>영상은 저장하지 않고 관절 좌표와 지표만 저장해요. 비교할 때는 같은 구도의 영상끼리 겹쳐 보여요.</p><label class="f">칸 이름 바꾸기 (선택)<input type="text" id="slotName" placeholder="그대로 두려면 비워 두세요"></label><div class="stack">${rows}</div>`,
    (c) => {
      c.querySelectorAll('[data-i]').forEach((b) => {
        b.onclick = async () => {
          const i = Number(b.dataset.i);
          const nm = c.querySelector('#slotName').value.trim();
          S.slots[i] = {
            name: nm || S.slots[i].name,
            data: { savedAt: Date.now(), view: shot.view, hand: shot.analysis.hand, club: shot.club, metrics: metricValues(shot.metrics), keyframes: keyframes(shot.analysis) },
          };
          await saveSlots();
          closeModal();
          toast(`${i + 1}번 칸에 저장했어요`);
          renderCompareChips(shot);
        };
      });
    },
  );
}

/* =================== 연습 끝·요약·릴스 =================== */
export async function endScreenSession() {
  stopCaptureLoop();
  closeCamera();
  const s = S.session;
  if (s) {
    s.status = 'done';
    s.endedAt = Date.now();
    await saveSession();
  }
  openSummary(s);
}

export function openSummary(s) {
  stopCaptureLoop();
  closeCamera();
  go('summary', { push: false });
  const shots = (s?.shots || []).filter((x) => x.ok);
  const avg = shots.length ? Math.round(shots.reduce((a, b) => a + b.score, 0) / shots.length) : null;
  const b = S.best && S.best.sessionId === s?.id ? S.best : null;
  const holesDone = s?.type === 'field' ? Object.values(s.holes || {}).filter((h) => h.done).length : 0;
  $('#summarySheet').innerHTML = `
    <div class="info">
      <div><span>분석한 샷</span><b>${shots.length}개</b></div>
      <div><span>평균 점수</span><b>${avg ?? '–'}</b></div>
      ${s?.type === 'field' ? `<div class="full"><span>라운드</span><b>${esc(s.courseName || '')} · ${holesDone}개 홀 완료</b></div>` : ''}
    </div>
    ${b ? `<h3>오늘의 오잘공</h3><div class="coach"><b>${esc(b.info.club)} · ${b.score}점</b><p>${esc(b.info.date)}</p></div><button class="btn primary wide" id="smReel">오잘공 15초 릴스 만들기</button>` : '<p class="empty-msg">분석된 샷이 없어서 릴스는 만들 수 없어요.</p>'}
    <button class="btn ghost wide" id="smHome">처음으로</button>`;
  $('#smHome').onclick = () => leaveFlow();
  if (b) $('#smReel').onclick = () => makeReelFor(b);
}

async function makeReelFor(b) {
  showModal(
    `<h3>오잘공 릴스 만드는 중…</h3><p>15초쯤 걸려요. 화면을 켜 둔 채 기다려 주세요.</p><div id="reelHost" style="display:flex;gap:10px;align-items:flex-end"></div><video id="reelVid" playsinline muted style="width:72px;height:128px;background:#000;border-radius:8px"></video><div class="progress" style="width:100%;background:#E6EEE8;margin-top:12px"><i id="reelBar"></i></div>`,
    null,
    { lock: true },
  );
  requestWake();
  try {
    if (!b.url) b.url = URL.createObjectURL(b.blob);
    const blob = await makeReel({
      host: $('#reelHost'),
      video: $('#reelVid'),
      clipUrl: b.url,
      analysis: b.analysis,
      info: b.info,
      onProgress: (x) => {
        const el = $('#reelBar');
        if (el) el.style.width = `${Math.round(x * 100)}%`;
      },
    });
    const url = URL.createObjectURL(blob);
    showModal(
      `<h3>릴스가 준비됐어요</h3><video class="preview" src="${url}" playsinline controls></video><div class="stack"><button class="btn primary" data-a="save">사진 앱에 저장</button><button class="btn ghost" data-a="close">닫기</button></div>`,
      (c) => {
        c.querySelector('[data-a=save]').onclick = async () => {
          const r = await shareFile(blob, `ojalgong-${Date.now()}.${/mp4/.test(blob.type) ? 'mp4' : 'webm'}`);
          if (r !== 'cancelled') toast('저장했어요');
        };
        c.querySelector('[data-a=close]').onclick = () => {
          closeModal();
          URL.revokeObjectURL(url);
        };
      },
    );
  } catch (e) {
    closeModal();
    log(`릴스 실패: ${e.message || e}`, 'error');
    toast(`릴스를 만들지 못했어요: ${e.message || e}`, 6000);
  }
}

export async function leaveFlow() {
  stopCaptureLoop();
  closeCamera();
  closeModal();
  const s = S.session;
  if (s && s.status !== 'active') {
    await store.del('clips', s.id).catch(() => {});
    if (S.best?.sessionId === s.id) {
      if (S.best.url) URL.revokeObjectURL(S.best.url);
      S.best = null;
    }
  }
  if (S.shot) releaseShot(S.shot);
  S.shot = null;
  if (s?.status !== 'active') S.session = null;
  S.stack = [];
  go('home', { push: false });
}
