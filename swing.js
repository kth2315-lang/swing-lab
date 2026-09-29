// 스윙 분석 (화면·카메라와 무관한 순수 계산)
// 입력: 관절 좌표가 담긴 프레임 목록 [{t(초), lms[33]{x,y,z,v}, world[33]{x,y,z}}]
// 출력: 스윙 구간(어드레스·톱·임팩트·피니시)과 8대 지표

import { median, clamp } from './util.js';
import { grade, worseOf, METRIC_ORDER } from './refs.js';

const V_TH = 0.35; // 손이 '멈춰 있다'고 보는 속도 (몸통 길이/초)
const toDeg = (r) => (r * 180) / Math.PI;

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 });
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
function angle3(a, b, c) {
  const u = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const w = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
  const nu = Math.hypot(u.x, u.y, u.z);
  const nw = Math.hypot(w.x, w.y, w.z);
  if (!nu || !nw) return NaN;
  return toDeg(Math.acos(clamp((u.x * w.x + u.y * w.y + u.z * w.z) / (nu * nw), -1, 1)));
}
const vis = (p) => p?.v ?? p?.visibility ?? 1;

function smooth(pts, k = 2) {
  return pts.map((_, i) => {
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(pts.length - 1, i + k); j += 1) {
      sx += pts[j].x;
      sy += pts[j].y;
      c += 1;
    }
    return { x: sx / c, y: sy / c };
  });
}
function speeds(pts, t) {
  return pts.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(pts.length - 1, i + 1);
    const dt = t[b] - t[a];
    return dt > 0 ? d2(pts[a], pts[b]) / dt : 0;
  });
}
const idxIn = (t, lo, hi) => t.map((x, i) => (x >= lo && x <= hi ? i : -1)).filter((i) => i >= 0);
function argBest(idx, f, mode) {
  let best = -1;
  let bv = mode === 'max' ? -Infinity : Infinity;
  for (const i of idx) {
    const v = f(i);
    if (!Number.isFinite(v)) continue;
    if (mode === 'max' ? v > bv : v < bv) {
      bv = v;
      best = i;
    }
  }
  return best;
}

