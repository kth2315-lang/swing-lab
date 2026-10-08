// 오픈스트리트맵(무료 세계 지도)에서 골프장 자료 받기
// 보내는 것: 검색한 단어 또는 '내 주변 몇 km' 범위, 고른 골프장의 범위뿐이에요.
import { log, haversine } from './util.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const KOREA = '33.0,124.5,38.7,131.0';

async function overpass(q, timeoutMs = 30000) {
  let lastErr = null;
  for (const ep of ENDPOINTS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(ep, {
        method: 'POST',
        body: `data=${encodeURIComponent(q)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (r.ok) return await r.json();
      lastErr = new Error(`지도 서버 응답 ${r.status}`);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr || new Error('지도 서버에 연결하지 못했어요');
}

const esc = (s) => s.replace(/[\\.*+?^${}()|[\]"]/g, '\\$&');

function courseItem(e, near) {
  const lat = e.center?.lat ?? e.lat;
  const lng = e.center?.lon ?? e.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const t = e.tags || {};
  const item = { osmType: e.type, osmId: e.id, name: t.name || t['name:ko'] || t['name:en'] || '이름 없는 골프장', lat, lng };
  if (near) item.dist = haversine(near, { lat, lng });
  return item;
}

// 내 주변(기본 10km) 골프장
export async function coursesNear(pos, radius = 10000) {
  const q = `[out:json][timeout:20];nwr["leisure"="golf_course"](around:${radius},${pos.lat},${pos.lng});out center tags;`;
  const j = await overpass(q);
  return dedupe(j.elements.map((e) => courseItem(e, pos)).filter(Boolean)).sort((a, b) => a.dist - b.dist);
}

// 이름 한 단어로 찾기 (전국)
export async function coursesByName(word) {
  const w = esc(word.trim());
  if (!w) return [];
  const f = (k) => `nwr["leisure"="golf_course"]["${k}"~"${w}",i](${KOREA});`;
  const q = `[out:json][timeout:25];(${f('name')}${f('name:ko')}${f('name:en')});out center tags;`;
  const j = await overpass(q);
  return dedupe(j.elements.map((e) => courseItem(e)).filter(Boolean)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => {
    const k = `${c.osmType}${c.osmId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ---------- 골프장 자료 받기 ---------- */
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const pt = (g) => [round6(g.lat), round6(g.lon)];
function centroid(pts) {
  let la = 0;
  let ln = 0;
  for (const [a, b] of pts) {
    la += a;
    ln += b;
  }
  return { lat: la / pts.length, lng: ln / pts.length };
}
const TEE_COLOR = { black: 'black', blue: 'blue', white: 'white', red: 'red', yellow: 'yellow', gold: 'gold', green: 'green', silver: 'silver' };
function teeColor(tags = {}) {
  const v = (tags.tee || tags['golf:tee'] || tags.colour || tags.color || tags.ref || '').toLowerCase();
  for (const k of Object.keys(TEE_COLOR)) if (v.includes(k)) return TEE_COLOR[k];
  return null;
}

// 결과: { feat: {fairway, green, bunker, water, tee}, holes: [...] } 또는 null(자료 없음)
export async function fetchCourseData(c) {
  const bq = `[out:json][timeout:20];${c.osmType}(${c.osmId});out bb;`;
  const bj = await overpass(bq);
  const el = bj.elements?.[0];
  let b = el?.bounds;
  if (!b) {
    const d = 0.012;
    b = { minlat: c.lat - d, minlon: c.lng - d, maxlat: c.lat + d, maxlon: c.lng + d };
  }
  const m = 0.002;
  const bb = `${b.minlat - m},${b.minlon - m},${b.maxlat + m},${b.maxlon + m}`;
  const q = `[out:json][timeout:30];(way["golf"](${bb});relation["golf"](${bb});way["natural"="water"](${bb});relation["natural"="water"](${bb}););out geom tags;`;
  const j = await overpass(q, 40000);
  return parseCourse(j.elements || [], b);
}

export function parseCourse(elements, bounds = null) {
  const feat = { fairway: [], green: [], bunker: [], water: [], tee: [] };
  const holeWays = [];
  const kindOf = (t) => {
    const g = t.golf;
    if (g === 'fairway') return 'fairway';
    if (g === 'green') return 'green';
    if (g === 'bunker') return 'bunker';
    if (g === 'tee') return 'tee';
    if (g === 'water_hazard' || g === 'lateral_water_hazard' || t.natural === 'water') return 'water';
    return null;
  };
  const rings = (e) => {
    if (e.type === 'way' && Array.isArray(e.geometry)) return [e.geometry.map(pt)];
    if (e.type === 'relation' && Array.isArray(e.members)) {
      return e.members.filter((mb) => mb.role !== 'inner' && Array.isArray(mb.geometry)).map((mb) => mb.geometry.map(pt));
    }
    return [];
  };
  for (const e of elements) {
    const t = e.tags || {};
    if (t.golf === 'hole' && e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 2) {
      holeWays.push({ ref: t.ref, par: Number(t.par) || null, name: t.name || '', line: e.geometry.map(pt) });
      continue;
    }
    const k = kindOf(t);
    if (!k) continue;
    for (const r of rings(e)) {
      if (r.length < 3) continue;
      const item = { pts: r };
      if (k === 'tee') item.color = teeColor(t);
      feat[k].push(item);
    }
  }
  const nFeat = Object.values(feat).reduce((s, a) => s + a.length, 0);
  if (!holeWays.length && !nFeat) return null;

  // 홀 번호 정리 (27·36홀처럼 번호가 겹치면 코스 A·B·C로 나눠요)
  const groups = [];
  const sorted = holeWays
    .map((h) => ({ ...h, n: parseInt(h.ref, 10) }))
    .filter((h) => Number.isFinite(h.n))
    .sort((a, b) => a.n - b.n);
  for (const h of sorted) {
    let g = groups.find((x) => !x.has(h.n));
    if (!g) {
      g = new Set();
      g.items = [];
      groups.push(g);
    }
    g.add(h.n);
    g.items.push(h);
  }
  const greens = feat.green.map((x) => ({ ...centroid(x.pts), pts: x.pts }));
  const tees = feat.tee.map((x) => ({ ...centroid(x.pts), color: x.color }));
  const holes = [];
  const letters = 'ABCDEF';
  groups.forEach((g, gi) => {
    for (const h of g.items) {
      const first = { lat: h.line[0][0], lng: h.line[0][1] };
      const last = { lat: h.line[h.line.length - 1][0], lng: h.line[h.line.length - 1][1] };
      let green = null;
      let bestD = 70;
      for (const gr of greens) {
        const d = haversine(last, gr);
        if (d < bestD) {
          bestD = d;
          green = gr;
        }
      }
      const myTees = tees.filter((te) => haversine(first, te) < 130).map((te) => ({ lat: round6(te.lat), lng: round6(te.lng), color: te.color || null }));
      holes.push({
        no: holes.length + 1,
        label: groups.length > 1 ? `${letters[gi] || gi + 1}-${h.n}` : String(h.n),
        par: h.par || (haversine(first, last) > 430 ? 5 : haversine(first, last) < 210 ? 3 : 4),
        tee: null,
        tees: myTees.length ? myTees : [{ lat: first.lat, lng: first.lng, color: null }],
        green: green ? { lat: round6(green.lat), lng: round6(green.lng) } : { lat: last.lat, lng: last.lng },
        line: h.line,
        fromOsm: true,
      });
    }
  });
  log(`골프장 자료: 홀 ${holes.length}개, 그림 요소 ${nFeat}개`);
  return { feat, holes, bounds };
}

// 가장 가까운 그린·티 중심 찾기 (홀아웃·티샷 위치 보정용)
export function nearestCentroid(feat, kind, p, maxDist) {
  let best = null;
  let bd = maxDist;
  for (const x of feat?.[kind] || []) {
    const c = centroid(x.pts);
    const d = haversine(p, c);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
