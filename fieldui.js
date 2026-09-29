// 필드 모드 화면
import { $, esc, uid, log, toast, haversine, bearing, dirName } from './util.js';
import { clubById } from './refs.js';
import * as store from './store.js';
import { Geo, askCompass, fetchWind, fetchElevations, clubSummary, bagDistances, playsLike, recommend, shotOutcome, predictLanding, drawMinimap } from './field.js';
import { S, go, showModal, closeModal, confirmBox, saveClubStats } from './core.js';
import { unlockAudio } from './sound.js';
import { startCapture, stopCaptureLoop, closeCamera, newSession, saveSession, openSummary } from './capture.js';

const FS = { course: null, round: null, geo: null, me: null, raf: 0, view: 'list', target: null, rec: null, lastDraw: 0 };

export async function openField() {
  go('field');
  if (FS.round && FS.round.status === 'active' && FS.course) showHole();
  else await showCourses();
}

$('#fieldBack').addEventListener('click', () => {
  stopMap();
  FS.geo?.stop();
  if (FS.view === 'holes') showCourses();
  else go('home', { push: false });
});

/* ---------- 골프장 목록 ---------- */
async function showCourses() {
  FS.view = 'list';
  stopMap();
  $('#fieldTitle').textContent = '필드 모드';
  let courses = [];
  try {
    courses = (await store.all('courses')).sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
  } catch (e) {
    log(`골프장 목록 읽기 실패: ${e.message}`, 'error');
  }
  const known = (c) => c.holes.filter((h) => h.tee || h.green).length;
  $('#fieldSheet').innerHTML = `
    <p class="fine" style="text-align:left;margin:0 0 6px">처음 가는 골프장은 이름만 등록하면 돼요. 티와 그린 위치는 치면서 저절로 저장되고, 다음에 오면 남은 거리가 나와요.</p>
    ${courses.length
      ? `<ul class="list">${courses.map((c) => `<li><button class="rowbtn" data-id="${c.id}"><span><b>${esc(c.name)}</b><small>${known(c)}개 홀 위치 저장됨</small></span><span class="tag">선택</span></button></li>`).join('')}</ul>`
      : '<p class="empty-msg">등록된 골프장이 없어요.</p>'}
    <button class="btn primary wide" id="fcAdd">골프장 추가</button>`;
  $('#fieldSheet').querySelectorAll('.rowbtn').forEach((b) => {
    b.onclick = () => pickHole(courses.find((c) => c.id === b.dataset.id));
  });
  $('#fcAdd').onclick = addCourse;
}

function addCourse() {
  showModal(
    `<h3>골프장 추가</h3><label class="f">골프장 이름<input type="text" id="fcName" placeholder="예: ○○CC 동코스"></label><div class="stack"><button class="btn primary" data-a="ok">추가</button><button class="btn ghost" data-a="no">취소</button></div>`,
    (c) => {
      c.querySelector('[data-a=no]').onclick = closeModal;
      c.querySelector('[data-a=ok]').onclick = async () => {
        const name = c.querySelector('#fcName').value.trim();
        if (!name) {
          toast('이름을 넣어 주세요');
          return;
        }
        const course = { id: uid(), name, createdAt: Date.now(), holes: Array.from({ length: 18 }, (_, i) => ({ no: i + 1, par: 4, tee: null, green: null })) };
        await store.put('courses', course);
        closeModal();
        pickHole(course);
      };
    },
  );
}

function pickHole(course) {
  if (!course) return;
  FS.view = 'holes';
  $('#fieldTitle').textContent = course.name;
  $('#fieldSheet').innerHTML = `
    <h3>몇 번 홀부터 시작할까요?</h3>
    <div class="holes">${course.holes.map((h) => `<button data-no="${h.no}" class="${h.tee || h.green ? 'done' : ''}">${h.no}</button>`).join('')}</div>
    <p class="fine" style="text-align:left">연한 초록 칸은 위치가 저장된 홀이에요.</p>`;
  $('#fieldSheet').querySelectorAll('.holes button').forEach((b) => {
    b.onclick = () => startRound(course, Number(b.dataset.no));
  });
}

