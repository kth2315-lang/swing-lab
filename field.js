// 필드 모드: 위치, 바람, 클럽 추천, 착탄군, 미니맵
import { log, haversine, bearing, toLocal, angleDiff, clamp, mean, sd, median, destination } from './util.js';
import { CLUBS } from './refs.js';

/* ---------- 위치 ---------- */
export class Geo {
  constructor(onFix) {
    this.onFix = onFix;
    this.id = null;
    this.last = null;
    this.recent = [];
    this.heading = null;
    this.onOrient = (e) => {
      const h = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
      if (h != null && Number.isFinite(h)) this.heading = h;
    };
  }

  start() {
    if (this.id != null || !('geolocation' in navigator)) return;
    this.id = navigator.geolocation.watchPosition(
      (p) => {
        const fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, at: Date.now() };
        this.last = fix;
        this.recent.push(fix);
        if (this.recent.length > 8) this.recent.shift();
        this.onFix?.(fix);
      },
      (e) => log(`위치를 못 받았어요 (${e.message})`, 'error'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    window.addEventListener('deviceorientation', this.onOrient);
  }

  stop() {
    if (this.id != null) navigator.geolocation.clearWatch(this.id);
    this.id = null;
    window.removeEventListener('deviceorientation', this.onOrient);
  }

  // 최근 몇 번의 위치를 정확도로 가중 평균해서 흔들림을 줄여요
  best() {
    const r = this.recent.filter((f) => Date.now() - f.at < 20000);
    if (!r.length) return this.last;
    let w = 0;
    let lat = 0;
    let lng = 0;
    for (const f of r) {
      const k = 1 / Math.max(3, f.acc || 10) ** 2;
      w += k;
      lat += f.lat * k;
      lng += f.lng * k;
    }
    return { lat: lat / w, lng: lng / w, acc: Math.min(...r.map((f) => f.acc || 99)) };
  }
}

export async function askCompass() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      return (await DOE.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return !!DOE;
}

/* ---------- 바람·고도 (Open-Meteo, 사용자가 허락했을 때만) ---------- */
const round2 = (x) => Math.round(x * 100) / 100; // 약 1km 단위로 뭉개서 보내요
export async function fetchWind(pos) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${round2(pos.lat)}&longitude=${round2(pos.lng)}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms&timezone=auto`;
  const r = await fetch(u, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error(`바람 정보를 못 받았어요 (${r.status})`);
  const j = await r.json();
  const c = j.current || {};
  return { speed: c.wind_speed_10m, from: c.wind_direction_10m, gust: c.wind_gusts_10m, at: Date.now(), source: 'auto' };
}
// 고도 지도는 약 90m 간격이라 약 100m 단위(소수 셋째 자리)로만 보내요
const round3 = (x) => Math.round(x * 1000) / 1000;
export async function fetchElevations(points) {
  const lat = points.map((p) => round3(p.lat)).join(',');
  const lng = points.map((p) => round3(p.lng)).join(',');
  const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error(`고도 정보를 못 받았어요 (${r.status})`);
  const j = await r.json();
  return j.elevation || [];
}

/* ---------- 클럽 거리와 착탄군 ---------- */
export function clubSummary(stats, clubId) {
  const list = (stats?.[clubId] || []).slice(-40);
  const d = list.map((x) => x.dist);
  const lat = list.map((x) => x.lat).filter((x) => Number.isFinite(x));
  return { n: list.length, dist: median(d), lat: mean(lat), latSd: sd(lat), nLat: lat.length };
}
export function bagDistances(profile, stats) {
  return CLUBS.map((c) => {
    const s = clubSummary(stats, c.id);
    const base = profile?.clubs?.[c.id] ?? c.carry;
    return { ...c, base, learned: s.n >= 3 ? s.dist : null, use: s.n >= 3 ? s.dist : base, summary: s };
  });
}

// 체감 거리: 맞바람 1m/s당 약 +2.2%, 뒷바람 1m/s당 약 -1.1%, 오르막 1m당 +1m
export function playsLike(dist, wind, shotBrg, elevDelta = 0) {
  let along = 0;
  if (wind && Number.isFinite(wind.speed) && Number.isFinite(wind.from) && Number.isFinite(shotBrg)) {
    const to = (wind.from + 180) % 360;
    along = wind.speed * Math.cos((angleDiff(to, shotBrg) * Math.PI) / 180); // + 뒷바람
  }
  const windPct = along < 0 ? -along * 0.022 : -along * 0.011;
  const pl = dist * (1 + windPct) + (Number.isFinite(elevDelta) ? elevDelta : 0);
  return { playsLike: pl, along, windPct };
}
export function recommend(target, bag) {
  const sorted = [...bag].sort((a, b) => a.use - b.use);
  return sorted.find((c) => c.use >= target - 4) || sorted[sorted.length - 1];
}

// 공이 실제로 떨어진 곳이 확인되면 그 클럽의 기록으로 쌓아요
export function shotOutcome(shot, landing) {
  const dist = haversine(shot.start, landing);
  if (!Number.isFinite(dist) || dist < 3) return null;
  let lat = null;
  if (Number.isFinite(shot.aimBrg)) {
    const b = bearing(shot.start, landing);
    lat = dist * Math.sin((angleDiff(b, shot.aimBrg) * Math.PI) / 180); // + 오른쪽
  }
  return { dist, lat };
}

// 예상 낙하지점 (내 평균 거리 + 방향 선택)
export function predictLanding(start, aimBrg, dist, dirOffset = 0, summary = null) {
  if (!start || !Number.isFinite(aimBrg) || !Number.isFinite(dist)) return null;
  const lat = dirOffset + (summary && summary.nLat >= 5 ? summary.lat : 0);
  const b = aimBrg + (Math.atan2(lat, dist) * 180) / Math.PI;
  return destination(start, b, Math.hypot(dist, lat));
}

/* ---------- 미니맵 ---------- */
export function drawMinimap(canvas, s, anim) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = canvas.clientWidth || 300;
  const ch = canvas.clientHeight || 300;
  if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
  if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  g.fillStyle = '#1F5332';
  g.fillRect(0, 0, W, H);

  const pts = [s.tee, s.green, s.me, ...(s.shots || []).flatMap((x) => [x.start, x.landing]), s.predicted].filter(Boolean);
  if (!pts.length) {
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = `${14 * dpr}px -apple-system, sans-serif`;
    g.textAlign = 'center';
    g.fillText('위치를 찾는 중…', W / 2, H / 2);
    return;
  }
  const origin = s.tee || s.shots?.[0]?.start || s.me || pts[0];
  const up = s.tee && s.green ? bearing(s.tee, s.green) : 0; // 홀 방향을 위로
  const rot = (-up * Math.PI) / 180;
  const P = (p) => {
    const l = toLocal(origin, p);
    return { x: l.x * Math.cos(rot) - l.y * Math.sin(rot), y: l.x * Math.sin(rot) + l.y * Math.cos(rot) };
  };
  const L = pts.map(P);
  let minX = Math.min(...L.map((p) => p.x)) - 25;
  let maxX = Math.max(...L.map((p) => p.x)) + 25;
  let minY = Math.min(...L.map((p) => p.y)) - 25;
  let maxY = Math.max(...L.map((p) => p.y)) + 25;
  const span = Math.max(maxX - minX, maxY - minY, 80);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  minX = cx - span / 2;
  maxX = cx + span / 2;
  minY = cy - span / 2;
  maxY = cy + span / 2;
  const sc = (Math.min(W, H) * 0.9) / span;
  const S = (p) => {
    const q = P(p);
    return { x: W / 2 + (q.x - cx) * sc, y: H / 2 - (q.y - cy) * sc };
  };

  // 페어웨이 띠와 그린
  if (s.tee && s.green) {
    const a = S(s.tee);
    const b = S(s.green);
    g.strokeStyle = 'rgba(126,196,120,0.55)';
    g.lineWidth = 34 * sc;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  }
  if (s.green) {
    const b = S(s.green);
    g.fillStyle = '#8FD68A';
    g.beginPath();
    g.arc(b.x, b.y, Math.max(8 * dpr, 13 * sc), 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.moveTo(b.x, b.y);
    g.lineTo(b.x, b.y - 18 * dpr);
    g.stroke();
    g.fillStyle = '#D2283C';
    g.beginPath();
    g.moveTo(b.x, b.y - 18 * dpr);
    g.lineTo(b.x + 10 * dpr, b.y - 14 * dpr);
    g.lineTo(b.x, b.y - 10 * dpr);
    g.fill();
  }
  if (s.tee) {
    const a = S(s.tee);
    g.fillStyle = '#E8F1E4';
    g.fillRect(a.x - 7 * dpr, a.y - 5 * dpr, 14 * dpr, 10 * dpr);
  }

  // 지난 샷들
  for (const shot of s.shots || []) {
    if (!shot.start) continue;
    const a = S(shot.start);
    if (shot.landing) {
      const b = S(shot.landing);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 2 * dpr;
      g.setLineDash([]);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.quadraticCurveTo((a.x + b.x) / 2 + (b.y - a.y) * 0.08, (a.y + b.y) / 2 - (b.x - a.x) * 0.08, b.x, b.y);
      g.stroke();
      dot(g, b, 5 * dpr, '#D2283C');
    }
  }
  // 그린을 아직 모를 때: 마지막 샷 출발점에서 지금 위치(공 있는 곳)까지 점선
  if (!s.predicted && s.lastStart && s.me) {
    const a = S(s.lastStart);
    const m = S(s.me);
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.setLineDash([6 * dpr, 5 * dpr]);
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(m.x, m.y);
    g.stroke();
    g.setLineDash([]);
  }
  // 예상 낙하지점과 착탄 범위
  if (s.predicted) {
    const p = S(s.predicted);
    if (s.spread && s.spread > 0) {
      g.strokeStyle = 'rgba(242,183,5,0.8)';
      g.setLineDash([5 * dpr, 4 * dpr]);
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      g.arc(p.x, p.y, s.spread * sc, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    if (s.lastStart) {
      const a = S(s.lastStart);
      g.strokeStyle = 'rgba(242,183,5,0.9)';
      g.setLineDash([6 * dpr, 5 * dpr]);
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(p.x, p.y);
      g.stroke();
      g.setLineDash([]);
    }
    dot(g, p, 6 * dpr, '#F2B705');
  }
  // 나 (골퍼)
  if (s.me) {
    const m = S(s.me);
    if (Number.isFinite(s.heading)) {
      const hd = ((s.heading - up) * Math.PI) / 180;
      g.fillStyle = 'rgba(80,160,255,0.35)';
      g.beginPath();
      g.moveTo(m.x, m.y);
      g.arc(m.x, m.y, 26 * dpr, hd - Math.PI / 2 - 0.45, hd - Math.PI / 2 + 0.45);
      g.closePath();
      g.fill();
    }
    dot(g, m, 7 * dpr, '#3D8BFF', '#fff');
  }

  // 바람 결
  if (s.wind && Number.isFinite(s.wind.speed) && Number.isFinite(s.wind.from) && s.wind.speed > 0.2) {
    const to = ((s.wind.from + 180 - up) * Math.PI) / 180;
    const vx = Math.sin(to);
    const vy = -Math.cos(to);
    const n = 26;
    const speedPx = (18 + s.wind.speed * 10) * dpr;
    const t = (anim || 0) / 1000;
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1.5 * dpr;
    for (let i = 0; i < n; i += 1) {
      const seedX = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const seedY = (Math.sin(i * 78.233) * 12345.678) % 1;
      const base = { x: Math.abs(seedX) * W, y: Math.abs(seedY) * H };
      const off = (t * speedPx + i * 37) % (Math.max(W, H) * 1.4);
      const x = (((base.x + vx * off) % W) + W) % W;
      const y = (((base.y + vy * off) % H) + H) % H;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - vx * 10 * dpr, y - vy * 10 * dpr);
      g.stroke();
    }
  }
  // 축척
  const meters = span > 400 ? 100 : span > 150 ? 50 : 20;
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 2 * dpr;
  g.beginPath();
  g.moveTo(10 * dpr, H - 12 * dpr);
  g.lineTo(10 * dpr + meters * sc, H - 12 * dpr);
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = `${11 * dpr}px -apple-system, sans-serif`;
  g.textAlign = 'left';
  g.fillText(`${meters}m`, 12 * dpr, H - 18 * dpr);
}

function dot(g, p, r, fill, stroke) {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(p.x, p.y, r, 0, Math.PI * 2);
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = r * 0.35;
    g.stroke();
  }
}

export { haversine, bearing, clamp };
