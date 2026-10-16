// 오픈스트리트맵(무료 세계 지도)에서 골프장 자료 받기
// 보내는 것: 전국 골프장 목록 요청(한 달에 한 번)과, 고른 골프장의 범위뿐이에요.
// 2026년 4월부터 지도 서버가 '어느 앱에서 온 요청인지'를 요구해서, 앱 주소(origin)만 함께 보내요.
import { log, haversine } from './util.js';
import * as store from './store.js';

const SERVERS = [
  { host: 'overpass.private.coffee', url: 'https://overpass.private.coffee/api/interpreter' },
  { host: 'overpass-api.de', url: 'https://overpass-api.de/api/interpreter' },
];
const KOREA = '33.0,124.5,38.7,131.0';
const cool = new Map(); // 바쁘다고 한 서버는 1분 동안 쉬게 해요
let preferred = null; // 마지막으로 잘 된 서버를 먼저 써요

// 보안 잠금(CSP)에 막힌 주소 기록 (앱이 옛 버전일 때 생겨요)
const cspBlocked = new Set();
if (typeof document !== 'undefined') {
  document.addEventListener('securitypolicyviolation', (e) => {
    try {
      cspBlocked.add(new URL(e.blockedURI).host);
    } catch {
      /* 주소 모양이 아니면 무시 */
    }
  });
}

