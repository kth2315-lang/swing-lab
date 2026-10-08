// 필드 모드 화면 (v1.2)
import { $, esc, uid, log, toast, haversine, bearing, dirName, fromLocal } from './util.js';
import * as store from './store.js';
import { Geo, askCompass, fetchWind, fetchElevations, clubSummary, bagDistances, playsLike, recommend, shotOutcome, predictShot } from './field.js';
import { coursesNear, coursesByName, fetchCourseData, nearestCentroid } from './osm.js';
import { HoleView, TEE_HEX } from './holemap.js';
import { hasMapKey } from './maptiles.js';
import { S, go, showModal, closeModal, confirmBox, saveClubStats } from './core.js';
import { unlockAudio } from './sound.js';
import { startCapture, stopCaptureLoop, closeCamera, newSession, saveSession, openSummary } from './capture.js';
import { PHI_OF } from './tracker.js';

const FS = { course: null, round: null, geo: null, me: null, raf: 0, view: 'list', target: null, rec: null, lastDraw: 0, hv: null, measure: null, measureClub: null, style: 'auto' };
const TEE_NAMES = { black: '블랙', blue: '블루', white: '화이트', red: '레드' };
const LEN_K = { short: 0.85, normal: 1, long: 1.1 };

export async function openField() {
  go('field');
  if (FS.round && FS.round.status === 'active' && FS.course) showHole();
  else await showCourses();
}

$('#fieldBack').addEventListener('click', () => {
  stopMap();
  FS.geo?.stop();
  if (FS.view === 'holes' || FS.view === 'search') showCourses();
  else go('home', { push: false });
});

/* =================== 골프장 목록 =================== */
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
  $('#fieldSheet').innerHTML = `
    ${courses.length
      ? `<ul class="list">${courses.map((c) => `<li class="course-row"><button class="rowbtn" data-id="${c.id}"><span><b>${esc(c.name)}</b><small>${(c.holes || []).length}홀</small></span><span class="tag">선택</span></button><button class="btn ghost small" data-del="${c.id}">삭제</button></li>`).join('')}</ul>`
      : '<p class="empty-msg">등록된 골프장이 없어요.</p>'}
    <button class="btn primary wide" id="fcAdd">골프장 추가</button>`;
  $('#fieldSheet').querySelectorAll('.rowbtn').forEach((b) => {
    b.onclick = () => pickHole(courses.find((c) => c.id === b.dataset.id));
  });
  $('#fieldSheet').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const c = courses.find((x) => x.id === b.dataset.del);
      if (!c) return;
      if (FS.round && FS.round.status === 'active' && FS.round.courseId === c.id) {
        toast('지금 치고 있는 골프장은 지울 수 없어요. 라운드를 먼저 끝내 주세요.');
        return;
      }
      if (!(await confirmBox({ title: '골프장 삭제', text: `${c.name}의 지도와 홀 위치 정보가 지워져요. 샷 기록은 남아요.`, ok: '삭제', danger: true }))) return;
      await store.del('courses', c.id).catch(() => {});
      toast('골프장을 지웠어요');
      showCourses();
    };
  });
  $('#fcAdd').onclick = showSearch;
}

/* =================== 골프장 찾기 =================== */
function showSearch() {
  FS.view = 'search';
  $('#fieldTitle').textContent = '골프장 추가';
  $('#fieldSheet').innerHTML = `
    <button class="btn primary wide" id="fsNear" style="margin-top:0">내 주변 골프장 찾기</button>
    <h3>이름으로 찾기</h3>
    <div class="search-row"><input type="text" id="fsWord" placeholder="예: 해운대" autocomplete="off"><button class="btn" id="fsGo">찾기</button></div>
    <p class="fine" style="text-align:left">한 단어만 넣어도 돼요. 'CC'나 '컨트리클럽'은 안 써도 돼요.</p>
    <div id="fsResults"></div>`;
  $('#fsNear').onclick = searchNear;
  $('#fsGo').onclick = searchWord;
  $('#fsWord').onkeydown = (e) => {
    if (e.key === 'Enter') searchWord();
  };
}

async function searchNear() {
  const box = $('#fsResults');
  box.innerHTML = '<p class="fine">내 위치를 찾는 중…</p>';
  startGeo();
  let pos = FS.geo?.best();
  for (let i = 0; i < 40 && !pos; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    pos = FS.geo?.best();
  }
  if (!pos) {
    box.innerHTML = '<p class="fine">위치를 못 찾았어요. 위치 허용을 확인하거나 이름으로 찾아 주세요.</p>';
    return;
  }
  box.innerHTML = '<p class="fine">주변 골프장을 찾는 중…</p>';
  try {
    showResults(await coursesNear(pos), true);
  } catch (e) {
    log(`주변 골프장 찾기 실패: ${e.message}`, 'error');
    showResults(null);
  }
}

