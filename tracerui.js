// 스윙 트레이서 화면: 카메라로 찍기 / 불러오기 → 클럽 궤적 찾기 → 효과 보기 → 영상 저장·보내기
import { $, esc, log, toast, once, sleep, nowMs, clamp, shareFile } from './util.js';
import { S, go, showModal, closeModal, fitStage, saveProfile, onEnter, requestWake, releaseWake } from './core.js';
import { startCapture, closeCamera, stopCaptureLoop } from './capture.js';
import { findHitInFile, unlockAudio } from './sound.js';
import { pickMime } from './camera.js';
import { traceVideo } from './tracer.js';
import { drawFx, FX_LIST, fxName } from './tracerfx.js';

const TV = { url: null, file: null, trace: null, source: null, capOpts: null, raf: 0, seg: [0, 0], busy: false, exporting: false };
const fxNow = () => (FX_LIST.some((f) => f.id === S.profile.fx) ? S.profile.fx : 'lightning');

/* =================== 첫 화면 =================== */
export function openTracer() {
  go('tracer');
}
onEnter('tracer', renderMenu);

function renderMenu() {
  const sheet = $('#tracerSheet');
  sheet.innerHTML = `
    <p class="tr-lead">클럽 끝(헤드)이 지나간 길을 빛으로 그려 줘요. 재미로 즐겨 보세요!</p>
    <button class="tr-big" id="trCam"><span>📷</span><b>카메라로 찍기</b><small>폰을 세워 두고 전신이 나오게 · 치고 나면 알아서 멈춰요</small></button>
    <label class="tr-big file" id="trPick"><span>🖼️</span><b>불러오기</b><small>사진 앱의 스윙 영상 · 슬로모션 영상이면 더 정확해요</small><input type="file" id="trFile" accept="video/*"></label>
    <h3>효과</h3>
    <div class="fx-chips light" id="trFx">${FX_LIST.map((f) => `<button data-fx="${f.id}">${f.icon} ${f.name}</button>`).join('')}</div>
    <ul class="tr-tips">
      <li>정면이든 측후방이든 다 돼요. 클럽이 화면 밖으로 나가지 않게 조금 멀리서 찍어 주세요.</li>
      <li>밝은 곳, 클럽과 배경 색이 다른 곳에서 찍으면 궤적이 더 정확해요.</li>
      <li>영상은 폰 안에서만 처리하고 어디에도 보내지 않아요.</li>
    </ul>`;
  markFx('#trFx');
  sheet.querySelectorAll('#trFx button').forEach((b) => {
    b.onclick = () => setFx(b.dataset.fx);
  });
  $('#trCam').onclick = startCamera;
  $('#trFile').onchange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) processFile(f);
  };
}

function markFx(sel) {
  document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.fx === fxNow()));
}
function setFx(id) {
  S.profile.fx = id;
  saveProfile();
  markFx('#trFx');
  markFx('#tvFx');
  drawNow();
}

/* =================== 카메라 =================== */
function startCamera() {
  unlockAudio();
  TV.source = 'camera';
  TV.capOpts = {
    mode: 'tracer',
    view: 'face',
    club: S.lastClub || '7I',
    fast: true,
    onClip: (clip) => processClip(clip),
    onCancel: () => go('tracer', { push: false }),
  };
  startCapture(TV.capOpts);
}

function processClip({ blob, impactHint, seconds }) {
  releaseMedia();
  TV.url = URL.createObjectURL(blob);
  TV.file = blob;
  let from = 0;
  let to = null;
  if (impactHint != null) {
    from = Math.max(0, impactHint - 2.6);
    to = impactHint + 1.8;
  } else if (seconds) from = Math.max(0, seconds - 7);
  runTrace({ from, to, impactHint });
}

