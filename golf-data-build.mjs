// 스윙 랩 · 골프장 지도 자료 만들기
// GitHub Actions(.github/workflows/golf-data.yml)가 GitHub 서버에서 실행해요.
// 앱 화면은 이 파일을 쓰지 않아요 (휴대폰에서는 실행되지 않아요).
//
// 입력: osmium으로 골라낸 오픈스트리트맵 자료(OPL 글자 파일) 두 개
//   1) 골프장 경계 (leisure=golf_course)
//   2) 골프장 안 그림 (golf=홀·티·그린·페어웨이·벙커·해저드, natural=water)
// 출력:
//   data/courses.json   전국 골프장 목록 (이름·범위·홀 지도 있는지)
//   data/c/w123.json     골프장 하나의 홀 지도 (그림 자료가 있는 곳만)
// 자료: © OpenStreetMap 기여자, ODbL 1.0 — 만든 파일도 같은 라이선스를 따라요.
// 바깥 패키지 없이 Node 기본 기능만 써요.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [COURSES_OPL, FEAT_OPL, OUT = 'data'] = process.argv.slice(2);
if (!COURSES_OPL || !FEAT_OPL) {
  console.error('사용법: node golf-data-build.mjs courses.opl feat.opl [data]');
  process.exit(2);
}

const MARGIN = 0.002; // 앱이 지도 서버에 물어볼 때와 같은 여유 (약 200m)
const NODE_HALF = 0.012; // 점으로만 그려진 골프장은 중심에서 ±0.012도
const GRID = 0.05; // 찾기용 칸 크기 (약 5km)
const HOLE_TOL = 50; // 홀 선이 골프장 경계에서 이 거리(m) 안이면 이 골프장 홀로 봐요
const SIMPLIFY_M = 0.3; // 모양을 줄일 때 허용 오차 (m) — 눈으로는 차이가 없어요
const MIN_COURSES = Number(process.env.MIN_COURSES || 50); // 이보다 적으면 자료가 잘못된 것 → 저장하지 않아요

const NAME_KEYS = ['name', 'name:ko', 'name:en', 'official_name', 'short_name', 'loc_name', 'old_name', 'alt_name', 'golf', 'sport'];
const KEEP_GOLF = new Set(['hole', 'fairway', 'green', 'bunker', 'tee', 'water_hazard', 'lateral_water_hazard']);
const keepKind = (t) => KEEP_GOLF.has(t.golf) || t.natural === 'water';

/* ---------- OPL 읽기 ---------- */
const cp = (h) => {
  const n = parseInt(h, 16);
  return n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd';
};
const unesc = (s) => (s.includes('%') ? s.replace(/%([0-9a-fA-F]{1,8})%/g, (_, h) => cp(h)) : s);

function tagsOf(s) {
  const t = {};
  if (!s) return t;
  for (const kv of s.split(',')) {
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    t[unesc(kv.slice(0, i))] = unesc(kv.slice(i + 1));
  }
  return t;
}

// 'n1x127.1y37.5,n2x...' → [lat, lon, lat, lon, ...] (위치를 모르는 점은 건너뜀)
function coordsOf(s) {
  const out = [];
  if (!s) return out;
  for (const ref of s.split(',')) {
    const xi = ref.indexOf('x');
    const yi = ref.indexOf('y', xi + 1);
    if (xi < 0 || yi < 0) continue;
    const xs = ref.slice(xi + 1, yi);
    const ys = ref.slice(yi + 1);
    if (!xs || !ys) continue;
    const lon = Number(xs);
    const lat = Number(ys);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push(lat, lon);
  }
  return out;
}

function membersOf(s) {
  const out = [];
  if (!s) return out;
  for (const m of s.split(',')) {
    const at = m.indexOf('@');
    const ref = at < 0 ? m : m.slice(0, at);
    if (ref.length < 2) continue;
    out.push({ t: ref[0], id: Number(ref.slice(1)), role: at < 0 ? '' : unesc(m.slice(at + 1)) });
  }
  return out;
}