async function startRound(course, no) {
  FS.course = course;
  course.usedAt = Date.now();
  await store.put('courses', course).catch(() => {});
  await newSession('field', { courseId: course.id, courseName: course.name, holeNo: no, holes: {}, wind: null, elev: null });
  FS.round = S.session;
  FS.target = null;
  showHole();
  toast('위치를 쓰려면 허용을 눌러 주세요');
}

/* ---------- 홀 화면 ---------- */
const hole = () => FS.course.holes[FS.round.holeNo - 1];
function holeState() {
  const r = FS.round;
  r.holes = r.holes || {};
  r.holes[r.holeNo] = r.holes[r.holeNo] || { shots: [], done: false };
  return r.holes[r.holeNo];
}

function showHole() {
  FS.view = 'hole';
  const h = hole();
  $('#fieldTitle').textContent = `${FS.course.name} · ${FS.round.holeNo}번 홀 (파${h.par})`;
  $('#fieldSheet').innerHTML = `
    <canvas class="minimap" id="fmMap"></canvas>
    <div class="info" id="fmInfo"></div>
    <div class="aim" id="fmAim" hidden></div>
    <div class="stack">
      <button class="btn primary" id="fmShot">샷 준비</button>
      <div class="grid2"><button class="btn ghost" id="fmWind">바람·고도 받기</button><button class="btn ghost" id="fmWindM">바람 직접 입력</button></div>
      <div class="grid2"><button class="btn ghost" id="fmTarget">목표 거리 입력</button><button class="btn ghost" id="fmHoles">홀 이동·파 수정</button></div>
      <button class="btn ghost" id="fmCompass">방향 표시 켜기</button>
      <button class="btn" id="fmOut">그린 도착 · 홀아웃</button>
      <button class="btn ghost" id="fmEnd">라운드 끝내기</button>
    </div>`;
  $('#fmShot').onclick = shotPrep;
  $('#fmWind').onclick = windAuto;
  $('#fmWindM').onclick = windManual;
  $('#fmTarget').onclick = targetInput;
  $('#fmHoles').onclick = holeMenu;
  $('#fmOut').onclick = holeOut;
  $('#fmEnd').onclick = endRound;
  $('#fmCompass').onclick = async () => {
    const ok = await askCompass();
    toast(ok ? '미니맵에 바라보는 방향을 표시할게요' : '방향 정보를 쓸 수 없어요');
  };
  startGeo();
  renderInfo();
  startMap();
}

function startGeo() {
  if (!FS.geo) {
    FS.geo = new Geo((fix) => {
      FS.me = fix;
      if (FS.view === 'hole' && S.screen === 'field') renderInfo();
    });
  }
  FS.geo.start();
}

function startMap() {
  cancelAnimationFrame(FS.raf);
  const step = (t) => {
    const cv = $('#fmMap');
    if (FS.view !== 'hole' || S.screen !== 'field' || !cv) return;
    FS.raf = requestAnimationFrame(step);
    if (t - FS.lastDraw < 50) return;
    FS.lastDraw = t;
    drawMinimap(cv, mapState(), t);
  };
  FS.raf = requestAnimationFrame(step);
}
function stopMap() {
  cancelAnimationFrame(FS.raf);
}

function mapState() {
  const h = hole();
  const hs = holeState();
  const last = hs.shots[hs.shots.length - 1];
  const open = last && !last.landing ? last : null;
  const sum = open ? clubSummary(S.clubStats, open.club) : null;
  return {
    tee: h.tee,
    green: h.green,
    me: FS.me,
    heading: FS.geo?.heading,
    shots: hs.shots,
    predicted: open?.predicted || null,
    lastStart: open?.start || null,
    spread: sum && sum.nLat >= 5 ? Math.max(5, sum.latSd || 0) : null,
    wind: FS.round.wind,
  };
}