/* =================== 불러오기 =================== */
async function processFile(file) {
  unlockAudio();
  releaseMedia();
  TV.source = 'import';
  TV.file = file;
  TV.url = URL.createObjectURL(file);
  go('trview', { push: false });
  setBusy('영상을 여는 중…', 0);
  const v = $('#tvVideo');
  v.src = TV.url;
  if (v.readyState < 1) await once(v, 'loadedmetadata', 10000);
  const dur = Number.isFinite(v.duration) ? v.duration : null;
  setBusy('타구음을 찾는 중…', 0);
  const hit = await findHitInFile(file);
  let from = 0;
  let to = null;
  if (hit != null) {
    from = Math.max(0, hit - 3);
    to = hit + 2.2;
  } else if (dur && dur > 30) {
    failed('영상이 길고 타구음을 못 찾았어요. 사진 앱에서 스윙 부분만 남기고(30초 이내) 잘라서 다시 불러와 주세요.');
    return;
  }
  runTrace({ from, to, impactHint: hit });
}

/* =================== 궤적 찾기 =================== */
async function runTrace({ from, to, impactHint }) {
  go('trview', { push: false });
  stopLoop();
  TV.trace = null;
  TV.busy = true;
  requestWake();
  $('#tvControls').hidden = true;
  $('#tvTitle').textContent = '스윙 트레이서';
  setBusy('클럽을 찾는 중…', 0);
  const v = $('#tvVideo');
  const cv = $('#tvCanvas');
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  v.onloadedmetadata = () => sizeStage();
  if (v.src !== TV.url) v.src = TV.url;
  if (v.readyState >= 1) sizeStage();
  const t0 = nowMs();
  let res;
  try {
    res = await traceVideo(v, TV.url, {
      from,
      to,
      impactHint,
      hand: S.profile.hand,
      onProgress: (x) => setBusy(`클럽을 찾는 중… ${Math.round(x * 100)}%`, x),
    });
  } catch (e) {
    log(`트레이서 실패: ${e.message || e}`, 'error');
    TV.busy = false;
    failed(e.message || '궤적을 찾지 못했어요.');
    return;
  }
  TV.busy = false;
  log(`트레이서 완료: ${res.ok ? `${res.mode === 'club' ? '클럽' : '손'} 궤적 · 또렷함 ${Math.round(res.quality * 100)}%` : res.reason} · ${((nowMs() - t0) / 1000).toFixed(1)}초`);
  if (S.screen !== 'trview') return;
  if (!res.ok) {
    failed(res.reason || '스윙을 찾지 못했어요.');
    return;
  }
  TV.trace = res;
  showResult();
}

function setBusy(text, x) {
  $('#tvBusy').hidden = false;
  $('#tvText').textContent = text;
  $('#tvBar').style.width = `${Math.round(clamp(x, 0, 1) * 100)}%`;
}

function failed(msg) {
  $('#tvBusy').hidden = true;
  showModal(
    `<h3>궤적을 그리지 못했어요</h3><p>${esc(msg)}</p><div class="stack"><button class="btn primary" data-a="retry">${TV.source === 'camera' ? '다시 찍기' : '다른 영상 고르기'}</button><button class="btn ghost" data-a="menu">스윙 트레이서 처음으로</button></div>`,
    (c) => {
      c.querySelector('[data-a=retry]').onclick = () => {
        closeModal();
        again();
      };
      c.querySelector('[data-a=menu]').onclick = () => {
        closeModal();
        leave();
      };
    },
    { lock: true },
  );
}

/* =================== 결과 보기 =================== */
function sizeStage() {
  const v = $('#tvVideo');
  fitStage($('#tvStage'), v, $('#tvCanvas'), Math.min(window.innerWidth, 560), window.innerHeight * (TV.trace ? 0.56 : 0.6));
  drawNow();
}
window.addEventListener('resize', () => {
  if (S.screen === 'trview') sizeStage();
});