async function searchWord() {
  const w = $('#fsWord').value.trim();
  if (!w) {
    toast('골프장 이름을 한 단어 넣어 주세요');
    return;
  }
  const box = $('#fsResults');
  box.innerHTML = '<p class="fine">찾는 중…</p>';
  try {
    showResults(await coursesByName(w), false, w);
  } catch (e) {
    log(`이름으로 찾기 실패: ${e.message}`, 'error');
    showResults(null, false, w);
  }
}

function showResults(list, near = false, word = '') {
  const box = $('#fsResults');
  if (!box) return;
  const manual = `<button class="btn ghost wide" id="fsManual">목록에 없어요 · 이름만으로 추가</button>`;
  if (list === null) {
    box.innerHTML = `<p class="fine">지도 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.</p>${manual}`;
  } else if (!list.length) {
    box.innerHTML = `<p class="fine">찾은 골프장이 없어요.</p>${manual}`;
  } else {
    box.innerHTML = `<ul class="list">${list
      .slice(0, 30)
      .map((c, i) => `<li><button class="rowbtn" data-i="${i}"><span><b>${esc(c.name)}</b>${near && Number.isFinite(c.dist) ? `<small>${(c.dist / 1000).toFixed(1)}km</small>` : ''}</span><span class="tag">선택</span></button></li>`)
      .join('')}</ul>${manual}`;
    box.querySelectorAll('.rowbtn').forEach((b) => {
      b.onclick = () => loadCourse(list[Number(b.dataset.i)]);
    });
  }
  $('#fsManual').onclick = () => addManual(word);
}

async function loadCourse(item) {
  const id = `osm-${item.osmType}-${item.osmId}`;
  let course = await store.get('courses', id).catch(() => null);
  if (course?.feat || course?.fetchedAt) {
    pickHole(course);
    return;
  }
  showModal('<h3>골프장 불러오는 중…</h3><p>처음 한 번만 받아서 폰에 저장해요.</p><div class="progress" style="width:100%;background:#E6EEE8"><i style="width:60%"></i></div>', null, { lock: true });
  let data = null;
  try {
    data = await fetchCourseData(item);
  } catch (e) {
    log(`골프장 자료 받기 실패: ${e.message}`, 'error');
  }
  closeModal();
  course = {
    id,
    name: item.name,
    osmType: item.osmType,
    osmId: item.osmId,
    center: { lat: item.lat, lng: item.lng },
    bounds: data?.bounds || null,
    holes: data?.holes?.length ? data.holes : defaultHoles(),
    feat: data?.feat || null,
    fetchedAt: data ? Date.now() : null,
    createdAt: Date.now(),
  };
  await store.put('courses', course).catch(() => {});
  pickHole(course);
}

function defaultHoles() {
  return Array.from({ length: 18 }, (_, i) => ({ no: i + 1, label: String(i + 1), par: 4, tee: null, tees: [], green: null }));
}

function addManual(word = '') {
  showModal(
    `<h3>이름만으로 추가</h3><label class="f">골프장 이름<input type="text" id="fcName" value="${esc(word)}" placeholder="예: ○○CC 동코스"></label><div class="stack"><button class="btn primary" data-a="ok">추가</button><button class="btn ghost" data-a="no">취소</button></div>`,
    (c) => {
      c.querySelector('[data-a=no]').onclick = closeModal;
      c.querySelector('[data-a=ok]').onclick = async () => {
        const name = c.querySelector('#fcName').value.trim();
        if (!name) {
          toast('이름을 넣어 주세요');
          return;
        }
        const course = { id: uid(), name, createdAt: Date.now(), holes: defaultHoles(), feat: null };
        await store.put('courses', course);
        closeModal();
        pickHole(course);
      };
    },
  );
}

/* =================== 홀·티 선택 =================== */
function pickHole(course) {
  if (!course) return;
  FS.view = 'holes';
  normalize(course);
  let tee = S.profile.teeColor || 'white';
  $('#fieldTitle').textContent = course.name;
  const render = () => {
    $('#fieldSheet').innerHTML = `
      <h3 style="margin-top:4px">오늘 칠 티</h3>
      <div class="chips" id="phTee">${Object.entries(TEE_NAMES).map(([k, n]) => `<button data-t="${k}" class="${k === tee ? 'on' : ''}"><i class="tee-dot" style="background:${TEE_HEX[k]}"></i>${n}</button>`).join('')}</div>
      <h3>몇 번 홀부터 시작할까요?</h3>
      <div class="holes">${course.holes.map((h) => `<button data-no="${h.no}">${esc(h.label)}</button>`).join('')}</div>`;
    $('#fieldSheet').querySelectorAll('#phTee button').forEach((b) => {
      b.onclick = () => {
        tee = b.dataset.t;
        render();
      };
    });
    $('#fieldSheet').querySelectorAll('.holes button').forEach((b) => {
      b.onclick = () => {
        S.profile.teeColor = tee;
        store.setKV('profile', S.profile).catch(() => {});
        startRound(course, Number(b.dataset.no), tee);
      };
    });
  };
  render();
}