export function analyzeSwing(frames, opts = {}) {
  const { view = 'face', hand = 'R', vw = 720, vh = 1280, impactHint = null, short = false } = opts;
  const F = (frames || []).filter((f) => f && Array.isArray(f.lms) && f.lms.length >= 33).sort((a, b) => a.t - b.t);
  const fail = (reason) => ({ ok: false, reason, frames: F, view, hand, vw, vh, metrics: emptyMetrics(view) });
  if (F.length < 12) return fail('관절이 잡힌 장면이 너무 적어요. 전신이 나오게 다시 찍어 주세요.');

  const n = F.length;
  const t = F.map((f) => f.t);
  const P = (f, i) => ({ x: f.lms[i].x * vw, y: f.lms[i].y * vh, v: vis(f.lms[i]) });
  const headRaw = (f) => {
    const nose = P(f, 0);
    if (nose.v >= 0.5) return nose;
    const l = P(f, 7);
    const r = P(f, 8);
    if (l.v >= 0.5 && r.v >= 0.5) return mid(l, r);
    return l.v > r.v ? l : r.v >= 0.5 ? r : nose;
  };
  const hands = smooth(F.map((f) => mid(P(f, 15), P(f, 16))), 1);
  const hip = smooth(F.map((f) => mid(P(f, 23), P(f, 24))));
  const sh = smooth(F.map((f) => mid(P(f, 11), P(f, 12))));
  const head = smooth(F.map(headRaw));
  const torsoPx = median(sh.map((s, i) => d2(s, hip[i])));
  if (!torsoPx || torsoPx < 8) return fail('몸이 너무 작게 찍혔어요. 조금 더 가까이에서 찍어 주세요.');
  const spd = speeds(smooth(hands, 1), t).map((v) => v / torsoPx);

  // 1) 임팩트: 타구음 시각 근처에서 손이 가장 낮은 순간
  let iImp = -1;
  if (impactHint != null && Number.isFinite(impactHint)) {
    iImp = argBest(idxIn(t, impactHint - 0.35, impactHint + 0.25), (i) => hands[i].y, 'max');
  }
  if (iImp < 0) {
    const inner = [];
    for (let i = 2; i < n - 2; i += 1) inner.push(i);
    const iPeak = argBest(inner, (i) => spd[i], 'max');
    if (iPeak < 0) return fail('스윙 동작을 찾지 못했어요.');
    iImp = argBest(idxIn(t, t[iPeak] - 0.12, t[iPeak] + 0.12), (i) => hands[i].y, 'max');
  }
  if (iImp < 0) return fail('임팩트 순간을 찾지 못했어요.');

  // 2) 톱: 임팩트 전 손이 가장 높은 순간
  const iTop = argBest(idxIn(t, t[iImp] - 2.0, t[iImp] - 0.1), (i) => hands[i].y, 'min');
  if (iTop < 0) return fail('백스윙 톱을 찾지 못했어요. 스윙 시작부터 찍혔는지 확인해 주세요.');

  // 3) 테이크어웨이 시작: 백스윙 중 가장 빠른 지점에서 거꾸로 가며 손이 멈춰 있던 곳
  let iTake = 0;
  const bs = idxIn(t, t[iTop] - 1.6, t[iTop] - 0.05);
  if (bs.length) {
    let i = argBest(bs, (k) => spd[k], 'max');
    while (i > 1 && !(spd[i] < V_TH && spd[i - 1] < V_TH)) i -= 1;
    iTake = Math.max(0, i);
  }

  // 4) 피니시: 임팩트 후 손이 다시 멈추는 곳
  let iFin = n - 1;
  for (let i = iImp + 1; i < n - 1; i += 1) {
    const dt = t[i] - t[iImp];
    if (dt < 0.35) continue;
    if ((spd[i] < V_TH && spd[i + 1] < V_TH) || dt > 1.4) {
      iFin = i;
      break;
    }
  }

  const back = t[iTop] - t[iTake];
  const down = t[iImp] - t[iTop];
  const phasesOk = back >= 0.2 && back <= 2.5 && down >= 0.08 && down <= 0.9 && iTake < iTop;

  // 크기 환산 (픽셀 → 미터): 정면은 어깨 너비, 측후방은 몸통 길이 기준
  const W = (f, i) => f.world?.[i];
  const addrIdx = [];
  for (let i = Math.max(0, iTake - 4); i <= iTake; i += 1) addrIdx.push(i);
  let mpp = null;
  if (view === 'face') {
    const px = median(addrIdx.map((i) => d2(P(F[i], 11), P(F[i], 12))));
    const m = median(addrIdx.map((i) => (W(F[i], 11) && W(F[i], 12) ? d3(W(F[i], 11), W(F[i], 12)) : NaN)));
    if (px > 5) mpp = (m && m > 0.15 && m < 0.7 ? m : 0.36) / px;
  } else {
    const px = median(addrIdx.map((i) => d2(sh[i], hip[i])));
    const m = median(addrIdx.map((i) => {
      const f = F[i];
      if (!W(f, 11) || !W(f, 23)) return NaN;
      return d3(mid(W(f, 11), W(f, 12)), mid(W(f, 23), W(f, 24)));
    }));
    if (px > 5) mpp = (m && m > 0.25 && m < 0.9 ? m : 0.5) / px;
  }
  const cm = (px) => (mpp && Number.isFinite(px) ? px * mpp * 100 : null);

  const s = hand === 'R' ? 1 : -1; // 정면: 타깃 방향 / 측후방: 공 방향 (화면 x 기준)
  const A = iTake;
  const T = iTop;
  const I = iImp;
  const ctx = { short };
  const metrics = emptyMetrics(view);

  // 템포
  if (phasesOk) {
    const r = back / down;
    metrics.tempo = { value: r, grade: grade('tempo', r, ctx), text: `${r.toFixed(1)} : 1`, detail: `백스윙 ${back.toFixed(2)}초 · 다운스윙 ${down.toFixed(2)}초`, ctxShort: short };
  }

  const lean = (i) => toDeg(Math.atan2(s * (sh[i].x - hip[i].x), hip[i].y - sh[i].y));
  if (view === 'face') {
    const sway = cm(-s * (hip[T].x - hip[A].x));
    metrics.sway = { value: sway, grade: grade('sway', sway), text: sway == null ? '–' : `${sway >= 0 ? '뒤로' : '타깃 쪽으로'} ${Math.abs(sway).toFixed(1)}cm` };
    const rp = lean(T) - lean(A);
    metrics.reversePivot = { value: rp, grade: grade('reversePivot', rp), text: `${rp > 0 ? '타깃 쪽' : '뒤쪽'} ${Math.abs(rp).toFixed(1)}°`, detail: `어드레스 ${lean(A).toFixed(0)}° → 톱 ${lean(T).toFixed(0)}°` };
  } else {
    const spine = lean(I) - lean(A);
    const thrust = cm(s * (hip[I].x - hip[A].x));
    const sg = grade('spine', spine);
    const tg = grade('hipThrust', thrust);
    metrics.spine = {
      value: spine,
      grade: worseOf(sg, tg),
      text: `${spine < 0 ? '일어남' : '유지·숙임'} ${Math.abs(spine).toFixed(1)}°`,
      detail: `어드레스 ${lean(A).toFixed(0)}° → 임팩트 ${lean(I).toFixed(0)}° · 골반 공 쪽 ${thrust == null ? '–' : thrust.toFixed(1)}cm`,
      sub: { thrust, thrustGrade: tg, spineGrade: sg },
    };
  }

  // 머리 이동 (어드레스 ~ 임팩트)
  let maxH = 0;
  let maxV = 0;
  let dirH = 0;
  let dirV = 0;
  for (let i = A; i <= I; i += 1) {
    const dx = head[i].x - head[A].x;
    const dy = head[i].y - head[A].y;
    if (Math.abs(dx) > maxH) { maxH = Math.abs(dx); dirH = Math.sign(dx); }
    if (Math.abs(dy) > maxV) { maxV = Math.abs(dy); dirV = Math.sign(dy); }
  }
  const hCm = cm(maxH);
  const vCm = cm(maxV);
  const gH = grade('headH', hCm);
  const gV = grade('headV', vCm);
  const hWord = view === 'face' ? (dirH * s > 0 ? '타깃 쪽' : '뒤쪽') : dirH * s > 0 ? '공 쪽' : '뒤쪽';
  const vWord = dirV > 0 ? '아래' : '위';
  const hWorse = ['good', 'warn', 'bad'].indexOf(gH) >= ['good', 'warn', 'bad'].indexOf(gV);
  metrics.head = {
    value: hWorse ? hCm : vCm,
    grade: worseOf(gH, gV),
    text: `${view === 'face' ? '좌우' : '앞뒤'} ${hCm == null ? '–' : hCm.toFixed(1)}cm · 상하 ${vCm == null ? '–' : vCm.toFixed(1)}cm`,
    sub: { h: hCm, v: vCm, dirText: hWorse ? `${hWord}으로` : `${vWord}로` },
  };

  // 3D 좌표로 재는 지표 (구도와 상관없이 측정)
  const lead = hand === 'R' ? [11, 13, 15] : [12, 14, 16];
  const worldOk = (i) => F[i]?.world && lead.every((k) => F[i].world[k]);
  const arcVals = [T - 1, T, T + 1].filter((i) => i >= 0 && i < n && worldOk(i)).map((i) => {
    const w = F[i].world;
    const len = d3(w[lead[0]], w[lead[1]]) + d3(w[lead[1]], w[lead[2]]);
    return len > 0 ? (d3(w[lead[0]], w[lead[2]]) / len) * 100 : NaN;
  });
  const arc = median(arcVals);
  if (arc != null) metrics.arc = { value: arc, grade: grade('arc', arc), text: `${arc.toFixed(0)}%`, detail: '톱에서 리드 팔이 펴진 정도' };

  let cwIdx = idxIn(t, t[I] + 0.05, t[I] + 0.16).filter(worldOk);
  if (!cwIdx.length) cwIdx = [Math.min(n - 1, I + 2)].filter(worldOk);
  const cw = median(cwIdx.map((i) => angle3(F[i].world[lead[0]], F[i].world[lead[1]], F[i].world[lead[2]])));
  if (cw != null) metrics.chickenWing = { value: cw, grade: grade('chickenWing', cw), text: `${cw.toFixed(0)}°`, detail: '임팩트 직후 리드 팔꿈치 각도 (180° = 쭉 폄)' };

  return {
    ok: true,
    warning: phasesOk ? null : '스윙 구간을 정확히 찾지 못해 수치가 부정확할 수 있어요.',
    phases: {
      take: { i: A, t: t[A] },
      top: { i: T, t: t[T] },
      impact: { i: I, t: t[I] },
      finish: { i: iFin, t: t[iFin] },
    },
    metrics,
    mpp,
    frames: F,
    view,
    hand,
    vw,
    vh,
  };
}