function showResult() {
  const tr = TV.trace;
  const ph = tr.phases;
  const v = $('#tvVideo');
  const dur = Number.isFinite(v.duration) ? v.duration : ph.finish + 1;
  TV.seg = [Math.max(tr.span?.[0] ?? 0, ph.take - 0.6), Math.min(dur, ph.finish + 0.8)];
  $('#tvBusy').hidden = true;
  $('#tvControls').hidden = false;
  $('#tvTitle').textContent = `스윙 트레이서 · ${fxName(fxNow())}`;
  const note = $('#tvNote');
  if (tr.mode === 'hands') {
    note.hidden = false;
    note.textContent = '클럽이 잘 안 보여서 손이 지나간 길로 그렸어요. 밝은 곳에서, 클럽과 배경 색이 다르게 찍으면 클럽 궤적이 나와요.';
  } else if (tr.quality < 0.55) {
    note.hidden = false;
    note.textContent = '클럽이 잘 안 보인 순간은 앞뒤를 이어서 그렸어요.';
  } else note.hidden = true;
  markFx('#tvFx');
  document.querySelectorAll('#tvSpeed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) === 0.5));
  const seek = $('#tvSeek');
  seek.value = '0';
  sizeStage();
  v.pause();
  v.currentTime = TV.seg[0];
  v.playbackRate = 0.5;
  startLoop();
  // 바로 한 번 보여 줘요 (½ 속도)
  once(v, 'seeked', 2000).then(() => {
    if (S.screen === 'trview' && TV.trace === tr) v.play().catch(() => {});
  });
}

function drawNow() {
  const v = $('#tvVideo');
  const cv = $('#tvCanvas');
  if (!cv.width || !TV.trace) return;
  const g = cv.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  try {
    g.drawImage(v, 0, 0, cv.width, cv.height);
  } catch {
    /* 첫 장면 준비 전 */
  }
  const lay = layer(cv.width, cv.height);
  const t = Math.min(v.currentTime, TV.seg[1]);
  drawFx(lay.getContext('2d'), cv.width, cv.height, TV.trace, fxNow(), t);
  g.globalCompositeOperation = 'screen';
  g.drawImage(lay, 0, 0);
  g.globalCompositeOperation = 'source-over';
  const seek = $('#tvSeek');
  if (seek && document.activeElement !== seek) seek.value = String(Math.round(((t - TV.seg[0]) / Math.max(0.01, TV.seg[1] - TV.seg[0])) * 1000));
}

let layerCv = null;
function layer(w, h) {
  if (!layerCv) layerCv = document.createElement('canvas');
  if (layerCv.width !== w || layerCv.height !== h) {
    layerCv.width = w;
    layerCv.height = h;
  }
  return layerCv;
}

function startLoop() {
  stopLoop();
  const v = $('#tvVideo');
  const step = () => {
    if (S.screen !== 'trview' || !TV.trace) return;
    TV.raf = requestAnimationFrame(step);
    if (TV.exporting) return;
    if (!v.paused && v.currentTime >= TV.seg[1]) {
      v.pause();
      v.currentTime = TV.seg[1];
    }
    drawNow();
  };
  TV.raf = requestAnimationFrame(step);
}
function stopLoop() {
  cancelAnimationFrame(TV.raf);
  TV.raf = 0;
}

function togglePlay() {
  const v = $('#tvVideo');
  if (!TV.trace) return;
  if (v.paused) {
    if (v.currentTime >= TV.seg[1] - 0.05) v.currentTime = TV.seg[0];
    v.play().catch(() => {});
  } else v.pause();
}

/* =================== 영상 저장·보내기 =================== */
// 실제 속도 → 슬로모션(톱~임팩트) → 완성된 궤적 잠깐 멈춤
async function exportVideo(onProgress) {
  const v = $('#tvVideo');
  const tr = TV.trace;
  const ph = tr.phases;
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  const sc = Math.min(1, 1280 / Math.max(vw, vh));
  const CW = Math.max(2, Math.round((vw * sc) / 2) * 2);
  const CH = Math.max(2, Math.round((vh * sc) / 2) * 2);
  const canvas = document.createElement('canvas');
  canvas.width = CW;
  canvas.height = CH;
  if (!canvas.captureStream) throw new Error('이 기기는 영상 만들기를 지원하지 않아요.');
  const mime = pickMime();
  if (mime === null) throw new Error('이 기기는 녹화를 지원하지 않아요.');
  const g = canvas.getContext('2d');
  const lay = document.createElement('canvas');
  lay.width = CW;
  lay.height = CH;
  const lg = lay.getContext('2d');
  const fx = fxNow();
  const info = FX_LIST.find((f) => f.id === fx);
  const u = Math.min(CW, CH) / 720;
  const draw = (t, label) => {
    g.globalCompositeOperation = 'source-over';
    try {
      g.drawImage(v, 0, 0, CW, CH);
    } catch {
      /* 준비 전 */
    }
    drawFx(lg, CW, CH, tr, fx, t);
    g.globalCompositeOperation = 'screen';
    g.drawImage(lay, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = 8 * u;
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.font = `800 ${Math.round(34 * u)}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
    g.fillText(`${info.icon} 스윙 트레이서 · ${info.name}`, 26 * u, 56 * u);
    if (label) {
      g.textAlign = 'right';
      g.fillStyle = '#F2B705';
      g.font = `700 ${Math.round(28 * u)}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
      g.fillText(label, CW - 26 * u, 56 * u);
    }
    g.textAlign = 'right';
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = `600 ${Math.round(20 * u)}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
    g.fillText('스윙 랩', CW - 22 * u, CH - 22 * u);
    g.shadowBlur = 0;
  };
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
  const stopped = new Promise((r) => {
    rec.onstop = r;
  });
  const slowA = Math.max(TV.seg[0], ph.top - 0.35);
  const slowB = Math.min(TV.seg[1], ph.impact + 0.45);
  const slowRate = clamp((slowB - slowA) / 3, 0.1, 0.5);
  const parts = [
    { a: TV.seg[0], b: TV.seg[1], rate: 1, label: '' },
    { a: slowA, b: slowB, rate: slowRate, label: '슬로모션' },
  ];
  const total = parts.reduce((s, p) => s + (p.b - p.a) / p.rate, 0) + 1.6;
  let done = 0;
  rec.start();
  for (const p of parts) {
    v.pause();
    v.currentTime = p.a;
    await once(v, 'seeked', 4000);
    v.playbackRate = p.rate;
    const t0 = nowMs();
    try {
      await v.play();
    } catch (e) {
      log(`트레이서 영상 재생 실패: ${e.message}`, 'error');
      break;
    }
    const limit = ((p.b - p.a) / p.rate) * 1000 + 3000;
    while (v.currentTime < p.b && !v.ended && nowMs() - t0 < limit) {
      draw(v.currentTime, p.label);
      onProgress?.(clamp((done + (v.currentTime - p.a) / p.rate) / total, 0, 1));
      await new Promise((r) => requestAnimationFrame(r));
    }
    v.pause();
    done += (p.b - p.a) / p.rate;
  }
  // 완성된 궤적을 잠깐 보여 줘요
  v.currentTime = TV.seg[1];
  await once(v, 'seeked', 3000);
  const h0 = nowMs();
  while (nowMs() - h0 < 1600) {
    draw(TV.seg[1], '');
    onProgress?.(clamp((done + (nowMs() - h0) / 1000) / total, 0, 1));
    await sleep(33);
  }
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  v.playbackRate = 0.5;
  return new Blob(chunks, { type: rec.mimeType || mime || 'video/mp4' });
}

async function saveVideo() {
  if (!TV.trace || TV.exporting) return;
  const v = $('#tvVideo');
  v.pause();
  TV.exporting = true;
  showModal('<h3>효과 영상 만드는 중…</h3><p>영상을 한 번 재생하면서 만들어요. 잠시만 기다려 주세요.</p><div class="progress" style="width:100%;background:#E6EEE8"><i id="tvExBar"></i></div>', null, { lock: true });
  let blob = null;
  try {
    blob = await exportVideo((x) => {
      const b = document.getElementById('tvExBar');
      if (b) b.style.width = `${Math.round(x * 100)}%`;
    });
  } catch (e) {
    log(`트레이서 영상 만들기 실패: ${e.message || e}`, 'error');
    closeModal();
    toast(`영상을 만들지 못했어요 (${e.message || e})`, 5000);
  }
  TV.exporting = false;
  drawNow();
  if (!blob) return;
  log(`트레이서 영상: ${(blob.size / 1048576).toFixed(1)}MB ${blob.type}`);
  const ext = /webm/.test(blob.type) ? 'webm' : 'mp4';
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `swing-tracer-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`;
  // 공유 창은 버튼을 눌러야 열려요 (iOS 규칙)
  showModal(
    `<h3>효과 영상이 만들어졌어요 🎬</h3><p>아래 버튼을 누르고 '동영상 저장'을 고르면 사진 앱에 저장돼요. 카톡으로 바로 보낼 수도 있어요.</p><div class="stack"><button class="btn primary" data-a="share">사진 앱에 저장 · 보내기</button><button class="btn ghost" data-a="close">닫기</button></div>`,
    (c) => {
      c.querySelector('[data-a=share]').onclick = async () => {
        const r = await shareFile(blob, name);
        if (r !== 'cancelled') closeModal();
        if (r === 'downloaded') toast('영상 파일을 내려받았어요.');
      };
      c.querySelector('[data-a=close]').onclick = closeModal;
    },
    { lock: true },
  );
}

/* =================== 다시 / 나가기 =================== */
function again() {
  stopLoop();
  $('#tvVideo').pause();
  if (TV.source === 'camera' && TV.capOpts) {
    startCapture(TV.capOpts);
    return;
  }
  go('tracer', { push: false });
  // 바로 사진 앱 고르기 창을 열어요 (버튼을 누른 그 순간이라 열 수 있어요)
  $('#trFile')?.click();
}

function releaseMedia() {
  const v = $('#tvVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  if (TV.url) URL.revokeObjectURL(TV.url);
  TV.url = null;
  TV.file = null;
  TV.trace = null;
}

function leave() {
  stopLoop();
  stopCaptureLoop();
  closeCamera();
  releaseWake();
  releaseMedia();
  go('tracer', { push: false });
}

$('#tvPlay').addEventListener('click', togglePlay);
$('#tvVideo').addEventListener('play', () => { $('#tvPlay').textContent = '일시정지'; });
$('#tvVideo').addEventListener('pause', () => { $('#tvPlay').textContent = '재생'; });
document.querySelectorAll('#tvSpeed button').forEach((b) => {
  b.addEventListener('click', () => {
    const r = Number(b.dataset.rate);
    $('#tvVideo').playbackRate = r;
    document.querySelectorAll('#tvSpeed button').forEach((x) => x.classList.toggle('on', x === b));
  });
});
document.querySelectorAll('#tvFx button').forEach((b) => {
  b.addEventListener('click', () => {
    setFx(b.dataset.fx);
    $('#tvTitle').textContent = `스윙 트레이서 · ${fxName(fxNow())}`;
  });
});
$('#tvSeek').addEventListener('input', (e) => {
  const v = $('#tvVideo');
  v.pause();
  v.currentTime = TV.seg[0] + (Number(e.target.value) / 1000) * (TV.seg[1] - TV.seg[0]);
});
$('#tvSave').addEventListener('click', saveVideo);
$('#tvAgain').addEventListener('click', again);
$('#tvHome').addEventListener('click', () => {
  leave();
  go('home', { push: false });
});
$('#tvBack').addEventListener('click', () => {
  if (TV.busy) {
    toast('궤적을 찾는 중이에요. 끝나면 돌아갈 수 있어요.');
    return;
  }
  leave();
});
