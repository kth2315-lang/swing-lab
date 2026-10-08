// 위성지도 (브이월드 항공사진) — 지도 '사진'만 받아요. 바깥 코드를 앱 안에 넣지 않아요.
import { log } from './util.js';

let key = null;
const cache = new Map();
const status = { ok: 0, failed: 0 };

export function setMapKey(k) {
  key = (k || '').trim() || null;
  cache.clear();
  status.ok = 0;
  status.failed = 0;
}
export const hasMapKey = () => !!key;
export const mapStatus = () => ({ ...status, hasKey: !!key });

function tileUrl(z, x, y) {
  return `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(key)}/Satellite/${z}/${y}/${x}.jpeg`;
}
function getTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  let t = cache.get(k);
  if (!t) {
    const img = new Image();
    img.referrerPolicy = 'origin'; // 브이월드가 등록한 주소(깃허브 페이지)에서 온 요청인지 확인할 수 있게
    t = { img, ok: false, failed: false };
    img.onload = () => {
      t.ok = true;
      status.ok += 1;
    };
    img.onerror = () => {
      t.failed = true;
      status.failed += 1;
      if (status.failed === 1) log('위성지도를 못 불러왔어요. 브이월드 키와 등록한 주소를 확인해 주세요.', 'error');
    };
    img.src = tileUrl(z, x, y);
    cache.set(k, t);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return t;
}

// 웹 메르카토르 타일 좌표
export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: ((lng + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}
export function tileToLngLat(x, y, z) {
  const n = 2 ** z;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lat, lng: (x / n) * 360 - 180 };
}

// 화면 1픽셀이 몇 m인지에 맞는 지도 단계 고르기
export function zoomFor(lat, pxPerMeter) {
  const z = Math.log2(156543.03 * Math.cos((lat * Math.PI) / 180) * pxPerMeter);
  return Math.max(7, Math.min(19, Math.round(z)));
}

// toScreen: {lat,lng} → 화면 좌표, corners: 화면 네 모서리의 {lat,lng}
export function drawTiles(g, toScreen, corners, pxPerMeter) {
  if (!key || !corners?.length) return 0;
  const lat0 = corners.reduce((s, c) => s + c.lat, 0) / corners.length;
  const z = zoomFor(lat0, pxPerMeter);
  const ts = corners.map((c) => lngLatToTile(c.lng, c.lat, z));
  const x0 = Math.floor(Math.min(...ts.map((t) => t.x)));
  const x1 = Math.floor(Math.max(...ts.map((t) => t.x)));
  const y0 = Math.floor(Math.min(...ts.map((t) => t.y)));
  const y1 = Math.floor(Math.max(...ts.map((t) => t.y)));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) return 0; // 너무 넓으면 그리지 않아요
  let drawn = 0;
  for (let ty = y0; ty <= y1; ty += 1) {
    for (let tx = x0; tx <= x1; tx += 1) {
      const t = getTile(z, tx, ty);
      if (!t.ok) continue;
      const nw = toScreen(tileToLngLat(tx, ty, z));
      const ne = toScreen(tileToLngLat(tx + 1, ty, z));
      const sw = toScreen(tileToLngLat(tx, ty + 1, z));
      const k = 1.004; // 이음새 틈을 막으려고 살짝 크게
      g.save();
      g.setTransform(((ne.x - nw.x) / 256) * k, ((ne.y - nw.y) / 256) * k, ((sw.x - nw.x) / 256) * k, ((sw.y - nw.y) / 256) * k, nw.x, nw.y);
      g.drawImage(t.img, 0, 0, 256, 256);
      g.restore();
      drawn += 1;
    }
  }
  return drawn;
}

// 설정에서 '연결 확인': 지도 사진 한 장을 받아 봐요 (서울 시청 근처)
export function testMapKey(k) {
  return new Promise((resolve) => {
    const kk = (k || '').trim();
    if (!kk) {
      resolve(false);
      return;
    }
    const z = 15;
    const t = lngLatToTile(126.978, 37.5665, z);
    const img = new Image();
    img.referrerPolicy = 'origin';
    const timer = setTimeout(() => resolve(false), 12000);
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 0); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(kk)}/Satellite/${z}/${Math.floor(t.y)}/${Math.floor(t.x)}.jpeg`;
  });
}
