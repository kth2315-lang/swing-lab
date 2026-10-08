// 필드 모드: 위치, 바람, 클럽 추천, 착탄군, 미니맵
import { log, haversine, bearing, angleDiff, clamp, mean, sd, median, destination } from './util.js';
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

  // 지금 서 있는 곳 근처의 최근 위치만 정확도로 가중 평균해서 흔들림을 줄여요
  // (걸어오는 동안의 위치가 섞이지 않게 마지막 위치 주변 것만 써요)
  best() {
    const last = this.last;
    if (!last) return null;
    const near = Math.max(8, (last.acc || 10) * 1.5);
    const r = this.recent.filter((f) => Date.now() - f.at < 8000 && haversine(f, last) <= near);
    if (!r.length) return last;
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

/* ---------- 예상 낙하지점 (v1.2) ---------- */
// 클럽별 대략적인 발사각(도)과 체공 시간(초) — 아마추어 평균에 가까운 값
export const LAUNCH = { DR: 12, '3W': 11, '5W': 13, UT: 14, '5I': 15, '6I': 16, '7I': 18, '8I': 20, '9I': 22, PW: 25, AW: 28, SW: 32 };
export const HANG = { DR: 6.0, '3W': 5.6, '5W': 5.4, UT: 5.2, '5I': 5.1, '6I': 5.0, '7I': 5.0, '8I': 4.9, '9I': 4.8, PW: 4.6, AW: 4.4, SW: 4.2 };

// start에서 aimBrg 방향으로 친다고 볼 때 공이 떨어질 곳
// phiDeg: 출발 방향(+ 오른쪽), lenK: 거리 느낌(짧게 0.85 ~ 멀리 1.1)
export function predictShot({ start, aimBrg, club, carry, wind, phiDeg = 0, lenK = 1, stats }) {
  if (!start || !Number.isFinite(aimBrg) || !Number.isFinite(carry)) return null;
  let along = 0;
  let cross = 0;
  if (wind && Number.isFinite(wind.speed) && Number.isFinite(wind.from)) {
    const to = (wind.from + 180) % 360;
    const rel = (angleDiff(to, aimBrg) * Math.PI) / 180;
    along = wind.speed * Math.cos(rel); // + 뒷바람
    cross = wind.speed * Math.sin(rel); // + 오른쪽으로 부는 바람
  }
  const windPct = along < 0 ? -along * 0.022 : -along * 0.011; // + 이면 짧아짐
  const dist = carry * lenK * (1 - windPct);
  const launchLat = dist * Math.tan((phiDeg * Math.PI) / 180);
  const drift = 0.4 * cross * (HANG[club] || 5);
  const list = (stats?.[club] || []).slice(-30);
  const res = list.map((x) => x.res).filter((x) => Number.isFinite(x));
  const habit = res.length >= 3 ? mean(res) : 0;
  const lat = launchLat + drift + habit;
  const point = destination(start, aimBrg + (Math.atan2(lat, dist) * 180) / Math.PI, Math.hypot(dist, lat));
  const spreadSd = res.length >= 5 ? sd(res) : null;
  return { point, lat, base: launchLat + drift, dist, spread: spreadSd ? Math.max(6, spreadSd) : null };
}

export { haversine, bearing, clamp };
