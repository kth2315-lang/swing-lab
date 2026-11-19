// 스윙 트레이서 효과: ⚡번개 · 🔥화염 · 🔴레이저
// 투명한 캔버스에 효과만 그려요. 화면에서는 영상 위에 '스크린' 섞기로 겹치고,
// 저장할 때도 같은 방식으로 영상 위에 합쳐서 화면과 똑같이 보여요.
// trace: { points:[{t,x,y,v}] (0~1 좌표), phases:{take,top,impact,finish} }

export const FX_LIST = [
  { id: 'lightning', icon: '⚡', name: '번개' },
  { id: 'fire', icon: '🔥', name: '화염' },
  { id: 'laser', icon: '🔴', name: '레이저' },
];
export const fxName = (id) => FX_LIST.find((f) => f.id === id)?.name || '레이저';

// 같은 입력엔 늘 같은 값이 나오는 난수 (화면과 저장 영상이 똑같게)
function rnd(a, b = 0, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 지금 시각까지의 점들 + 지금 헤드 위치(점 사이를 이어서 부드럽게)
function visible(trace, time) {
  const pts = trace.points;
  const out = [];
  let head = null;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    if (p.t <= time) {
      out.push(p);
      continue;
    }
    const q = pts[i - 1];
    if (q) {
      const u = (time - q.t) / Math.max(1e-6, p.t - q.t);
      head = { t: time, x: q.x + (p.x - q.x) * u, y: q.y + (p.y - q.y) * u, v: q.v };
      out.push(head);
    }
    break;
  }
  if (!head && out.length) head = out[out.length - 1];
  return { pts: out, head };
}

const part = (ph, t) => (t <= ph.top ? 'back' : t <= ph.impact + 1e-6 ? 'down' : 'follow');

// 이어진 같은 구간끼리 묶기 (구간 경계 점은 양쪽에 넣어 끊김 없이)
function runs(pts, ph) {
  const res = [];
  let cur = null;
  for (const p of pts) {
    const k = part(ph, p.t);
    if (!cur || cur.k !== k) {
      const prev = cur?.pts[cur.pts.length - 1];
      cur = { k, pts: prev ? [prev] : [] };
      res.push(cur);
    }
    cur.pts.push(p);
  }
  return res;
}

function path(g, pts, W, H) {
  g.beginPath();
  if (!pts.length) return;
  g.moveTo(pts[0].x * W, pts[0].y * H);
  // 부드러운 곡선 (중점 연결)
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = ((pts[i].x + pts[i + 1].x) / 2) * W;
    const my = ((pts[i].y + pts[i + 1].y) / 2) * H;
    g.quadraticCurveTo(pts[i].x * W, pts[i].y * H, mx, my);
  }
  const l = pts[pts.length - 1];
  g.lineTo(l.x * W, l.y * H);
}

function glowStroke(g, pts, W, H, layers) {
  for (const [color, width, alpha] of layers) {
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = width;
    path(g, pts, W, H);
    g.stroke();
  }
  g.globalAlpha = 1;
}

function headGlow(g, x, y, r, color, core = '#FFFFFF') {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, core);
  gr.addColorStop(0.25, color);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