function normalize(course) {
  for (const h of course.holes || []) {
    if (!h.label) h.label = String(h.no);
    if (!Array.isArray(h.tees)) h.tees = [];
    if (!h.teeBy) h.teeBy = {};
  }
}

async function startRound(course, no, teeColor) {
  FS.course = course;
  course.usedAt = Date.now();
  await store.put('courses', course).catch(() => {});
  await newSession('field', { courseId: course.id, courseName: course.name, holeNo: no, teeColor, pins: {}, holes: {}, wind: null, elev: null });
  FS.round = S.session;
  FS.target = null;
  FS.measure = null;
  showHole();
}

/* =================== 도우미 =================== */
const hole = () => FS.course.holes.find((h) => h.no === FS.round.holeNo) || FS.course.holes[0];
function holeState() {
  const r = FS.round;
  r.holes = r.holes || {};
  r.holes[r.holeNo] = r.holes[r.holeNo] || { shots: [], done: false };
  return r.holes[r.holeNo];
}
const pinOf = (h) => FS.round.pins?.[h.no] || null;
const target = () => {
  const h = hole();
  return pinOf(h) || h.green || null;
};
function selTee(h) {
  const color = FS.round?.teeColor || 'white';
  if (h.teeBy?.[color]) return h.teeBy[color];
  const tees = h.tees || [];
  const exact = tees.find((t) => t.color === color);
  if (exact) return exact;
  if (tees.length && h.green) {
    const sorted = [...tees].sort((a, b) => haversine(b, h.green) - haversine(a, h.green));
    const n = sorted.length;
    const idx = { black: 0, blue: Math.round((n - 1) * 0.33), white: n >= 3 ? Math.round((n - 1) * 0.66) : 0, red: n - 1 }[color] ?? 0;
    return sorted[idx];
  }
  return tees[0] || h.tee || null;
}
function onHole() {
  const me = FS.me;
  if (!me) return false;
  const t = target() || selTee(hole());
  return !!t && haversine(me, t) < 800;
}
function nearCourse() {
  const me = FS.me;
  if (!me) return null;
  const c = FS.course.center || target() || selTee(hole());
  return !c || haversine(me, c) < 3000 ? me : null;
}
function measureFrom() {
  return onHole() ? FS.me : selTee(hole());
}
function openShot() {
  const hs = holeState();
  const last = hs.shots[hs.shots.length - 1];
  return last && !last.landing ? last : null;
}

