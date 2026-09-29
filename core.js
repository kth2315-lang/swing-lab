// 앱 전체가 함께 쓰는 상태와 화면 이동·창 띄우기
import { $, $$, esc, log } from './util.js';
import * as store from './store.js';
import { PRO_NAMES, clubById } from './refs.js';

export const S = {
  profile: { hand: 'R', fps: 60, threshold: 0.3, clubs: {}, voice: true },
  slots: PRO_NAMES.map((name) => ({ name, data: null })),
  clubStats: {},
  windConsent: false,
  blocked: [],
  screen: 'home',
  stack: [],
  session: null,
  cam: null,
  capture: null,
  shot: null,
  best: null,
  lastClub: '7I',
};

/* ---- 화면 이동 ---- */
const enterHooks = {};
export function onEnter(name, fn) {
  enterHooks[name] = fn;
}
export function go(name, { push = true } = {}) {
  const prev = S.screen;
  if (push && prev && prev !== name) S.stack.push(prev);
  S.screen = name;
  $$('.screen').forEach((el) => el.classList.toggle('on', el.id === `s-${name}`));
  window.scrollTo(0, 0);
  try {
    enterHooks[name]?.();
  } catch (e) {
    log(`화면 열기 오류(${name}): ${e.message}`, 'error');
  }
}
export function goBack() {
  const prev = S.stack.pop();
  go(prev || 'home', { push: false });
}

/* ---- 창 ---- */
export function showModal(html, bind, { lock = false } = {}) {
  const m = $('#modal');
  const c = $('#modalCard');
  c.innerHTML = html;
  m.hidden = false;
  m.onclick = (e) => {
    if (e.target === m && !lock) closeModal();
  };
  bind?.(c);
}
export function closeModal() {
  $('#modal').hidden = true;
  $('#modalCard').innerHTML = '';
}
export function confirmBox({ title, text, ok = '확인', cancel = '취소', danger = false }) {
  return new Promise((resolve) => {
    showModal(
      `<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="stack"><button class="btn ${danger ? 'danger' : 'primary'}" data-a="ok">${esc(ok)}</button><button class="btn ghost" data-a="no">${esc(cancel)}</button></div>`,
      (c) => {
        c.querySelector('[data-a=ok]').onclick = () => { closeModal(); resolve(true); };
        c.querySelector('[data-a=no]').onclick = () => { closeModal(); resolve(false); };
      },
      { lock: true },
    );
  });
}

/* ---- 화면 켜짐 유지 ---- */
let wake = null;
export async function requestWake() {
  if (!('wakeLock' in navigator) || wake) return;
  try {
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });
  } catch (e) {
    log(`화면 켜짐 유지 실패 (${e.name})`);
  }
}
export function releaseWake() {
  try {
    wake?.release();
  } catch {
    /* 무시 */
  }
  wake = null;
}

/* ---- 저장 ---- */
const quiet = (p) => p.catch((e) => log(`저장 실패: ${e.message}`, 'error'));
export const saveProfile = () => quiet(store.setKV('profile', S.profile));
export const saveSlots = () => quiet(store.setKV('slots', S.slots));
export const saveClubStats = () => quiet(store.setKV('clubStats', S.clubStats));

/* ---- 작은 도구 ---- */
export function clubLabel(id, wedge) {
  const c = clubById(id);
  return wedge ? `${c.name} · ${wedge}m` : c.name;
}
export const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
export function fitStage(stage, video, canvas, maxW, maxH) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return false;
  let w = maxW;
  let h = (w * vh) / vw;
  if (h > maxH) {
    h = maxH;
    w = (h * vw) / vh;
  }
  stage.style.width = `${Math.round(w)}px`;
  stage.style.height = `${Math.round(h)}px`;
  canvas.width = Math.round(w * dpr());
  canvas.height = Math.round(h * dpr());
  return true;
}

/* ---- 보안 표시 ---- */
export function noteBlocked(what) {
  if (!S.blocked.includes(what)) S.blocked.push(what);
  updateLock();
}
export function updateLock() {
  const b = $('#lockBadge');
  if (b) b.textContent = S.blocked.length ? `🔒 외부 통신 잠김 · 막은 시도 ${S.blocked.length}` : '🔒 외부 통신 잠김';
}