function renderInfo() {
  const box = $('#fmInfo');
  if (!box) return;
  const h = hole();
  const me = FS.me;
  const toGreen = h.green && me ? haversine(me, h.green) : null;
  const target = FS.target ?? toGreen;
  const brg = h.green && me ? bearing(me, h.green) : Number.isFinite(FS.geo?.heading) ? FS.geo.heading : null;
  const w = FS.round.wind;
  const elev = FS.round.elev && FS.round.elev.hole === FS.round.holeNo ? FS.round.elev.delta : 0;
  const pl = Number.isFinite(target) ? playsLike(target, w, brg, elev) : null;
  const bag = bagDistances(S.profile, S.clubStats);
  const rec = pl ? recommend(pl.playsLike, bag) : null;
  FS.rec = rec?.id || null;
  const windTxt = w && Number.isFinite(w.speed)
    ? `${dirName(w.from)}풍 ${w.speed.toFixed(1)}m/s${pl && Math.abs(pl.along) > 0.3 ? (pl.along < 0 ? ' · 맞바람' : ' · 뒷바람') : ''}`
    : '정보 없음';
  const remain = Number.isFinite(target)
    ? `${Math.round(target)}m${FS.target != null ? ' (입력)' : ''}`
    : h.green ? '위치 찾는 중' : '그린 위치 모름';
  box.innerHTML = `
    <div><span>남은 거리</span><b>${remain}</b></div>
    <div><span>바람</span><b>${esc(windTxt)}</b></div>
    <div><span>체감 거리${elev ? ` (고저차 ${elev > 0 ? '+' : ''}${Math.round(elev)}m)` : ''}</span><b>${pl ? `${Math.round(pl.playsLike)}m` : '–'}</b></div>
    <div><span>추천 클럽</span><b>${rec ? `${esc(rec.name)}` : '–'}</b></div>
    <div class="full"><span>GPS 정확도</span><b>${me ? `±${Math.round(me.acc)}m${me.acc > 20 ? ' · 흔들려요' : ''}` : '위치 찾는 중'}</b></div>`;
  const aim = $('#fmAim');
  const s = rec?.summary;
  if (s && s.nLat >= 5 && Math.abs(s.lat) >= 3) {
    aim.hidden = false;
    aim.textContent = `${rec.name}: 평소 ${s.lat > 0 ? '오른쪽' : '왼쪽'}으로 평균 ${Math.round(Math.abs(s.lat))}m 가요. ${s.lat > 0 ? '왼쪽' : '오른쪽'}으로 그만큼 겨냥해 보세요. (${s.nLat}샷 기준)`;
  } else aim.hidden = true;
}

/* ---------- 샷 ---------- */
function shotPrep() {
  const bag = bagDistances(S.profile, S.clubStats);
  let club = FS.rec || S.lastClub || '7I';
  const draw = (c) => {
    c.querySelector('#spClubs').innerHTML = bag
      .map((b) => `<button data-id="${b.id}" class="${club === b.id ? 'on' : ''}">${esc(b.name)}<small>${Math.round(b.use)}m${b.id === FS.rec ? ' · 추천' : ''}</small></button>`)
      .join('');
    c.querySelectorAll('#spClubs button').forEach((b) => {
      b.onclick = () => {
        club = b.dataset.id;
        draw(c);
      };
    });
  };
  showModal(
    `<h3>샷 준비</h3><p>추천 클럽이 먼저 골라져 있어요. 지금 서 있는 곳이 이번 샷의 출발점이에요.</p><div class="clubs" id="spClubs"></div>
     <div class="stack"><button class="btn primary" data-a="film">촬영하고 치기</button><button class="btn ghost" data-a="log">촬영 없이 기록만</button></div>`,
    (c) => {
      draw(c);
      c.querySelector('[data-a=film]').onclick = () => { unlockAudio(); closeModal(); beginShot(club, true); };
      c.querySelector('[data-a=log]').onclick = () => { closeModal(); beginShot(club, false); };
    },
  );
}