function impactFlash(g, trace, time, W, H, u, color) {
  const ph = trace.phases;
  const dt = time - ph.impact;
  if (dt < 0 || dt > 0.5) return null;
  const p = visible(trace, ph.impact).head;
  if (!p) return null;
  const k = dt / 0.5;
  const x = p.x * W;
  const y = p.y * H;
  g.globalAlpha = (1 - k) * 0.9;
  headGlow(g, x, y, (14 + 70 * k) * u, color);
  g.globalAlpha = (1 - k) * 0.8;
  g.strokeStyle = color;
  g.lineWidth = (3 - 2 * k) * u;
  g.beginPath();
  g.arc(x, y, (10 + 90 * k) * u, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 1;
  return { x, y, k };
}

/* ---------------- 🔴 레이저 ---------------- */
function laser(g, trace, time, W, H, u) {
  const { pts, head } = visible(trace, time);
  if (pts.length < 2) return;
  const col = { back: ['#22D3FF', '#7DEBFF'], down: ['#FF1744', '#FF6B81'], follow: ['#FF2D95', '#FF8AC4'] };
  for (const r of runs(pts, trace.phases)) {
    const [c1, c2] = col[r.k];
    const big = r.k === 'down' ? 1.35 : r.k === 'back' ? 0.85 : 0.7;
    const fade = r.k === 'follow' ? 0.65 : 1;
    glowStroke(g, r.pts, W, H, [
      [c1, 26 * u * big, 0.16 * fade],
      [c1, 12 * u * big, 0.42 * fade],
      [c2, 5.5 * u * big, 0.85 * fade],
      ['#FFFFFF', 2.2 * u * big, 0.95 * fade],
    ]);
  }
  if (head && time <= trace.phases.finish + 0.4) {
    const k = part(trace.phases, head.t);
    headGlow(g, head.x * W, head.y * H, (k === 'down' ? 26 : 18) * u, k === 'back' ? 'rgba(34,211,255,0.8)' : 'rgba(255,23,68,0.85)');
  }
  impactFlash(g, trace, time, W, H, u, 'rgba(255,60,90,0.9)');
}

/* ---------------- ⚡ 번개 ---------------- */
// 두 점 사이를 지그재그로 쪼개요 (중간점 흔들기)
function bolt(out, x1, y1, x2, y2, amp, depth, seed) {
  if (depth === 0) {
    out.push(x2, y2);
    return;
  }
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const off = (rnd(seed, depth, 7) - 0.5) * 2 * amp;
  const px = mx + nx * off;
  const py = my + ny * off;
  bolt(out, x1, y1, px, py, amp * 0.55, depth - 1, seed * 3 + 1);
  bolt(out, px, py, x2, y2, amp * 0.55, depth - 1, seed * 3 + 2);
}

function strokeFlat(g, arr, layers) {
  for (const [color, width, alpha] of layers) {
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(arr[0], arr[1]);
    for (let i = 2; i < arr.length; i += 2) g.lineTo(arr[i], arr[i + 1]);
    g.stroke();
  }
  g.globalAlpha = 1;
}

function lightning(g, trace, time, W, H, u) {
  const { pts, head } = visible(trace, time);
  if (pts.length < 2) return;
  const flick = Math.floor(time * 24); // 1초에 24번 모양이 바뀌어요
  const col = { back: ['#7C6CFF', '#C9C2FF'], down: ['#3BE8FF', '#E8FDFF'], follow: ['#9C7BFF', '#E2D9FF'] };
  const ph = trace.phases;
  // 점을 적당한 간격으로 다시 골라요 (너무 촘촘하면 번개가 잘게 떨려요)
  const sel = [pts[0]];
  for (let i = 1; i < pts.length; i += 1) {
    const a = sel[sel.length - 1];
    const b = pts[i];
    if (Math.hypot((b.x - a.x) * W, (b.y - a.y) * H) > 14 * u || i === pts.length - 1) sel.push(b);
  }
  for (const r of runs(sel, ph)) {
    const [c1, c2] = col[r.k];
    const big = r.k === 'down' ? 1.3 : r.k === 'back' ? 0.9 : 0.75;
    const fade = r.k === 'follow' ? 0.6 : 1;
    const arr = [r.pts[0].x * W, r.pts[0].y * H];
    const n = r.pts.length;
    for (let i = 1; i < n; i += 1) {
      const a = r.pts[i - 1];
      const b = r.pts[i];
      const len = Math.hypot((b.x - a.x) * W, (b.y - a.y) * H);
      const seed = Math.round(a.t * 1000) * 31 + flick;
      bolt(arr, a.x * W, a.y * H, b.x * W, b.y * H, Math.min(16 * u, len * 0.35), 3, seed);
    }
    strokeFlat(g, arr, [
      [c1, 18 * u * big, 0.14 * fade],
      [c1, 8 * u * big, 0.38 * fade],
      [c2, 3.2 * u * big, 0.9 * fade],
      ['#FFFFFF', 1.4 * u * big, 1 * fade],
    ]);
    // 곁가지
    for (let i = 1; i < n; i += 1) {
      const a = r.pts[i];
      if (rnd(Math.round(a.t * 1000), flick, 3) > (r.k === 'down' ? 0.55 : 0.75)) continue;
      const ang = rnd(Math.round(a.t * 1000), flick, 5) * Math.PI * 2;
      const len = (18 + 30 * rnd(Math.round(a.t * 1000), flick, 9)) * u * big;
      const br = [a.x * W, a.y * H];
      bolt(br, a.x * W, a.y * H, a.x * W + Math.cos(ang) * len, a.y * H + Math.sin(ang) * len, len * 0.3, 2, Math.round(a.t * 1000) + flick * 7);
      strokeFlat(g, br, [
        [c1, 5 * u, 0.35 * fade],
        [c2, 1.6 * u, 0.85 * fade],
      ]);
    }
  }
  if (head && time <= ph.finish + 0.4) {
    const k = part(ph, head.t);
    const x = head.x * W;
    const y = head.y * H;
    headGlow(g, x, y, (k === 'down' ? 30 : 20) * u, k === 'back' ? 'rgba(124,108,255,0.85)' : 'rgba(59,232,255,0.9)');
    // 헤드 둘레 잔 전기
    for (let s = 0; s < 4; s += 1) {
      const ang = rnd(flick, s, 11) * Math.PI * 2;
      const len = (10 + 16 * rnd(flick, s, 13)) * u;
      const br = [x, y];
      bolt(br, x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, len * 0.35, 2, flick * 13 + s);
      strokeFlat(g, br, [['#E8FDFF', 1.3 * u, 0.9]]);
    }
  }
  // 임팩트: 번쩍 + 사방으로 번개
  const fl = impactFlash(g, trace, time, W, H, u, 'rgba(120,240,255,0.95)');
  if (fl) {
    for (let s = 0; s < 9; s += 1) {
      const ang = (s / 9) * Math.PI * 2 + rnd(s, 1, 2) * 0.6;
      const len = (40 + 70 * rnd(s, 3, 4)) * u * (0.4 + fl.k);
      const br = [fl.x, fl.y];
      bolt(br, fl.x, fl.y, fl.x + Math.cos(ang) * len, fl.y + Math.sin(ang) * len, len * 0.3, 3, s * 17 + flick);
      strokeFlat(g, br, [
        ['#3BE8FF', 6 * u, 0.4 * (1 - fl.k)],
        ['#FFFFFF', 1.8 * u, 1 - fl.k],
      ]);
    }
  }
}

/* ---------------- 🔥 화염 ---------------- */
const sprites = {};
function sprite(color) {
  if (sprites[color]) return sprites[color];
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(64, 64) : document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, color);
  gr.addColorStop(0.35, color.replace(/[\d.]+\)$/, '0.55)'));
  gr.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  sprites[color] = c;
  return c;
}
const FIRE = ['rgba(255,250,220,1)', 'rgba(255,214,90,1)', 'rgba(255,140,30,1)', 'rgba(235,70,20,1)', 'rgba(150,30,10,1)'];