/* =================== 홀 화면 =================== */
function showHole() {
  FS.view = 'hole';
  normalize(FS.course);
  const h = hole();
  $('#fieldTitle').textContent = `${FS.course.name} · ${h.label}번 홀 (파${h.par})`;
  const both = !!FS.course.feat && hasMapKey();
  $('#fieldSheet').innerHTML = `
    <div class="hole-info" id="fmInfo"></div>
    <div class="map-wrap">
      <canvas class="hole-map" id="fmMap"></canvas>
      ${both ? `<button class="map-chip" id="fmStyle">${FS.style === 'sat' ? '그림으로 보기' : '위성으로 보기'}</button>` : ''}
      <p class="map-hint">지도를 누르면 그곳까지 거리가 나와요</p>
    </div>
    <div class="aim" id="fmAim" hidden></div>
    <div class="stack">
      <button class="btn primary" id="fmShot">샷 준비</button>
      <div class="grid2"><button class="btn ghost" id="fmPin">핀 찍기</button><button class="btn ghost" id="fmWind">바람·고도 받기</button></div>
      <button class="btn" id="fmOut">그린 도착 · 홀아웃</button>
      <button class="btn ghost" id="fmMore">더보기</button>
    </div>`;
  FS.hv = new HoleView($('#fmMap'));
  $('#fmMap').addEventListener('click', onMapTap);
  $('#fmShot').onclick = shotPrep;
  $('#fmPin').onclick = () => mapEditor('pin');
  $('#fmWind').onclick = windAuto;
  $('#fmOut').onclick = holeOut;
  $('#fmMore').onclick = moreMenu;
  const st = $('#fmStyle');
  if (st) {
    st.onclick = () => {
      FS.style = FS.style === 'sat' ? 'auto' : 'sat';
      st.textContent = FS.style === 'sat' ? '그림으로 보기' : '위성으로 보기';
    };
  }
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

function scene() {
  const h = hole();
  const tee = selTee(h);
  const open = openShot();
  const me = nearCourse();
  return {
    mode: 'hole',
    feat: FS.course.feat || null,
    style: FS.style,
    bounds: FS.course.bounds || null,
    center: FS.course.center || null,
    tee,
    tees: h.tees?.length ? h.tees : tee ? [tee] : [],
    green: h.green,
    pin: pinOf(h),
    me,
    heading: FS.geo?.heading,
    shots: holeState().shots.filter((x) => x.landing),
    open: open ? { start: open.start, predicted: open.predicted, spread: open.spread } : null,
    wind: FS.round.wind,
    measure: FS.measure,
    measureFrom: FS.measure ? measureFrom() : null,
    measureClub: FS.measureClub,
    arcsFrom: onHole() ? FS.me : tee,
  };
}

function startMap() {
  cancelAnimationFrame(FS.raf);
  const step = (t) => {
    const cv = $('#fmMap');
    if (FS.view !== 'hole' || S.screen !== 'field' || !cv || !FS.hv) return;
    FS.raf = requestAnimationFrame(step);
    if (t - FS.lastDraw < 50) return;
    FS.lastDraw = t;
    FS.hv.setScene(scene());
    FS.hv.draw(t);
  };
  FS.raf = requestAnimationFrame(step);
}
function stopMap() {
  cancelAnimationFrame(FS.raf);
}

function onMapTap(e) {
  if (!FS.hv) return;
  const p = FS.hv.pointAt(e.clientX, e.clientY);
  if (!p) return;
  if (FS.measure && haversine(p, FS.measure) < 12) {
    FS.measure = null;
    FS.measureClub = null;
    return;
  }
  FS.measure = { lat: p.lat, lng: p.lng };
  const from = measureFrom();
  if (from) {
    const d = haversine(from, p);
    const pl = playsLike(d, FS.round.wind, bearing(from, p), 0);
    const rec = recommend(pl.playsLike, bagDistances(S.profile, S.clubStats));
    FS.measureClub = rec ? rec.name.replace(' 아이언', '번').replace('번번', '번') : null;
  }
}

function renderInfo() {
  const box = $('#fmInfo');
  if (!box) return;
  const h = hole();
  const tgt = target();
  const from = onHole() ? FS.me : selTee(h);
  const fromTee = !onHole();
  const dist = FS.target ?? (from && tgt ? haversine(from, tgt) : null);
  const brg = from && tgt ? bearing(from, tgt) : Number.isFinite(FS.geo?.heading) ? FS.geo.heading : null;
  const w = FS.round.wind;
  const elev = FS.round.elev && FS.round.elev.hole === FS.round.holeNo ? FS.round.elev.delta : 0;
  const pl = Number.isFinite(dist) ? playsLike(dist, w, brg, elev) : null;
  const bag = bagDistances(S.profile, S.clubStats);
  const rec = pl ? recommend(pl.playsLike, bag) : null;
  FS.rec = rec?.id || null;
  const windTxt = w && Number.isFinite(w.speed) ? `${dirName(w.from)} ${w.speed.toFixed(1)}m/s${pl && Math.abs(pl.along) > 0.3 ? (pl.along < 0 ? ' 맞바람' : ' 뒷바람') : ''}` : '정보 없음';
  const me = FS.me;
  const lbl = FS.target != null ? '목표까지 (입력)' : pinOf(h) ? `핀까지${fromTee ? ' · 티 기준' : ''}` : `그린 중앙까지${fromTee ? ' · 티 기준' : ''}`;
  box.innerHTML = `
    <div class="hi-main"><span>${lbl}</span><b>${Number.isFinite(dist) ? `${Math.round(dist)}m` : tgt ? '위치 찾는 중' : '그린 위치 모름'}</b></div>
    <div class="hi-grid">
      <div><span>체감 거리${elev ? ` (고저 ${elev > 0 ? '+' : ''}${Math.round(elev)}m)` : ''}</span><b>${pl ? `${Math.round(pl.playsLike)}m` : '–'}</b></div>
      <div><span>추천 클럽</span><b>${rec ? esc(rec.name) : '–'}</b></div>
      <div><span>바람</span><b>${esc(windTxt)}</b></div>
      <div><span>GPS</span><b>${me ? `±${Math.round(me.acc)}m` : '찾는 중'}</b></div>
    </div>`;
  const aim = $('#fmAim');
  const s = rec?.summary;
  const res = (S.clubStats[rec?.id] || []).map((x) => x.res).filter(Number.isFinite);
  const habit = res.length >= 3 ? res.reduce((a, b) => a + b, 0) / res.length : null;
  if (rec && habit != null && Math.abs(habit) >= 3) {
    aim.hidden = false;
    aim.textContent = `${rec.name}: 평소 ${habit > 0 ? '오른쪽' : '왼쪽'}으로 ${Math.round(Math.abs(habit))}m 휘어요. ${habit > 0 ? '왼쪽' : '오른쪽'}으로 그만큼 겨냥해 보세요. (${res.length}샷 기준)`;
  } else if (s && s.nLat >= 5 && Math.abs(s.lat) >= 3) {
    aim.hidden = false;
    aim.textContent = `${rec.name}: 평소 ${s.lat > 0 ? '오른쪽' : '왼쪽'}으로 평균 ${Math.round(Math.abs(s.lat))}m 가요. (${s.nLat}샷 기준)`;
  } else aim.hidden = true;
}

/* =================== 샷 =================== */
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
    `<h3>샷 준비</h3><p>지금 서 있는 곳이 이번 샷의 출발점이에요.</p><div class="clubs" id="spClubs"></div>
     <div class="stack"><button class="btn primary" data-a="film">촬영하고 치기</button><button class="btn ghost" data-a="log">촬영 없이 기록만</button></div>`,
    (c) => {
      draw(c);
      c.querySelector('[data-a=film]').onclick = () => { unlockAudio(); closeModal(); beginShot(club, true); };
      c.querySelector('[data-a=log]').onclick = () => { closeModal(); beginShot(club, false); };
    },
  );
}