async function beginShot(club, film) {
  const start = FS.geo?.best() || FS.me;
  if (!start) {
    toast('아직 위치를 못 찾았어요. 잠시 후 다시 눌러 주세요.');
    return;
  }
  S.lastClub = club;
  const h = hole();
  const hs = holeState();
  const prev = hs.shots[hs.shots.length - 1];
  if (prev && !prev.landing) settleShot(prev, start);
  if (!h.tee && !hs.shots.length) {
    h.tee = { lat: start.lat, lng: start.lng };
    await store.put('courses', FS.course).catch(() => {});
  }
  const aimBrg = h.green ? bearing(start, h.green) : Number.isFinite(FS.geo?.heading) ? FS.geo.heading : null;
  const cb = bagDistances(S.profile, S.clubStats).find((b) => b.id === club);
  const shot = { id: uid(), club, start: { lat: start.lat, lng: start.lng, acc: start.acc }, aimBrg, at: Date.now(), filmed: film, dir: null, landing: null };
  shot.predicted = predictLanding(shot.start, aimBrg, cb.use, 0, clubSummary(S.clubStats, club));
  hs.shots.push(shot);
  await saveSession();
  if (film) {
    stopMap();
    startCapture({
      mode: 'field',
      view: 'dtl',
      club,
      fast: hs.shots.length > 1,
      fieldShot: shot,
      onReport: backToHole,
      onTracer,
      onCancel: backToHole,
    });
  } else {
    toast('샷을 기록했어요. 공 있는 곳에서 다시 샷 준비를 눌러 주세요.');
    renderInfo();
  }
}

function backToHole() {
  stopCaptureLoop();
  closeCamera();
  go('field', { push: false });
  showHole();
}

function onTracer(reportShot) {
  const fs = reportShot.fieldShot;
  if (!fs || !reportShot.tracer) return;
  const off = { hookL: -30, left: -12, straight: 0, right: 12, sliceR: 30 }[reportShot.tracer.dir] ?? 0;
  const k = { short: 0.85, normal: 1, long: 1.1 }[reportShot.tracer.len] ?? 1;
  const cb = bagDistances(S.profile, S.clubStats).find((b) => b.id === fs.club);
  fs.dir = reportShot.tracer.dir;
  fs.predicted = predictLanding(fs.start, fs.aimBrg, cb.use * k, off, clubSummary(S.clubStats, fs.club));
  saveSession();
}

function settleShot(shot, landing) {
  shot.landing = { lat: landing.lat, lng: landing.lng };
  const o = shotOutcome(shot, landing);
  if (o && o.dist > 5) {
    shot.dist = o.dist;
    shot.lat = o.lat;
    const list = S.clubStats[shot.club] || (S.clubStats[shot.club] = []);
    list.push({ dist: o.dist, lat: o.lat, at: Date.now() });
    if (list.length > 60) list.shift();
    saveClubStats();
    log(`${clubById(shot.club).name} 실제 거리 ${Math.round(o.dist)}m${Number.isFinite(o.lat) ? `, 좌우 ${o.lat > 0 ? '오른쪽' : '왼쪽'} ${Math.abs(o.lat).toFixed(0)}m` : ''}`);
  }
}

async function holeOut() {
  const pos = FS.geo?.best() || FS.me;
  if (!pos) {
    toast('위치를 찾는 중이에요. 잠시 후 다시 눌러 주세요.');
    return;
  }
  const h = hole();
  const hs = holeState();
  const last = hs.shots[hs.shots.length - 1];
  if (last && !last.landing) settleShot(last, pos);
  if (!h.green) {
    h.green = { lat: pos.lat, lng: pos.lng };
    await store.put('courses', FS.course).catch(() => {});
    toast('그린 위치를 저장했어요. 다음에 이 홀에선 남은 거리가 나와요.', 4000);
  }
  hs.done = true;
  FS.target = null;
  if (FS.round.holeNo < 18) {
    FS.round.holeNo += 1;
    await saveSession();
    showHole();
    toast(`${FS.round.holeNo}번 홀로 넘어왔어요`);
  } else {
    await saveSession();
    finishRound();
  }
}

