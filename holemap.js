// 홀 지도 그리기 (필드 모드 홀 화면 · 위치 찍기 화면 공용)
import { toLocal, fromLocal, bearing, haversine } from './util.js';
import { drawTiles, hasMapKey } from './maptiles.js';

const C = {
  bg: '#2B6139',
  rough: '#2F6B3E',
  fairway: '#5FAE58',
  green: '#8EDC7E',
  tee: '#76C36A',
  bunker: '#E7D7A3',
  water: '#3F86C4',
  orange: '#FF8A1F',
  yellow: '#F2C230',
  blue: '#3D8BFF',
  measure: '#7CC2FF',
};
export const TEE_HEX = { black: '#1E1E1E', blue: '#2F6FE4', white: '#F4F4F4', red: '#E24B4A', yellow: '#F2C230', gold: '#D4A017', green: '#3BA55C', silver: '#BFC4C8' };

export class HoleView {
  constructor(canvas) {
    this.cv = canvas;
    this.scene = {};
    this.T = null;
  }

  setScene(s) {
    this.scene = s;
  }

  dpr() {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  // 화면 크기와 보여 줄 범위를 정해요
  layout() {
    const cv = this.cv;
    const d = this.dpr();
    const W = Math.max(10, Math.round((cv.clientWidth || 300) * d));
    const H = Math.max(10, Math.round((cv.clientHeight || 400) * d));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const s = this.scene;
    let origin;
    let rot = 0;
    let cx = 0;
    let cy = 0;
    let sc;
    if (s.mode === 'free') {
      origin = s.center;
      sc = s.zoom * d;
    } else {
      const target = s.pin || s.green;
      const from = s.tee || s.shots?.[0]?.start || s.me;
      origin = from || target || s.me || s.center;
      if (!origin) {
        this.T = null;
        return null;
      }
      const up = from && target ? bearing(from, target) : 0;
      rot = (-up * Math.PI) / 180;
      const P = (p) => {
        const l = toLocal(origin, p);
        return { x: l.x * Math.cos(rot) - l.y * Math.sin(rot), y: l.x * Math.sin(rot) + l.y * Math.cos(rot) };
      };
      const nearMe = s.me && target && haversine(s.me, target) < 800 ? s.me : null;
      let pts;
      let minSpan = 90;
      if (nearMe && target && haversine(nearMe, target) < 100) {
        pts = [nearMe, target];
        minSpan = 70;
      } else {
        pts = [from, target, nearMe, s.open?.predicted, s.measure, ...(s.shots || []).flatMap((x) => [x.start, x.landing])].filter(Boolean);
        if (!from && !target && s.bounds) pts = [{ lat: s.bounds.minlat, lng: s.bounds.minlon }, { lat: s.bounds.maxlat, lng: s.bounds.maxlon }];
        if (!pts.length) pts = [origin];
      }
      const L = pts.map(P);
      const xs = L.map((p) => p.x);
      const ys = L.map((p) => p.y);
      const pad = 0.14;
      const spanX = Math.max(Math.max(...xs) - Math.min(...xs), minSpan * 0.5);
      const spanY = Math.max(Math.max(...ys) - Math.min(...ys), minSpan);
      cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      sc = Math.min((W * (1 - 2 * pad)) / spanX, (H * (1 - 2 * pad)) / spanY);
    }
    const P = (p) => {
      const l = toLocal(origin, p);
      return { x: l.x * Math.cos(rot) - l.y * Math.sin(rot), y: l.x * Math.sin(rot) + l.y * Math.cos(rot) };
    };
    const S = (p) => {
      const q = P(p);
      return { x: W / 2 + (q.x - cx) * sc, y: H / 2 - (q.y - cy) * sc };
    };
    const unS = (X, Y) => {
      const qx = (X - W / 2) / sc + cx;
      const qy = -(Y - H / 2) / sc + cy;
      return fromLocal(origin, qx * Math.cos(-rot) - qy * Math.sin(-rot), qx * Math.sin(-rot) + qy * Math.cos(-rot));
    };
    this.T = { W, H, S, unS, sc, d, rot, origin };
    return this.T;
  }

  // 화면을 누른 곳의 위경도
  pointAt(clientX, clientY) {
    if (!this.T) return null;
    const r = this.cv.getBoundingClientRect();
    return this.T.unS((clientX - r.left) * this.T.d, (clientY - r.top) * this.T.d);
  }

  draw(t = 0) {
    const T = this.layout();
    const g = this.cv.getContext('2d');
    const s = this.scene;
    if (!T) {
      g.fillStyle = C.bg;
      g.fillRect(0, 0, this.cv.width, this.cv.height);
      label(g, '위치를 찾는 중…', this.cv.width / 2, this.cv.height / 2, this.dpr(), 'center');
      return;
    }
    const { W, H, S, unS, sc, d } = T;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    const corners = [unS(0, 0), unS(W, 0), unS(0, H), unS(W, H)];
    const vecAvail = hasFeatures(s.feat, corners);
    const wantSat = s.style === 'sat' || (s.style !== 'map' && !vecAvail);
    let usedSat = false;
    let usedVec = false;
    if (wantSat && hasMapKey()) {
      usedSat = drawTiles(g, S, corners, sc) > 0;
      if (usedSat) {
        g.fillStyle = 'rgba(0,0,0,0.1)';
        g.fillRect(0, 0, W, H);
      }
    }
    if (!usedSat && vecAvail) {
      drawFeatures(g, S, s.feat);
      usedVec = true;
    }
    if (!usedSat && !usedVec && s.tee && (s.pin || s.green)) {
      // 그림이 없을 때 티 → 그린 띠
      const a = S(s.tee);
      const b = S(s.pin || s.green);
      g.strokeStyle = 'rgba(126,196,120,0.45)';
      g.lineWidth = 34 * sc;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    this.lastStyle = usedSat ? 'sat' : usedVec ? 'map' : 'plain';

    // 거리선 (50m 간격)
    const target = s.pin || s.green;
    const from = s.arcsFrom;
    if (from && s.mode !== 'free') {
      const a = S(from);
      const b = target ? S(target) : { x: a.x, y: a.y - 100 };
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const maxR = target ? haversine(from, target) + 40 : 400;
      g.lineWidth = 1.5 * d;
      for (let r = 50; r <= 400 && r <= maxR; r += 50) {
        const rp = r * sc;
        if (rp < 18 * d) continue;
        g.strokeStyle = 'rgba(255,255,255,0.55)';
        g.setLineDash([5 * d, 5 * d]);
        g.beginPath();
        g.arc(a.x, a.y, rp, ang - 0.9, ang + 0.9);
        g.stroke();
        g.setLineDash([]);
        const lx = a.x + rp * Math.cos(ang + 0.9);
        const ly = a.y + rp * Math.sin(ang + 0.9);
        pill(g, `${r}`, lx, ly, d, 'rgba(0,0,0,0.45)');
      }
    }

    // 티
    for (const te of s.tees || []) {
      const p = S(te);
      const sel = s.tee && te.lat === s.tee.lat && te.lng === s.tee.lng;
      const k = (sel ? 8 : 5) * d;
      g.fillStyle = TEE_HEX[te.color] || '#F4F4F4';
      g.fillRect(p.x - k, p.y - k * 0.7, k * 2, k * 1.4);
      g.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.4)';
      g.lineWidth = (sel ? 2 : 1) * d;
      g.strokeRect(p.x - k, p.y - k * 0.7, k * 2, k * 1.4);
    }
    if (s.tee && !(s.tees || []).length) {
      const p = S(s.tee);
      g.fillStyle = '#F4F4F4';
      g.fillRect(p.x - 7 * d, p.y - 5 * d, 14 * d, 10 * d);
    }

    // 핀
    if (target) flag(g, S(target), d, !!s.pin);

    // 지난 샷 (주황)
    for (const shot of s.shots || []) {
      if (!shot.start || !shot.landing) continue;
      const a = S(shot.start);
      const b = S(shot.landing);
      g.strokeStyle = C.orange;
      g.lineWidth = 3 * d;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      dot(g, a, 5 * d, C.orange, '#fff');
      dot(g, b, 6 * d, C.orange, '#fff');
      if (Number.isFinite(shot.dist)) pill(g, `${Math.round(shot.dist)}m`, (a.x + b.x) / 2 + 22 * d, (a.y + b.y) / 2, d, 'rgba(255,138,31,0.92)');
    }

    // 지금 치는 샷: 예상(노랑) + 출발점에서 나까지 실시간 거리
    const open = s.open;
    if (open?.start) {
      const a = S(open.start);
      if (open.predicted) {
        const p = S(open.predicted);
        if (open.spread) {
          g.strokeStyle = 'rgba(242,194,48,0.85)';
          g.setLineDash([4 * d, 4 * d]);
          g.lineWidth = 1.5 * d;
          g.beginPath();
          g.arc(p.x, p.y, Math.max(8 * d, open.spread * sc), 0, Math.PI * 2);
          g.stroke();
          g.setLineDash([]);
        }
        g.strokeStyle = 'rgba(242,194,48,0.7)';
        g.setLineDash([2 * d, 6 * d]);
        g.lineWidth = 2 * d;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(p.x, p.y);
        g.stroke();
        g.setLineDash([]);
        dot(g, p, 7 * d, C.yellow, '#fff');
      }
      if (s.me && haversine(open.start, s.me) > 4) {
        const m = S(s.me);
        g.strokeStyle = C.orange;
        g.setLineDash([8 * d, 6 * d]);
        g.lineWidth = 2.5 * d;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(m.x, m.y);
        g.stroke();
        g.setLineDash([]);
        pill(g, `${Math.round(haversine(open.start, s.me))}m`, (a.x + m.x) / 2 - 24 * d, (a.y + m.y) / 2, d, 'rgba(255,138,31,0.92)');
      }
      dot(g, a, 6 * d, C.orange, '#fff');
    }

    // 누른 곳 거리 (점선)
    if (s.measure && s.measureFrom) {
      const a = S(s.measureFrom);
      const m = S(s.measure);
      g.strokeStyle = C.measure;
      g.setLineDash([6 * d, 5 * d]);
      g.lineWidth = 2 * d;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(m.x, m.y);
      if (target) g.lineTo(S(target).x, S(target).y);
      g.stroke();
      g.setLineDash([]);
      dot(g, m, 6 * d, C.measure, '#fff');
      const d1 = haversine(s.measureFrom, s.measure);
      pill(g, `${Math.round(d1)}m${s.measureClub ? ` · ${s.measureClub}` : ''}`, (a.x + m.x) / 2, (a.y + m.y) / 2 - 12 * d, d, 'rgba(24,95,165,0.9)');
      if (target) {
        const tp = S(target);
        pill(g, `${Math.round(haversine(s.measure, target))}m`, (m.x + tp.x) / 2, (m.y + tp.y) / 2, d, 'rgba(24,95,165,0.9)');
      }
    }

    // 나
    if (s.me) {
      const m = S(s.me);
      if (Number.isFinite(s.heading)) {
        const hd = (s.heading * Math.PI) / 180 + (T.rot || 0);
        g.fillStyle = 'rgba(80,160,255,0.35)';
        g.beginPath();
        g.moveTo(m.x, m.y);
        g.arc(m.x, m.y, 26 * d, hd - Math.PI / 2 - 0.45, hd - Math.PI / 2 + 0.45);
        g.closePath();
        g.fill();
      }
      dot(g, m, 7 * d, C.blue, '#fff');
    }

    // 가운데 + 표시 (위치 찍기 화면)
    if (s.crosshair) {
      g.strokeStyle = '#F2B705';
      g.lineWidth = 3 * d;
      g.beginPath();
      g.moveTo(W / 2 - 16 * d, H / 2);
      g.lineTo(W / 2 + 16 * d, H / 2);
      g.moveTo(W / 2, H / 2 - 16 * d);
      g.lineTo(W / 2, H / 2 + 16 * d);
      g.stroke();
    }

    // 바람 결
    if (s.wind && Number.isFinite(s.wind.speed) && Number.isFinite(s.wind.from) && s.wind.speed > 0.2) windParticles(g, W, H, s.wind, T.rot || 0, t, d);

    // 축척·출처
    const want = (80 * d) / sc; // 화면에서 약 80px 길이가 되는 거리
    const meters = [10, 20, 50, 100, 200, 500].reduce((best, m) => (Math.abs(m - want) < Math.abs(best - want) ? m : best), 50);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 2 * d;
    g.beginPath();
    g.moveTo(10 * d, H - 12 * d);
    g.lineTo(10 * d + meters * sc, H - 12 * d);
    g.stroke();
    label(g, `${meters}m`, 12 * d, H - 18 * d, d, 'left');
    const credit = usedSat ? '지도 © 브이월드' : usedVec ? '© OpenStreetMap 기여자' : '';
    if (credit) label(g, credit, W - 8 * d, H - 8 * d, d, 'right', 10);
  }
}

function hasFeatures(feat, corners) {
  if (!feat) return false;
  const lats = corners.map((c) => c.lat);
  const lngs = corners.map((c) => c.lng);
  const b = { a: Math.min(...lats), b: Math.max(...lats), c: Math.min(...lngs), d: Math.max(...lngs) };
  for (const k of ['fairway', 'green', 'tee']) {
    for (const x of feat[k] || []) {
      for (const [la, ln] of x.pts) if (la >= b.a && la <= b.b && ln >= b.c && ln <= b.d) return true;
    }
  }
  return false;
}

function drawFeatures(g, S, feat) {
  g.fillStyle = C.rough;
  g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  const poly = (pts, fill) => {
    if (!pts?.length) return;
    g.beginPath();
    pts.forEach(([la, ln], i) => {
      const p = S({ lat: la, lng: ln });
      if (i === 0) g.moveTo(p.x, p.y);
      else g.lineTo(p.x, p.y);
    });
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  for (const x of feat.water || []) poly(x.pts, C.water);
  for (const x of feat.fairway || []) poly(x.pts, C.fairway);
  for (const x of feat.tee || []) poly(x.pts, C.tee);
  for (const x of feat.green || []) poly(x.pts, C.green);
  for (const x of feat.bunker || []) poly(x.pts, C.bunker);
}

function dot(g, p, r, fill, stroke) {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(p.x, p.y, r, 0, Math.PI * 2);
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = Math.max(1.5, r * 0.3);
    g.stroke();
  }
}
function flag(g, p, d, today) {
  g.strokeStyle = '#fff';
  g.lineWidth = 2 * d;
  g.beginPath();
  g.moveTo(p.x, p.y);
  g.lineTo(p.x, p.y - 22 * d);
  g.stroke();
  g.fillStyle = today ? '#E24B4A' : 'rgba(226,75,74,0.55)';
  g.beginPath();
  g.moveTo(p.x, p.y - 22 * d);
  g.lineTo(p.x + 13 * d, p.y - 17 * d);
  g.lineTo(p.x, p.y - 12 * d);
  g.closePath();
  g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(p.x, p.y, 2.5 * d, 0, Math.PI * 2);
  g.fill();
}
function label(g, text, x, y, d, align = 'center', size = 11) {
  g.font = `600 ${size * d}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  g.lineWidth = 3 * d;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.strokeText(text, x, y);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillText(text, x, y);
}
function pill(g, text, x, y, d, bg) {
  g.font = `700 ${12 * d}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
  const w = g.measureText(text).width + 12 * d;
  const h = 20 * d;
  g.fillStyle = bg;
  const r = 6 * d;
  const x0 = x - w / 2;
  const y0 = y - h / 2;
  g.beginPath();
  g.moveTo(x0 + r, y0);
  g.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
  g.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
  g.arcTo(x0, y0 + h, x0, y0, r);
  g.arcTo(x0, y0, x0 + w, y0, r);
  g.closePath();
  g.fill();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y + 0.5 * d);
  g.textBaseline = 'alphabetic';
}
function windParticles(g, W, H, wind, rot, t, d) {
  const to = ((wind.from + 180) * Math.PI) / 180 + rot;
  const vx = Math.sin(to);
  const vy = -Math.cos(to);
  const speedPx = (18 + wind.speed * 10) * d;
  const tt = t / 1000;
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 1.5 * d;
  for (let i = 0; i < 26; i += 1) {
    const sx = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
    const sy = Math.abs((Math.sin(i * 78.233) * 12345.678) % 1);
    const off = (tt * speedPx + i * 37) % (Math.max(W, H) * 1.4);
    const x = (((sx * W + vx * off) % W) + W) % W;
    const y = (((sy * H + vy * off) % H) + H) % H;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - vx * 10 * d, y - vy * 10 * d);
    g.stroke();
  }
}