function parseLine(line) {
  if (!line || line[0] === '#') return null;
  const parts = line.split(' ');
  const head = parts[0];
  const o = { t: head[0], id: Number(head.slice(1)), tags: {}, N: '', M: '', x: '', y: '' };
  for (let i = 1; i < parts.length; i += 1) {
    const p = parts[i];
    const k = p[0];
    if (k === 'T') o.tags = tagsOf(p.slice(1));
    else if (k === 'N') o.N = p.slice(1);
    else if (k === 'M') o.M = p.slice(1);
    else if (k === 'x') o.x = p.slice(1);
    else if (k === 'y') o.y = p.slice(1);
  }
  return o;
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const o = parseLine(line);
    if (o) fn(o);
  }
}

/* ---------- 위치 계산 ---------- */
function bboxOf(c, box = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (let i = 0; i < c.length; i += 2) {
    if (c[i] < box[0]) box[0] = c[i];
    if (c[i + 1] < box[1]) box[1] = c[i + 1];
    if (c[i] > box[2]) box[2] = c[i];
    if (c[i + 1] > box[3]) box[3] = c[i + 1];
  }
  return box;
}
const hits = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const r6 = (x) => Math.round(x * 1e6) / 1e6;

class Grid {
  constructor(size) {
    this.s = size;
    this.m = new Map();
  }
  keys(b) {
    const s = this.s;
    const out = [];
    for (let i = Math.floor(b[0] / s); i <= Math.floor(b[2] / s); i += 1) {
      for (let j = Math.floor(b[1] / s); j <= Math.floor(b[3] / s); j += 1) out.push(`${i},${j}`);
    }
    return out;
  }
  add(b, v) {
    for (const k of this.keys(b)) {
      let a = this.m.get(k);
      if (!a) this.m.set(k, (a = []));
      a.push(v);
    }
  }
  query(b) {
    const out = new Set();
    for (const k of this.keys(b)) for (const v of this.m.get(k) || []) out.add(v);
    return out;
  }
}

// 여러 조각이 모여 닫힌 고리를 이루는지 (끝점이 모두 짝이 맞는지)
function closedRings(rings) {
  const cnt = new Map();
  for (const c of rings) {
    const n = c.length;
    if (n < 4) return false;
    for (const k of [`${c[0]},${c[1]}`, `${c[n - 2]},${c[n - 1]}`]) cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  for (const v of cnt.values()) if (v % 2) return false;
  return true;
}

// 점이 경계 안에 있는지 (조각들을 이어 붙이지 않아도 되는 홀짝 규칙)
function pip(lat, lon, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 2; i < r.length; i += 2) {
      const y1 = r[i - 2];
      const x1 = r[i - 1];
      const y2 = r[i];
      const x2 = r[i + 1];
      if (y1 > lat !== y2 > lat && lon < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) inside = !inside;
    }
  }
  return inside;
}