function predict(shot) {
  const cb = bagDistances(S.profile, S.clubStats).find((b) => b.id === shot.club);
  const pr = predictShot({ start: shot.start, aimBrg: shot.aimBrg, club: shot.club, carry: cb?.use, wind: FS.round.wind, phiDeg: shot.phi || 0, lenK: shot.lenK || 1, stats: S.clubStats });
  shot.predicted = pr?.point || null;
  shot.predLat = pr?.lat ?? null;
  shot.predBase = pr?.base ?? null;
  shot.spread = pr?.spread ?? null;
}

async function beginShot(club, film) {
  const pos = FS.geo?.best() || FS.me;
  if (!pos) {
    toast('아직 위치를 못 찾았어요. 잠시 후 다시 눌러 주세요.');
    return;
  }
  S.lastClub = club;
  const h = hole();
  const hs = holeState();
  const prev = openShot();
  if (prev) settleShot(prev, pos);
  let start = { lat: pos.lat, lng: pos.lng, acc: pos.acc };
  if (!hs.shots.length) {
    // 티샷: 가까운(30m 안) 등록된 티로 맞춰요
    const cands = [selTee(h), ...(h.tees || []), h.tee, nearestCentroid(FS.course.feat, 'tee', pos, 30)].filter(Boolean);
    let best = null;
    let bd = 30;
    for (const c of cands) {
      const d = haversine(pos, c);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best) start = { lat: best.lat, lng: best.lng, acc: pos.acc, snapped: true };
    const color = FS.round.teeColor || 'white';
    h.teeBy = h.teeBy || {};
    if (!h.teeBy[color]) h.teeBy[color] = { lat: start.lat, lng: start.lng, color };
    if (!h.tee) h.tee = { lat: start.lat, lng: start.lng };
    await store.put('courses', FS.course).catch(() => {});
  }
  const tgt = target();
  const aimBrg = tgt ? bearing(start, tgt) : Number.isFinite(FS.geo?.heading) ? FS.geo.heading : null;
  const shot = { id: uid(), club, start, aimBrg, at: Date.now(), filmed: film, phi: 0, lenK: 1, landing: null };
  predict(shot);
  hs.shots.push(shot);
  FS.measure = null;
  await saveSession();
  if (film) {
    stopMap();
    startCapture({ mode: 'field', view: 'dtl', club, fast: hs.shots.length > 1, fieldShot: shot, onReport: backToHole, onTracer, onCancel: backToHole });
  } else {
    toast('기록했어요. 공 있는 곳에서 다시 샷 준비를 눌러 주세요.');
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
  const t = reportShot.tracer;
  if (!fs || !t) return;
  fs.phi = t.auto && Number.isFinite(t.phi) ? t.phi : PHI_OF[t.dir] ?? 0;
  fs.lenK = LEN_K[t.len] ?? 1;
  fs.dir = t.dir;
  predict(fs);
  saveSession();
}

function settleShot(shot, landing) {
  shot.landing = { lat: landing.lat, lng: landing.lng };
  const o = shotOutcome(shot, landing);
  if (o && o.dist > 5) {
    shot.dist = o.dist;
    shot.lat = o.lat;
    const res = Number.isFinite(o.lat) && Number.isFinite(shot.predBase) ? o.lat - shot.predBase : null;
    const list = S.clubStats[shot.club] || (S.clubStats[shot.club] = []);
    list.push({ dist: o.dist, lat: o.lat, res, at: Date.now() });
    if (list.length > 60) list.shift();
    saveClubStats();
    log(`${shot.club} 실제 ${Math.round(o.dist)}m${Number.isFinite(o.lat) ? ` · 좌우 ${o.lat > 0 ? '오른쪽' : '왼쪽'} ${Math.abs(o.lat).toFixed(0)}m` : ''}`);
  }
}

/* =================== 홀아웃 · 스코어 =================== */
function askPutts() {
  return new Promise((resolve) => {
    showModal(
      `<h3>퍼트는 몇 번 했나요?</h3><p>누르면 이 홀 스코어가 자동으로 적혀요.</p>
       <div class="chips putts">${[0, 1, 2, 3, 4, 5].map((n) => `<button data-n="${n}">${n}${n === 5 ? '+' : ''}</button>`).join('')}</div>
       <div class="stack"><button class="btn ghost" data-a="skip">기록 안 함</button></div>`,
      (c) => {
        c.querySelectorAll('[data-n]').forEach((b) => {
          b.onclick = () => { closeModal(); resolve(Number(b.dataset.n)); };
        });
        c.querySelector('[data-a=skip]').onclick = () => { closeModal(); resolve(null); };
      },
      { lock: true },
    );
  });
}

async function holeOut() {
  const pos = FS.geo?.best() || FS.me;
  if (!pos) {
    toast('위치를 찾는 중이에요. 잠시 후 다시 눌러 주세요.');
    return;
  }
  const h = hole();
  const hs = holeState();
  const last = openShot();
  if (last) settleShot(last, pos);
  if (!h.green) {
    const snap = nearestCentroid(FS.course.feat, 'green', pos, 45);
    h.green = snap ? { lat: snap.lat, lng: snap.lng } : { lat: pos.lat, lng: pos.lng };
    await store.put('courses', FS.course).catch(() => {});
  }
  const putts = await askPutts();
  hs.putts = putts;
  hs.strokes = putts == null ? null : hs.shots.length + putts;
  hs.par = h.par;
  hs.label = h.label;
  hs.done = true;
  FS.target = null;
  FS.measure = null;
  const holes = FS.course.holes;
  const idx = holes.findIndex((x) => x.no === h.no);
  if (idx >= 0 && idx < holes.length - 1) {
    FS.round.holeNo = holes[idx + 1].no;
    await saveSession();
    showHole();
    toast(`${holes[idx + 1].label}번 홀이에요`);
  } else {
    await saveSession();
    finishRound();
  }
}

/* =================== 더보기 · 홀 메뉴 =================== */
function moreMenu() {
  showModal(
    `<h3>더보기</h3><div class="stack">
      <button class="btn ghost" data-a="wind">바람 직접 입력</button>
      <button class="btn ghost" data-a="target">목표 거리 입력</button>
      <button class="btn ghost" data-a="loc">지도에서 티·그린 위치 찍기</button>
      <button class="btn ghost" data-a="hole">홀 이동 · 파 · 티 색</button>
      <button class="btn ghost" data-a="compass">방향 표시 켜기</button>
      <button class="btn ghost" data-a="end">라운드 끝내기</button>
      <button class="btn ghost" data-a="close">닫기</button></div>`,
    (c) => {
      const on = (a, fn) => { c.querySelector(`[data-a=${a}]`).onclick = () => { closeModal(); fn(); }; };
      on('wind', windManual);
      on('target', targetInput);
      on('loc', () => mapEditor('loc'));
      on('hole', holeMenu);
      on('compass', async () => toast((await askCompass()) ? '지도에 바라보는 방향을 표시할게요' : '방향 정보를 쓸 수 없어요'));
      on('end', endRound);
      on('close', () => {});
    },
  );
}

function holeMenu() {
  const hs = FS.round.holes || {};
  const h = hole();
  const color = FS.round.teeColor || 'white';
  const canReset = !!(h.tee || Object.keys(h.teeBy || {}).length || (h.green && !h.fromOsm));
  showModal(
    `<h3>홀 이동</h3><div class="holes">${FS.course.holes.map((x) => `<button data-no="${x.no}" class="${x.no === FS.round.holeNo ? 'on' : hs[x.no]?.done ? 'done' : ''}">${esc(x.label)}</button>`).join('')}</div>
     <h3>${esc(h.label)}번 홀 파</h3><div class="chips" id="hmPar">${[3, 4, 5].map((p) => `<button data-p="${p}" class="${h.par === p ? 'on' : ''}">파${p}</button>`).join('')}</div>
     <h3>오늘 칠 티</h3><div class="chips" id="hmTee">${Object.entries(TEE_NAMES).map(([k, n]) => `<button data-t="${k}" class="${k === color ? 'on' : ''}"><i class="tee-dot" style="background:${TEE_HEX[k]}"></i>${n}</button>`).join('')}</div>
     <h3>${esc(h.label)}번 홀 위치</h3><p>직접 찍거나 치면서 저장된 티·그린 위치를 지울 수 있어요.</p>
     <div class="stack"><button class="btn ghost" data-a="reset" ${canReset ? '' : 'disabled'}>이 홀 위치 지우기</button><button class="btn ghost" data-a="close">닫기</button></div>`,
    (c) => {
      c.querySelectorAll('.holes button').forEach((b) => {
        b.onclick = async () => {
          FS.round.holeNo = Number(b.dataset.no);
          FS.target = null;
          FS.measure = null;
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
      c.querySelectorAll('#hmTee button').forEach((b) => {
        b.onclick = async () => {
          FS.round.teeColor = b.dataset.t;
          S.profile.teeColor = b.dataset.t;
          store.setKV('profile', S.profile).catch(() => {});
          await saveSession();
          closeModal();
          showHole();
        };
      });
      c.querySelector('[data-a=close]').onclick = closeModal;
      c.querySelector('[data-a=reset]').onclick = async () => {
        closeModal();
        if (!(await confirmBox({ title: '위치 지우기', text: `${h.label}번 홀에 직접 찍거나 저장된 티·그린 위치를 지울까요?`, ok: '지우기', danger: true }))) return;
        h.tee = null;
        h.teeBy = {};
        if (!h.fromOsm) h.green = null;
        await store.put('courses', FS.course).catch(() => {});
        toast('지웠어요. 다시 치면서 저장하거나 지도에서 찍어 주세요.');
        showHole();
      };
    },
  );
}

/* =================== 지도에서 찍기 (오늘 핀 · 티 · 그린) =================== */
function mapEditor(purpose) {
  const h = hole();
  const tee = selTee(h);
  const pin = pinOf(h);
  const start = purpose === 'pin' ? pin || h.green || nearCourse() || tee || FS.course.center : h.green || tee || nearCourse() || FS.course.center;
  if (!start) {
    toast('위치를 찾는 중이에요. 잠시 후 다시 눌러 주세요.');
    return;
  }
  const V = { center: { lat: start.lat, lng: start.lng }, zoom: purpose === 'pin' ? 4 : 1.2 };
  const noMap = !FS.course.feat && !hasMapKey();
  const pointers = new Map();
  let pinch = null;
  const title = purpose === 'pin' ? `${h.label}번 홀 오늘 핀 찍기` : `${h.label}번 홀 티·그린 찍기`;
  const buttons = purpose === 'pin'
    ? '<button class="btn primary" data-a="pin">여기가 오늘 핀</button><button class="btn ghost" data-a="nopin">그린 중앙으로</button>'
    : `<button class="btn primary" data-a="tee">여기를 ${TEE_NAMES[FS.round.teeColor] || ''} 티로</button><button class="btn primary" data-a="green">여기를 그린으로</button>`;
  showModal(
    `<h3>${title}</h3>
     <p>지도를 끌어서 <b>가운데 + 표시</b>를 ${purpose === 'pin' ? '깃대 위치' : '티나 그린 한가운데'}에 맞춘 뒤 버튼을 눌러 주세요.${noMap ? ' 지도 그림이 없어서 위성지도 키를 넣으면 더 정확해요.' : ''}</p>
     <div class="me-wrap"><canvas id="meMap" class="me-map"></canvas>
       <div class="me-zoom"><button data-z="in" aria-label="확대">+</button><button data-z="out" aria-label="축소">−</button><button data-z="me" aria-label="내 위치">◎</button></div></div>
     <div class="grid2" style="margin-top:12px">${buttons}</div>
     <div class="stack"><button class="btn ghost" data-a="close">완료</button></div>`,
    (c) => {
      const cv = c.querySelector('#meMap');
      const hv = new HoleView(cv);
      const draw = (t) => {
        if (!cv.isConnected) return;
        requestAnimationFrame(draw);
        hv.setScene({
          mode: 'free',
          center: V.center,
          zoom: V.zoom,
          feat: FS.course.feat,
          style: FS.style,
          tees: h.tees?.length ? h.tees : tee ? [tee] : [],
          tee: selTee(h),
          green: h.green,
          pin: pinOf(h),
          me: nearCourse(),
          crosshair: true,
        });
        hv.draw(t);
      };
      requestAnimationFrame(draw);
      const zoom = (k) => { V.zoom = Math.min(20, Math.max(0.05, V.zoom * k)); };
      cv.addEventListener('pointerdown', (e) => {
        cv.setPointerCapture?.(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinch = Math.hypot(a.x - b.x, a.y - b.y);
        }
      });
      cv.addEventListener('pointermove', (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        const cur = { x: e.clientX, y: e.clientY };
        pointers.set(e.pointerId, cur);
        if (pointers.size >= 2) {
          const [a, b] = [...pointers.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch && dist > 0) zoom(dist / pinch);
          pinch = dist;
          return;
        }
        V.center = fromLocal(V.center, -(cur.x - prev.x) / V.zoom, (cur.y - prev.y) / V.zoom);
      });
      const up = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      c.querySelectorAll('[data-z]').forEach((b) => {
        b.onclick = () => {
          if (b.dataset.z === 'in') zoom(2);
          else if (b.dataset.z === 'out') zoom(0.5);
          else if (FS.me) V.center = { lat: FS.me.lat, lng: FS.me.lng };
          else toast('아직 내 위치를 못 찾았어요');
        };
      });
      const q = (a) => c.querySelector(`[data-a=${a}]`);
      if (purpose === 'pin') {
        q('pin').onclick = async () => {
          FS.round.pins = FS.round.pins || {};
          FS.round.pins[h.no] = { lat: V.center.lat, lng: V.center.lng };
          await saveSession();
          toast('오늘 핀 위치를 저장했어요');
          closeModal();
          showHole();
        };
        q('nopin').onclick = async () => {
          if (FS.round.pins) delete FS.round.pins[h.no];
          await saveSession();
          toast('그린 중앙 기준으로 계산해요');
          closeModal();
          showHole();
        };
      } else {
        q('tee').onclick = async () => {
          const color = FS.round.teeColor || 'white';
          h.teeBy = h.teeBy || {};
          h.teeBy[color] = { lat: V.center.lat, lng: V.center.lng, color };
          h.tee = { lat: V.center.lat, lng: V.center.lng };
          await store.put('courses', FS.course).catch(() => {});
          toast(`${h.label}번 홀 ${TEE_NAMES[color] || ''} 티를 저장했어요`);
        };
        q('green').onclick = async () => {
          h.green = { lat: V.center.lat, lng: V.center.lng };
          await store.put('courses', FS.course).catch(() => {});
          toast(`${h.label}번 홀 그린을 저장했어요`);
        };
      }
      q('close').onclick = () => {
        closeModal();
        showHole();
      };
    },
    { lock: true },
  );
}

/* =================== 바람 · 거리 =================== */
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
  const me = FS.geo?.best() || FS.me || selTee(hole()) || FS.course.center;
  if (!me) {
    toast('위치를 찾는 중이에요. 잠시 후 다시 눌러 주세요.');
    return;
  }
  try {
    const w = await fetchWind(me);
    FS.round.wind = w;
    let msg = `바람 ${dirName(w.from)}풍 ${w.speed.toFixed(1)}m/s`;
    const tgt = target();
    if (tgt) {
      const e = await fetchElevations([me, tgt]);
      if (e.length === 2 && e.every(Number.isFinite)) {
        FS.round.elev = { delta: e[1] - e[0], hole: FS.round.holeNo, at: Date.now() };
        msg += ` · 고저차 ${Math.round(e[1] - e[0])}m`;
      }
    }
    const open = openShot();
    if (open) predict(open);
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
      const apply = async (w) => {
        FS.round.wind = w;
        const open = openShot();
        if (open) predict(open);
        await saveSession();
        closeModal();
        renderInfo();
      };
      c.querySelector('[data-a=ok]').onclick = () => apply({ speed, from, source: 'manual', at: Date.now() });
      c.querySelector('[data-a=clear]').onclick = () => apply(null);
    },
  );
}

function targetInput() {
  showModal(
    `<h3>목표 거리 입력</h3><p>야디지 말뚝이나 캐디가 알려 준 거리를 넣어 주세요.</p>
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

/* =================== 라운드 끝 · 이어 하기 =================== */
async function endRound() {
  const ok = await confirmBox({ title: '라운드를 끝낼까요?', text: '기록과 스코어가 저장되고, 촬영한 샷이 있으면 오잘공 릴스를 만들 수 있어요.', ok: '라운드 끝내기', cancel: '계속하기' });
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
  normalize(course);
  const h = course.holes.find((x) => x.no === r.holeNo);
  const ok = await confirmBox({ title: '이어서 할까요?', text: `${r.courseName} ${h ? h.label : r.holeNo}번 홀을 치던 중이었어요. 이어서 진행할까요?`, ok: '예, 이어서 할게요', cancel: '새로 시작' });
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
    toast('이어서 진행해요. 지도와 기록을 되살렸어요.');
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