function holeMenu() {
  const hs = FS.round.holes || {};
  const h = hole();
  showModal(
    `<h3>홀 이동</h3><div class="holes">${FS.course.holes.map((x) => `<button data-no="${x.no}" class="${x.no === FS.round.holeNo ? 'on' : hs[x.no]?.done ? 'done' : ''}">${x.no}</button>`).join('')}</div>
     <h3>${FS.round.holeNo}번 홀 파</h3><div class="chips" id="hmPar">${[3, 4, 5].map((p) => `<button data-p="${p}" class="${h.par === p ? 'on' : ''}">파${p}</button>`).join('')}</div>
     <div class="stack"><button class="btn ghost" data-a="close">닫기</button></div>`,
    (c) => {
      c.querySelectorAll('.holes button').forEach((b) => {
        b.onclick = async () => {
          FS.round.holeNo = Number(b.dataset.no);
          FS.target = null;
          await saveSession();
          closeModal();
          showHole();
        };
      });
      c.querySelectorAll('#hmPar button').forEach((b) => {
        b.onclick = async () => {
          h.par = Number(b.dataset.p);
          await store.put('courses', FS.course).catch(() => {});
          closeModal();
          showHole();
        };
      });
      c.querySelector('[data-a=close]').onclick = closeModal;
    },
  );
}

/* ---------- 바람·거리 ---------- */
async function windAuto() {
  if (!S.windConsent) {
    const ok = await confirmBox({
      title: '바람·고도 정보 받기',
      text: '날씨 서버(Open-Meteo)에 지금 위치를 뭉개서 보내요. 바람은 약 1km, 고도는 약 100m 단위예요. 이름이나 기록은 보내지 않아요.',
      ok: '동의하고 받기',
      cancel: '안 받기',
    });
    if (!ok) return;
    S.windConsent = true;
    await store.setKV('windConsent', true).catch(() => {});
  }
  const me = FS.geo?.best() || FS.me;
  if (!me) {
    toast('위치를 찾는 중이에요. 잠시 후 다시 눌러 주세요.');
    return;
  }
  try {
    const w = await fetchWind(me);
    FS.round.wind = w;
    let msg = `바람 ${dirName(w.from)}풍 ${w.speed.toFixed(1)}m/s`;
    const h = hole();
    if (h.green) {
      const e = await fetchElevations([me, h.green]);
      if (e.length === 2 && e.every(Number.isFinite)) {
        FS.round.elev = { delta: e[1] - e[0], hole: FS.round.holeNo, at: Date.now() };
        msg += ` · 고저차 ${Math.round(e[1] - e[0])}m`;
      }
    }
    await saveSession();
    renderInfo();
    toast(msg);
  } catch (e) {
    log(e.message, 'error');
    toast(`${e.message}. 인터넷 연결을 확인하거나 직접 입력해 주세요.`);
  }
}

function windManual() {
  const dirs = [['북', 0], ['북동', 45], ['동', 90], ['남동', 135], ['남', 180], ['남서', 225], ['서', 270], ['북서', 315]];
  const cur = FS.round.wind || { speed: 3, from: 0 };
  let from = cur.from ?? 0;
  let speed = Number.isFinite(cur.speed) ? cur.speed : 3;
  showModal(
    `<h3>바람 직접 입력</h3><p>바람이 불어오는 방향을 골라 주세요. 깃발이 날리는 반대쪽이에요.</p>
     <div class="chips" id="wmDir">${dirs.map(([n, d]) => `<button data-d="${d}" class="${d === from ? 'on' : ''}">${n}</button>`).join('')}</div>
     <label class="f">세기 <b id="wmSpV">${speed.toFixed(1)}m/s</b><input type="range" id="wmSp" min="0" max="15" step="0.5" value="${speed}"></label>
     <div class="stack"><button class="btn primary" data-a="ok">적용</button><button class="btn ghost" data-a="clear">바람 지우기</button></div>`,
    (c) => {
      c.querySelectorAll('#wmDir button').forEach((b) => {
        b.onclick = () => {
          from = Number(b.dataset.d);
          c.querySelectorAll('#wmDir button').forEach((x) => x.classList.toggle('on', x === b));
        };
      });
      c.querySelector('#wmSp').oninput = (e) => {
        speed = Number(e.target.value);
        c.querySelector('#wmSpV').textContent = `${speed.toFixed(1)}m/s`;
      };
      c.querySelector('[data-a=ok]').onclick = async () => {
        FS.round.wind = { speed, from, source: 'manual', at: Date.now() };
        await saveSession();
        closeModal();
        renderInfo();
      };
      c.querySelector('[data-a=clear]').onclick = async () => {
        FS.round.wind = null;
        await saveSession();
        closeModal();
        renderInfo();
      };
    },
  );
}