export class MapServerError extends Error {
  constructor(tries) {
    super('지도 서버에 연결하지 못했어요');
    this.name = 'MapServerError';
    this.tries = tries;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// accept(json): 받은 자료가 쓸 만한지 확인 (아니면 다음 서버로)
async function overpass(q, { timeoutMs = 30000, accept = null } = {}) {
  const order = preferred ? [preferred, ...SERVERS.filter((s) => s !== preferred)] : SERVERS;
  const tries = [];
  for (const s of order) {
    if (Date.now() < (cool.get(s.host) || 0)) {
      tries.push({ host: s.host, kind: 'cool' });
      continue;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    let tr;
    try {
      const r = await fetch(s.url, {
        method: 'POST',
        body: `data=${encodeURIComponent(q)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'omit',
        referrerPolicy: 'strict-origin-when-cross-origin',
        signal: ctl.signal,
      });
      if (r.ok) {
        let j = null;
        try {
          j = await r.json();
        } catch {
          j = null;
        }
        clearTimeout(timer);
        const busy = j && typeof j.remark === 'string' && /error|timed out|out of memory/i.test(j.remark) && !(j.elements || []).length;
        if (j && !busy && (!accept || accept(j))) {
          preferred = s;
          log(`지도 서버 ${s.host} 응답 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
          return j;
        }
        tr = { host: s.host, kind: busy ? 'busy' : 'bad', ms: Date.now() - t0 };
      } else {
        clearTimeout(timer);
        if ([403, 406, 429].includes(r.status)) cool.set(s.host, Date.now() + 60000);
        tr = { host: s.host, kind: 'http', status: r.status, ms: Date.now() - t0 };
      }
    } catch (e) {
      clearTimeout(timer);
      await sleep(30); // 보안 잠금 기록이 먼저 남도록 잠깐 기다려요
      const kind = e.name === 'AbortError' ? 'timeout' : cspBlocked.has(s.host) ? 'csp' : 'network';
      tr = { host: s.host, kind, msg: e.message, ms: Date.now() - t0 };
    }
    tries.push(tr);
    log(`지도 서버 ${s.host} 실패: ${tryText(tr)}`, 'error');
  }
  throw new MapServerError(tries);
}

function tryText(t) {
  switch (t.kind) {
    case 'http':
      return `오류 ${t.status}`;
    case 'timeout':
      return '응답 없음';
    case 'csp':
      return '보안 잠금에 막힘';
    case 'busy':
      return '서버가 바쁨';
    case 'bad':
      return '자료가 이상함';
    case 'cool':
      return '잠시 쉬는 중';
    default:
      return `연결 실패 (${t.msg || ''})`;
  }
}

// 사용자에게 보여 줄 이유
export function describeError(e) {
  const tries = e?.tries || [];
  const has = (k, f = () => true) => tries.some((t) => t.kind === k && f(t));
  let title = '지도 서버에 연결하지 못했어요.';
  if (has('csp')) title = '앱이 아직 예전 버전이라 막혔어요. 앱을 완전히 닫았다가 다시 열어 주세요.';
  else if (has('http', (t) => t.status === 429) || has('cool')) title = '지도 서버에 요청이 몰려 있어요. 1~2분 뒤 다시 해 주세요.';
  else if (has('http', (t) => t.status === 403 || t.status === 406)) title = '지도 서버가 요청을 받아 주지 않았어요.';
  else if (has('http', (t) => t.status >= 500) || has('busy')) title = '지도 서버가 지금 바빠요. 잠시 뒤 다시 해 주세요.';
  else if (has('timeout')) title = '지도 서버가 응답하지 않아요. 잠시 뒤 다시 해 주세요.';
  else if (has('bad')) title = '지도 서버가 이상한 자료를 보냈어요. 잠시 뒤 다시 해 주세요.';
  const detail = tries.map((t) => `${t.host.replace('overpass.', '')}: ${tryText(t)}`).join(' · ');
  return { title, detail };
}

/* =================== 전국 골프장 목록 =================== */
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const LIST_Q = `[out:json][timeout:60];nwr["leisure"="golf_course"](${KOREA})->.g;(way.g;relation.g;);out tags bb;node.g;out body;`;
const LIST_KEY = 'courseList';
const LIST_TTL = 30 * 864e5;
const NOT_COURSE = /파크\s*골프|그라운드\s*골프|골프\s*연습장|연습장|스크린|드라이빙\s*레인지|driving\s*range|park\s*golf|mini\s*golf|미니\s*골프|퍼팅\s*장/i;

// 휴전선 북쪽(북한)과 일본 쪽은 빼요
function dmzLat(lng) {
  if (lng < 126.6) return 37.85;
  if (lng < 127.2) return 37.95 + (lng - 126.6) * 0.55;
  if (lng < 128.35) return 38.28 + (lng - 127.2) * 0.28;
  return 38.62;
}
export function inKorea(lat, lng) {
  if (lat < 33.0 || lat > 38.7 || lng < 124.5 || lng > 131.0) return false;
  if (lat < 34.8 && lng > 129.1) return false; // 대마도·규슈
  return lat <= dmzLat(lng);
}

export function parseCourseList(elements) {
  const out = [];
  const seen = new Set();
  for (const e of elements || []) {
    const t = e.tags || {};
    let lat;
    let lng;
    let b = null;
    if (e.bounds) {
      b = [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon].map(round6);
      lat = (b[0] + b[2]) / 2;
      lng = (b[1] + b[3]) / 2;
    } else if (e.center) {
      lat = e.center.lat;
      lng = e.center.lon;
    } else {
      lat = e.lat;
      lng = e.lon;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inKorea(lat, lng)) continue;
    const names = [t['name:ko'], t.name, t['name:en'], t.official_name, t.short_name, t.loc_name, t.old_name, ...(t.alt_name || '').split(';')]
      .map((x) => (x || '').trim())
      .filter(Boolean);
    if (NOT_COURSE.test(names.join(' '))) continue;
    if (t.golf === 'driving_range' || t.golf === 'miniature' || t.sport === 'park_golf') continue;
    if (b && haversine({ lat: b[0], lng: b[1] }, { lat: b[2], lng: b[3] }) < 250) continue; // 너무 작으면 연습장이에요
    const key = `${e.type}${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const main = names[0] || '';
    out.push({
      t: e.type,
      id: e.id,
      lat: round6(lat),
      lng: round6(lng),
      b,
      n: main,
      en: t['name:en'] && t['name:en'] !== main ? t['name:en'] : '',
      a: [...new Set(names.slice(1))].filter((x) => x !== main && x !== t['name:en']),
    });
  }
  return out;
}

let listMem = null;
let listP = null;

function prep(rec) {
  for (const it of rec.items) it.k = [it.n, it.en, ...(it.a || [])].filter(Boolean).map(normName);
  return rec;
}

export const cachedCourseList = () => listMem;

// 저장된 목록이 있으면 바로 쓰고, 30일 지났으면 새로 받아요
export async function loadCourseList({ force = false } = {}) {
  if (!listMem) {
    try {
      const saved = await store.getKV(LIST_KEY);
      if (saved?.items?.length) listMem = prep(saved);
    } catch {
      /* 저장소가 없으면 새로 받아요 */
    }
  }
  if (!force && listMem && Date.now() - listMem.at < LIST_TTL) return listMem;
  if (listP) return listP;
  listP = (async () => {
    try {
      const j = await overpass(LIST_Q, { timeoutMs: 35000, accept: (x) => parseCourseList(x.elements).length >= 20 });
      const rec = prep({ at: Date.now(), items: parseCourseList(j.elements) });
      listMem = rec;
      const plain = { at: rec.at, items: rec.items.map(({ k, ...rest }) => rest) };
      await store.setKV(LIST_KEY, plain).catch(() => {});
      log(`전국 골프장 목록: ${rec.items.length}곳`);
      return rec;
    } catch (e) {
      if (listMem) {
        log('골프장 목록을 새로 받지 못해서 저장된 목록을 써요');
        return listMem;
      }
      throw e;
    } finally {
      listP = null;
    }
  })();
  return listP;
}

/* ---------- 찾기 (자동완성) ---------- */
export function normName(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s·・\-_.,()（）[\]'"&/!~]/g, '');
}

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
// 겹받침을 나눌 때: 앞 받침은 남기고 뒤 글자를 다음 글자의 첫소리로
const SPLIT = { ㄳ: ['ㄱ', 'ㅅ'], ㄵ: ['ㄴ', 'ㅈ'], ㄶ: ['ㄴ', 'ㅎ'], ㄺ: ['ㄹ', 'ㄱ'], ㄻ: ['ㄹ', 'ㅁ'], ㄼ: ['ㄹ', 'ㅂ'], ㄽ: ['ㄹ', 'ㅅ'], ㄾ: ['ㄹ', 'ㅌ'], ㄿ: ['ㄹ', 'ㅍ'], ㅀ: ['ㄹ', 'ㅎ'], ㅄ: ['ㅂ', 'ㅅ'] };
const isSyl = (c) => c >= '가' && c <= '힣';
const isCons = (c) => c >= 'ㄱ' && c <= 'ㅎ';
const choOf = (c) => CHO[Math.floor((c.charCodeAt(0) - 0xac00) / 588)];

function charMatch(qc, nc) {
  if (qc === nc) return true;
  return isCons(qc) && isSyl(nc) && choOf(nc) === qc;
}
function matchPos(name, q) {
  for (let i = 0; i + q.length <= name.length; i += 1) {
    let ok = true;
    for (let j = 0; j < q.length; j += 1) {
      if (!charMatch(q[j], name[i + j])) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

// 받침이 있는 마지막 글자는 아직 치는 중일 수 있어요 (예: '하나'를 치는 중의 '한')
function typingVariant(q) {
  const c = q[q.length - 1];
  if (!c || !isSyl(c)) return null;
  const code = c.charCodeAt(0) - 0xac00;
  const jong = code % 28;
  if (!jong) return null;
  const j = JONG[jong];
  const [keep, move] = SPLIT[j] || ['', j];
  if (!CHO.includes(move)) return null;
  const base = String.fromCharCode(0xac00 + code - jong + (keep ? JONG.indexOf(keep) : 0));
  return q.slice(0, -1) + base + move;
}

const SUFFIX = /(컨트리클럽|컨트리클|컨트리|컨트|컨|골프클럽|골프클|골프장|골프|골|씨씨|씨|cc|c|gc|g)$/;

export function queryVariants(raw) {
  const q = normName(raw);
  if (!q) return [];
  const v = new Set([q]);
  const s = q.replace(SUFFIX, '');
  if (s && s !== q && /[가-힣a-z0-9]$/.test(s)) v.add(s);
  for (const x of [...v]) {
    const t = typingVariant(x);
    if (t) v.add(t);
  }
  return [...v];
}

function boxDist(p, it) {
  if (!it.b) return haversine(p, it);
  const lat = Math.min(Math.max(p.lat, it.b[0]), it.b[2]);
  const lng = Math.min(Math.max(p.lng, it.b[1]), it.b[3]);
  return haversine(p, { lat, lng });
}

// 결과: [{...item, score, dist}] (점수가 낮을수록 위)
export function searchCourses(list, raw, near = null, limit = 30) {
  const qs = queryVariants(raw);
  if (!qs.length || !list?.items) return [];
  const out = [];
  for (const it of list.items) {
    const keys = it.k || [it.n, it.en, ...(it.a || [])].filter(Boolean).map(normName);
    let best = 9;
    keys.forEach((k, ki) => {
      for (const q of qs) {
        const p = matchPos(k, q);
        if (p < 0) continue;
        const sc = (p === 0 ? 0 : 2) + (ki === 0 ? 0 : 1);
        if (sc < best) best = sc;
      }
    });
    if (best < 9) out.push({ ...it, score: best, dist: near ? boxDist(near, it) : null });
  }
  out.sort((a, b) => a.score - b.score || (a.dist ?? 0) - (b.dist ?? 0) || a.n.length - b.n.length || a.n.localeCompare(b.n, 'ko'));
  return out.slice(0, limit);
}

export function nearestCourses(list, pos, limit = 15) {
  if (!list?.items || !pos) return [];
  return list.items
    .map((it) => ({ ...it, dist: boxDist(pos, it) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
}

/* =================== 골프장 하나의 자세한 지도 =================== */
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

// c: { osmType, osmId, lat, lng, bounds? }
// 결과: { feat, holes, bounds } 또는 null(그림 자료 없음). 연결이 안 되면 MapServerError를 던져요.
export async function fetchCourseData(c) {
  let b = c.bounds;
  if (!b) {
    try {
      const bj = await overpass(`[out:json][timeout:20];${c.osmType}(${c.osmId});out bb;`, { timeoutMs: 20000 });
      b = bj.elements?.[0]?.bounds || null;
    } catch (e) {
      if (!Number.isFinite(c.lat)) throw e;
    }
  }
  if (!b) {
    const d = 0.012;
    b = { minlat: c.lat - d, minlon: c.lng - d, maxlat: c.lat + d, maxlon: c.lng + d };
  }
  const m = 0.002;
  const bb = `${b.minlat - m},${b.minlon - m},${b.maxlat + m},${b.maxlon + m}`;
  const q = `[out:json][timeout:40];(way["golf"](${bb});relation["golf"](${bb});way["natural"="water"](${bb});relation["natural"="water"](${bb}););out geom tags;`;
  const j = await overpass(q, { timeoutMs: 45000 });
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