function fire(g, trace, time, W, H, u) {
  const { pts, head } = visible(trace, time);
  if (pts.length < 2) return;
  const ph = trace.phases;
  const flick = time * 18;
  // 1) 불길 띠 (지나간 길이 계속 타올라요)
  for (const r of runs(pts, ph)) {
    const big = r.k === 'down' ? 1.3 : r.k === 'back' ? 0.85 : 0.7;
    const fade = r.k === 'follow' ? 0.6 : 1;
    const wob = 1 + 0.12 * Math.sin(flick);
    glowStroke(g, r.pts, W, H, [
      ['#B3200A', 30 * u * big * wob, 0.18 * fade],
      ['#FF5A14', 15 * u * big, 0.38 * fade],
      ['#FFB02E', 6.5 * u * big, 0.75 * fade],
      ['#FFF6D8', 2.4 * u * big, 0.9 * fade],
    ]);
  }
  // 2) 불꽃 알갱이: 지나간 자리마다 정해진 수만큼 피어올라 사라져요
  const scale = Math.min(W, H);
  let drawn = 0;
  for (let i = pts.length - 1; i >= 0 && drawn < 700; i -= 1) {
    const p = pts[i];
    const age0 = time - p.t;
    if (age0 > 1.1) break;
    const k = part(ph, p.t);
    const nPer = k === 'down' ? 4 : 2;
    const id = Math.round(p.t * 2000);
    for (let j = 0; j < nPer; j += 1) {
      const life = 0.35 + 0.6 * rnd(id, j, 1);
      if (age0 > life || age0 < 0) continue;
      const a = age0 / life;
      const vx = (rnd(id, j, 2) - 0.5) * 0.12 * scale;
      const vy = -(0.18 + 0.25 * rnd(id, j, 3)) * scale;
      const x = p.x * W + (rnd(id, j, 4) - 0.5) * 10 * u + vx * age0;
      const y = p.y * H + (rnd(id, j, 5) - 0.5) * 10 * u + vy * age0 + 0.1 * scale * age0 * age0;
      const s = (k === 'down' ? 16 : 11) * u * (1 - a * 0.7) * (0.6 + 0.6 * rnd(id, j, 6));
      const ci = Math.min(FIRE.length - 1, Math.floor(a * FIRE.length));
      g.globalAlpha = (1 - a) * 0.9;
      g.drawImage(sprite(FIRE[ci]), x - s, y - s, s * 2, s * 2);
      drawn += 1;
    }
  }
  // 3) 튀는 불똥 (오래 날아가는 작은 점)
  for (let i = pts.length - 1; i >= 0; i -= 3) {
    const p = pts[i];
    const age0 = time - p.t;
    if (age0 > 1.4) break;
    const id = Math.round(p.t * 2000);
    if (rnd(id, 9, 1) > 0.45) continue;
    const life = 0.6 + 0.8 * rnd(id, 9, 2);
    if (age0 > life) continue;
    const a = age0 / life;
    const ang = rnd(id, 9, 3) * Math.PI * 2;
    const sp = (0.15 + 0.35 * rnd(id, 9, 4)) * scale;
    const x = p.x * W + Math.cos(ang) * sp * age0;
    const y = p.y * H + Math.sin(ang) * sp * age0 + 0.35 * scale * age0 * age0;
    g.globalAlpha = 1 - a;
    g.drawImage(sprite(FIRE[a < 0.5 ? 1 : 2]), x - 3 * u, y - 3 * u, 6 * u, 6 * u);
  }
  g.globalAlpha = 1;
  if (head && time <= ph.finish + 0.4) {
    const k = part(ph, head.t);
    headGlow(g, head.x * W, head.y * H, (k === 'down' ? 30 : 20) * u, 'rgba(255,150,40,0.9)', '#FFF8E0');
  }
  // 임팩트: 불꽃 폭발
  const fl = impactFlash(g, trace, time, W, H, u, 'rgba(255,170,60,0.95)');
  if (fl) {
    for (let s = 0; s < 40; s += 1) {
      const ang = rnd(s, 21, 1) * Math.PI * 2;
      const sp = (0.2 + 0.5 * rnd(s, 21, 2)) * scale;
      const t = fl.k * 0.5;
      const x = fl.x + Math.cos(ang) * sp * t;
      const y = fl.y + Math.sin(ang) * sp * t + 0.4 * scale * t * t;
      const sz = (8 + 10 * rnd(s, 21, 3)) * u * (1 - fl.k);
      g.globalAlpha = 1 - fl.k;
      g.drawImage(sprite(FIRE[Math.min(4, Math.floor(fl.k * 4 + rnd(s, 21, 4)))]), x - sz, y - sz, sz * 2, sz * 2);
    }
    g.globalAlpha = 1;
  }
}

const DRAW = { laser, lightning, fire };

// 효과 한 장면 그리기. g: 투명 캔버스(W×H = 영상이 보이는 크기), time: 영상 시각(초)
export function drawFx(g, W, H, trace, fx, time) {
  g.clearRect(0, 0, W, H);
  if (!trace?.ok || !trace.points.length) return;
  if (time < trace.points[0].t) return;
  const u = Math.max(0.6, Math.min(W, H) / 420); // 굵기 기준
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  (DRAW[fx] || laser)(g, trace, time, W, H, u);
  g.restore();
}
