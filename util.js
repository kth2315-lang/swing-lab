// 공통 도구 모음

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowMs = () => performance.now();

export function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x));
  if (!a.length) return null;
  a.sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function mean(arr) {
  const a = arr.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
export function sd(arr) {
  const a = arr.filter((x) => Number.isFinite(x));
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
export function fmt(n, d = 0) {
  return n == null || !Number.isFinite(n) ? '–' : Number(n).toFixed(d);
}
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export function once(el, ev, ms = 5000) {
  return new Promise((resolve) => {
    let timer;
    const h = () => {
      clearTimeout(timer);
      el.removeEventListener(ev, h);
      resolve(true);
    };
    el.addEventListener(ev, h);
    timer = setTimeout(() => {
      el.removeEventListener(ev, h);
      resolve(false);
    }, ms);
  });
}
export function dateText(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---- 위치 계산 (미터 단위) ---- */
const R_EARTH = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
export function haversine(a, b) {
  if (!a || !b) return null;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function bearing(a, b) {
  if (!a || !b) return null;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
export function destination(a, brg, dist) {
  const d = dist / R_EARTH;
  const t = rad(brg);
  const lat1 = rad(a.lat);
  const lng1 = rad(a.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(t));
  const lng2 = lng1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: deg(lng2) };
}
export function toLocal(origin, p) {
  return {
    x: rad(p.lng - origin.lng) * R_EARTH * Math.cos(rad(origin.lat)),
    y: rad(p.lat - origin.lat) * R_EARTH,
  };
}
export function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}
const DIR8 = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
export function dirName(degFrom) {
  return DIR8[Math.round((((degFrom % 360) + 360) % 360) / 45) % 8];
}

/* ---- 진행 기록 ---- */
const LOG = [];
export function log(msg, kind = 'info') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  LOG.unshift(`[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] ${kind === 'error' ? '⚠️ ' : ''}${msg}`);
  if (LOG.length > 300) LOG.pop();
}
export const getLog = () => LOG.join('\n');

/* ---- 알림 ---- */
let toastTimer;
export function toast(msg, ms = 3200) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/* ---- 음성 안내 ---- */
let voiceOn = true;
let lastSpoken = { text: '', at: 0 };
export function setVoice(on) {
  voiceOn = on;
  if (!on && 'speechSynthesis' in window) speechSynthesis.cancel();
}
export const voiceEnabled = () => voiceOn;
export function speak(text, { force = false } = {}) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  const t = nowMs();
  if (!force && lastSpoken.text === text && t - lastSpoken.at < 5000) return;
  lastSpoken = { text, at: t };
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    const ko = speechSynthesis.getVoices().find((v) => /^ko/i.test(v.lang));
    if (ko) u.voice = ko;
    speechSynthesis.speak(u);
  } catch {
    /* 음성이 안 되면 조용히 넘어가요 */
  }
}

/* ---- 공유(사진 앱 저장 / 파일 내보내기) ---- */
export async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      log(`공유 실패: ${e.message}`, 'error');
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}