function distToRings(lat, lon, rings) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  let best = Infinity;
  for (const r of rings) {
    for (let i = 2; i < r.length; i += 2) {
      const ax = (r[i - 1] - lon) * kx;
      const ay = (r[i - 2] - lat) * ky;
      const bx = (r[i + 1] - lon) * kx;
      const by = (r[i] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 ? -(ax * dx + ay * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

// 홀 선이 이 골프장 것인지: 점 하나라도 경계 안이거나 경계에서 50m 안
function holeInside(c, rings) {
  for (let i = 0; i < c.length; i += 2) if (pip(c[i], c[i + 1], rings)) return true;
  for (let i = 0; i < c.length; i += 2) if (distToRings(c[i], c[i + 1], rings) <= HOLE_TOL) return true;
  return false;
}

// 더글러스-포이커: 0.3m 안의 잔 점은 빼요 (파일 크기 줄이기)
function simplify(c, tol = SIMPLIFY_M) {
  const n = c.length / 2;
  if (n <= 4) return c;
  const kx = 111320 * Math.cos((c[0] * Math.PI) / 180);
  const ky = 110540;
  const X = (i) => c[2 * i + 1] * kx;
  const Y = (i) => c[2 * i] * ky;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = X(a);
    const ay = Y(a);
    const dx = X(b) - ax;
    const dy = Y(b) - ay;
    const L2 = dx * dx + dy * dy;
    let md = -1;
    let mi = -1;
    for (let i = a + 1; i < b; i += 1) {
      const px = X(i) - ax;
      const py = Y(i) - ay;
      let d;
      if (!L2) d = Math.hypot(px, py);
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2));
        d = Math.hypot(px - t * dx, py - t * dy);
      }
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (mi > 0 && md > tol) {
      keep[mi] = 1;
      stack.push([a, mi], [mi, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(c[2 * i], c[2 * i + 1]);
  return out.length >= 8 ? out : c;
}

// 좌표를 백만분의 1도 정수 차이로 (파일이 작아져요)
function enc(c) {
  const out = [];
  let pa = 0;
  let po = 0;
  for (let i = 0; i < c.length; i += 2) {
    const a = Math.round(c[i] * 1e6);
    const o = Math.round(c[i + 1] * 1e6);
    out.push(a - pa, o - po);
    pa = a;
    po = o;
  }
  return out;
}

function slim(t) {
  const o = {};
  if (t.golf) o.golf = t.golf;
  if (t.natural === 'water') o.natural = 'water';
  const keys = t.golf === 'hole' ? ['ref', 'par', 'name'] : t.golf === 'tee' ? ['tee', 'golf:tee', 'colour', 'color', 'ref'] : [];
  for (const k of keys) if (t[k]) o[k] = t[k];
  return o;
}

function pickNames(t) {
  const o = {};
  for (const k of NAME_KEYS) if (t[k]) o[k] = t[k];
  return o;
}

const normName = (s) =>
  String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s·・\-_.,()（）[\]'"&/!~]/g, '')
    .replace(/(컨트리클럽|골프클럽|골프앤리조트|골프리조트|골프장|리조트|씨씨|cc|gc)$/, '');

/* =================== 1) 골프장 경계 =================== */
const t0 = Date.now();
const cWays = new Map();
const cRels = [];
let courses = [];
await eachLine(COURSES_OPL, (o) => {
  if (o.t === 'n') {
    if (o.tags.leisure !== 'golf_course' || !o.x || !o.y) return;
    const lat = Number(o.y);
    const lon = Number(o.x);
    if (Number.isFinite(lat) && Number.isFinite(lon)) courses.push({ type: 'node', id: o.id, tags: o.tags, lat, lon });
  } else if (o.t === 'w') {
    const c = coordsOf(o.N);
    cWays.set(o.id, c);
    if (o.tags.leisure === 'golf_course' && c.length >= 4) courses.push({ type: 'way', id: o.id, tags: o.tags, rings: [c] });
  } else if (o.t === 'r' && o.tags.leisure === 'golf_course') {
    cRels.push(o);
  }
});
for (const r of cRels) {
  const rings = [];
  for (const m of membersOf(r.M)) {
    const c = m.t === 'w' ? cWays.get(m.id) : null;
    if (c && c.length >= 4) rings.push(c);
  }
  if (rings.length) courses.push({ type: 'relation', id: r.id, tags: r.tags, rings });
}
cWays.clear();

for (const c of courses) {
  if (c.type === 'node') {
    c.box = [c.lat, c.lon, c.lat, c.lon];
    c.fb = [c.lat - NODE_HALF, c.lon - NODE_HALF, c.lat + NODE_HALF, c.lon + NODE_HALF];
  } else {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of c.rings) bboxOf(r, b);
    c.box = b.map(r6);
    c.fb = c.box;
    c.poly = closedRings(c.rings) ? c.rings : null;
  }
  c.qbox = [c.fb[0] - MARGIN, c.fb[1] - MARGIN, c.fb[2] + MARGIN, c.fb[3] + MARGIN];
}

// 넓은 골프장 안에 같은 이름(또는 이름 없는) 점이 또 있으면 겹친 것 → 점은 빼요
const pgrid = new Grid(GRID);
for (const c of courses) if (c.poly) pgrid.add(c.box, c);
const sameName = (a, b) => {
  const x = normName(a.tags.name || a.tags['name:ko']);
  return !x || x === normName(b.tags.name || b.tags['name:ko']);
};
// 홀 선이 어느 골프장 경계 안에 있으면 그 골프장 것 (점으로만 그려진 골프장이 남의 홀을 가져가지 않게)
const owned = new Map();
const ownedByPolygon = (w) => {
  if (!owned.has(w.id)) {
    let yes = false;
    for (const p of pgrid.query(w.box)) {
      for (let i = 0; i < w.c.length && !yes; i += 2) if (pip(w.c[i], w.c[i + 1], p.poly)) yes = true;
      if (yes) break;
    }
    owned.set(w.id, yes);
  }
  return owned.get(w.id);
};
let dupNodes = 0;
courses = courses.filter((c) => {
  if (c.type !== 'node') return true;
  for (const p of pgrid.query(c.box)) {
    if (hits(p.box, c.box) && pip(c.lat, c.lon, p.poly) && sameName(c, p)) {
      dupNodes += 1;
      return false;
    }
  }
  return true;
});

if (courses.length < MIN_COURSES) {
  console.error(`골프장이 ${courses.length}곳뿐이에요 (최소 ${MIN_COURSES}). 지도 자료가 잘못 받아진 것 같아서 저장하지 않아요.`);
  process.exit(1);
}

/* =================== 2) 골프장 안 그림 =================== */
const cgrid = new Grid(GRID);
for (const c of courses) cgrid.add(c.qbox, c);
const nearCourse = (b) => {
  for (const c of cgrid.query(b)) if (hits(c.qbox, b)) return true;
  return false;
};

const fWays = new Map();
const fRels = [];
await eachLine(FEAT_OPL, (o) => {
  if (o.t === 'w') {
    const c = coordsOf(o.N);
    if (c.length < 4) return;
    const box = bboxOf(c);
    if (nearCourse(box)) fWays.set(o.id, { id: o.id, tags: o.tags, c, box });
  } else if (o.t === 'r' && keepKind(o.tags) && o.tags.golf !== 'hole') {
    const mem = [];
    for (const m of membersOf(o.M)) {
      const w = m.t === 'w' ? fWays.get(m.id) : null;
      if (w) mem.push({ role: m.role, w });
    }
    if (mem.length) fRels.push({ id: o.id, tags: o.tags, mem });
  }
});

const fgrid = new Grid(GRID);
for (const w of fWays.values()) if (keepKind(w.tags)) fgrid.add(w.box, { w });
for (const r of fRels) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const m of r.mem) bboxOf([m.w.box[0], m.w.box[1], m.w.box[2], m.w.box[3]], b);
  r.box = b;
  fgrid.add(b, { r });
}

/* =================== 3) 파일 쓰기 =================== */
const dirC = path.join(OUT, 'c');
fs.rmSync(dirC, { recursive: true, force: true });
fs.mkdirSync(dirC, { recursive: true });

const simp = new Map(); // 같은 길을 여러 골프장이 쓰면 한 번만 계산
const encOf = (w, doSimplify = true) => {
  const k = `${w.id}:${doSimplify ? 1 : 0}`;
  if (!simp.has(k)) simp.set(k, enc(doSimplify ? simplify(w.c) : w.c));
  return simp.get(k);
};

let withHoles = 0;
let withFiles = 0;
let bytes = 0;
let dropped = 0;
for (const c of courses) {
  const els = [];
  let nHoles = 0;
  let nPoly = 0;
  for (const f of fgrid.query(c.qbox)) {
    if (f.w) {
      const w = f.w;
      if (!hits(w.box, c.qbox)) continue;
      if (w.tags.golf === 'hole') {
        if (c.poly ? !holeInside(w.c, c.poly) : c.type === 'node' && ownedByPolygon(w)) {
          dropped += 1;
          continue;
        }
        els.push({ w: w.id, t: slim(w.tags), g: encOf(w, false) });
        nHoles += 1;
      } else if (w.c.length >= 6) {
        els.push({ w: w.id, t: slim(w.tags), g: encOf(w) });
        nPoly += 1;
      }
    } else {
      const r = f.r;
      if (!hits(r.box, c.qbox)) continue;
      const m = r.mem.filter((x) => hits(x.w.box, c.qbox) && x.w.c.length >= 4);
      if (!m.length) continue;
      els.push({ r: r.id, t: slim(r.tags), m: m.map((x) => [x.role, encOf(x.w)]) });
      nPoly += m.filter((x) => x.role !== 'inner').length;
    }
  }
  if (!nHoles && !nPoly) continue;
  els.sort((a, b) => (a.w ? 0 : 1) - (b.w ? 0 : 1) || (a.w || a.r) - (b.w || b.r));
  const body = JSON.stringify({ v: 1, b: c.fb.map(r6), e: els });
  fs.writeFileSync(path.join(dirC, `${c.type[0]}${c.id}.json`), body);
  bytes += body.length;
  c.d = 1;
  c.h = nHoles;
  withFiles += 1;
  if (nHoles) withHoles += 1;
}

const list = courses
  .map((c) => {
    const e = { type: c.type, id: c.id, tags: pickNames(c.tags) };
    if (c.type === 'node') {
      e.lat = r6(c.lat);
      e.lon = r6(c.lon);
    } else e.bounds = { minlat: c.box[0], minlon: c.box[1], maxlat: c.box[2], maxlon: c.box[3] };
    if (c.d) {
      e.d = 1;
      e.h = c.h;
    }
    return e;
  })
  .sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);

const at = process.env.OSM_DATE && /^\d{4}-\d\d-\d\d/.test(process.env.OSM_DATE) ? process.env.OSM_DATE : new Date().toISOString();
fs.writeFileSync(
  path.join(OUT, 'courses.json'),
  JSON.stringify({ v: 1, at, lic: '© OpenStreetMap 기여자 · ODbL 1.0 · https://www.openstreetmap.org/copyright', n: list.length, e: list }),
);
fs.writeFileSync(
  path.join(OUT, 'README.txt'),
  [
    '스윙 랩 골프장 지도 자료',
    '',
    '이 폴더의 파일은 GitHub Actions(골프장 지도 만들기)가 자동으로 만들어요. 손으로 고치지 마세요.',
    '- courses.json : 전국 골프장 목록',
    '- c/*.json     : 골프장별 홀·그린·티·페어웨이·벙커·물 모양',
    '',
    '자료 출처: © OpenStreetMap 기여자 (https://www.openstreetmap.org/copyright)',
    'Geofabrik(download.geofabrik.de)의 대한민국 자료에서 골프장 부분만 골라 만들었어요.',
    '이 자료는 Open Database License(ODbL) 1.0을 따라요: https://opendatacommons.org/licenses/odbl/1-0/',
    '',
    `자료 기준: ${at}`,
    '',
  ].join('\n'),
);

console.log(`골프장 ${list.length}곳 (겹친 점 ${dupNodes}곳 뺌)`);
console.log(`지도 파일 ${withFiles}곳 · 홀 그림 있는 곳 ${withHoles}곳 · 다른 골프장 홀이라 뺀 홀 ${dropped}개`);
console.log(`지도 파일 합계 ${(bytes / 1024 / 1024).toFixed(1)}MB · 자료 기준 ${at} · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