function targetInput() {
  showModal(
    `<h3>목표 거리 입력</h3><p>그린 위치를 아직 모를 때 야디지 말뚝이나 캐디 안내 거리를 넣어 주세요.</p>
     <label class="f">거리 (m)<input type="number" inputmode="numeric" id="tgV" value="${FS.target != null ? Math.round(FS.target) : ''}"></label>
     <div class="stack"><button class="btn primary" data-a="ok">적용</button><button class="btn ghost" data-a="clear">입력 지우기 (GPS 거리 쓰기)</button></div>`,
    (c) => {
      c.querySelector('[data-a=ok]').onclick = () => {
        const v = Number(c.querySelector('#tgV').value);
        FS.target = Number.isFinite(v) && v > 0 ? v : null;
        closeModal();
        renderInfo();
      };
      c.querySelector('[data-a=clear]').onclick = () => {
        FS.target = null;
        closeModal();
        renderInfo();
      };
    },
  );
}

/* ---------- 라운드 끝 ---------- */
async function endRound() {
  const ok = await confirmBox({ title: '라운드를 끝낼까요?', text: '기록은 저장되고, 촬영한 샷이 있으면 오잘공 릴스를 만들 수 있어요.', ok: '라운드 끝내기', cancel: '계속하기' });
  if (ok) finishRound();
}
async function finishRound() {
  stopMap();
  FS.geo?.stop();
  const r = FS.round;
  if (r) {
    r.status = 'done';
    r.endedAt = Date.now();
    await saveSession();
  }
  FS.round = null;
  FS.view = 'list';
  openSummary(r);
}

/* ---------- 앱이 꺼졌다 켜졌을 때 이어 하기 ---------- */
export async function checkRecovery() {
  let list = [];
  try {
    list = await store.all('sessions');
  } catch {
    return;
  }
  const r = list.filter((s) => s.type === 'field' && s.status === 'active').sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!r) return;
  const course = await store.get('courses', r.courseId).catch(() => null);
  if (!course) {
    r.status = 'done';
    await store.put('sessions', r).catch(() => {});
    return;
  }
  const ok = await confirmBox({ title: '이어서 할까요?', text: `${r.courseName} ${r.holeNo}번 홀을 치던 중이었어요. 이어서 진행할까요?`, ok: '예, 이어서 할게요', cancel: '새로 시작' });
  if (ok) {
    S.session = r;
    FS.round = r;
    FS.course = course;
    const clip = await store.get('clips', r.id).catch(() => null);
    if (clip?.blob) {
      S.best = { sessionId: r.id, shotId: clip.shotId, score: clip.info?.score ?? 0, blob: clip.blob, url: URL.createObjectURL(clip.blob), analysis: clip.analysis, info: clip.info };
    }
    go('field');
    showHole();
    toast('이어서 진행해요. 미니맵과 기록을 되살렸어요.');
  } else {
    r.status = 'done';
    r.endedAt = Date.now();
    await store.put('sessions', r).catch(() => {});
    await store.del('clips', r.id).catch(() => {});
  }
}

export function fieldVisible() {
  if (S.screen === 'field' && FS.view === 'hole' && FS.round) {
    startGeo();
    startMap();
  }
}
export function fieldHidden() {
  stopMap();
}