function emptyMetrics(view) {
  const m = {};
  for (const k of METRIC_ORDER) m[k] = { value: null, grade: 'na', text: '–' };
  m.lag = { value: null, grade: 'na', text: '준비 중', detail: '클럽 인식 기능을 추가하면 측정해요' };
  if (view === 'face') m.spine = { value: null, grade: 'na', text: '측후방에서 측정', detail: '척추각은 옆 뒤(측후방) 영상에서 보여요' };
  else {
    m.sway = { value: null, grade: 'na', text: '정면에서 측정', detail: '스웨이는 정면 영상에서 보여요' };
    m.reversePivot = { value: null, grade: 'na', text: '정면에서 측정', detail: '리버스 피벗은 정면 영상에서 보여요' };
  }
  return m;
}

// 비교 기준으로 저장할 핵심 장면 (영상 대신 관절 좌표만)
export function keyframes(res) {
  if (!res?.ok) return null;
  const pick = (i) => res.frames[i].lms.map((p) => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) }));
  const out = { view: res.view, hand: res.hand, vw: res.vw, vh: res.vh };
  for (const k of ['take', 'top', 'impact', 'finish']) out[k] = pick(res.phases[k].i);
  return out;
}

// 저장용으로 지표 값만 추려요
export function metricValues(metrics) {
  const o = {};
  for (const k of METRIC_ORDER) {
    const m = metrics[k];
    if (!m) continue;
    o[k] = { value: m.value, grade: m.grade, text: m.text };
    if (m.sub) o[k].sub = m.sub;
  }
  return o;
}

// 가장 가까운 분석 프레임 찾기 (재생 중 관절 그리기용)
export function frameAt(frames, tt) {
  if (!frames?.length) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (frames[m].t < tt) lo = m;
    else hi = m;
  }
  const best = Math.abs(frames[lo].t - tt) <= Math.abs(frames[hi].t - tt) ? lo : hi;
  return Math.abs(frames[best].t - tt) < 0.12 ? frames[best] : null;
}
