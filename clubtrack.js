// 클럽 헤드 찾기 (화면과 무관한 순수 계산 — 폰 안에서만 돌아요)
// 장면마다 '작은 흑백 그림 + 관절(손 위치)'을 받아서, 손에서 뻗어 나간 샤프트의 방향과 길이를 찾아요.
//  1) 움직임: 앞뒤 장면과 달라진 곳 (세 장면 차이) — 빠르게 움직이는 샤프트가 잘 보여요
//  2) 가는 선: 주변보다 튀는 가는 줄 — 멈춰 있을 때(어드레스·톱)도 샤프트가 보여요
//  3) 손에서 사방으로 선을 그어 보고, 증거가 가장 많이 모인 방향을 고르고
//  4) 장면들 사이는 '팔이 도는 방향·빠르기'에 맞춰 가장 자연스러운 길로 이어요 (비터비)

const NA = 144; // 방향 칸 (2.5°씩)
const STEP = (Math.PI * 2) / NA;
const R2D = 180 / Math.PI;
const LEAD_ELBOW = { R: 13, L: 14 };
const TRAIL_ELBOW = { R: 14, L: 13 };
const HAND_IDX = [15, 16, 17, 18, 19, 20];

const vis = (p) => (p ? p.v ?? p.visibility ?? 1 : 0);
const angOf = (k) => k * STEP;
const wrapRad = (d) => {
  let x = d;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

// 관절에서 손 중심·어깨 중심·몸통 길이·팔꿈치 (픽셀)
export function poseInfo(lms, W, H, hand = 'R') {
  if (!lms || lms.length < 25) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const i of HAND_IDX) {
    const p = lms[i];
    if (vis(p) >= 0.2) {
      sx += p.x;
      sy += p.y;
      n += 1;
    }
  }
  if (!n) return null;
  const P = { x: (sx / n) * W, y: (sy / n) * H };
  const ok = (i) => vis(lms[i]) >= 0.3;
  let T = null;
  let S = null;
  if (ok(11) && ok(12)) S = { x: ((lms[11].x + lms[12].x) / 2) * W, y: ((lms[11].y + lms[12].y) / 2) * H };
  if (S && ok(23) && ok(24)) {
    const hx = ((lms[23].x + lms[24].x) / 2) * W;
    const hy = ((lms[23].y + lms[24].y) / 2) * H;
    T = Math.hypot(S.x - hx, S.y - hy);
  }
  const el = (i) => (vis(lms[i]) >= 0.2 ? { x: lms[i].x * W, y: lms[i].y * H } : null);
  // 다리(엉덩이~무릎~발목)와 몸통: 여기 증거는 샤프트보다 다리·몸 움직임일 때가 많아요
  const body = [];
  const seg = (a, b) => {
    if (ok(a) && ok(b)) body.push([lms[a].x * W, lms[a].y * H, lms[b].x * W, lms[b].y * H]);
  };
  seg(23, 25);
  seg(25, 27);
  seg(24, 26);
  seg(26, 28);
  seg(11, 23);
  seg(12, 24);
  return { P, S, T, body, lead: el(LEAD_ELBOW[hand] ?? 13), trail: el(TRAIL_ELBOW[hand] ?? 14) };
}

function pctFromHist(hist, count, p) {
  let acc = 0;
  for (let i = 0; i < hist.length; i += 1) {
    acc += hist[i];
    if (acc >= count * p) return i;
  }
  return hist.length - 1;
}

export function createClubTracker({ W, H, hand = 'R', bodyT = null, debug = null } = {}) {
  const raw = []; // 최근 세 장면 {g, t, info}
  const frames = []; // 계산이 끝난 장면
  const Tlist = [];
  let lastInfo = null;
  let prevP = null;
  let prevVel = null;
  // 계산용 버퍼 (한 번만 만들어요)
  const D = new Float32Array(W * H); // 움직임
  const G = new Float32Array(W * H); // 가는 선
  const E = new Float32Array(W * H); // 합친 증거 (넓힘)
  const M = new Float32Array(W * H); // 움직임만 (넓힘) — 샤프트 끝 찾기용
  const MASK = new Uint8Array(W * H); // 다리·몸통 자리
  const hist = new Uint32Array(256);
  const histE = new Uint32Array(256);
  const histM = new Uint32Array(256);
  const cosA = new Float32Array(NA);
  const sinA = new Float32Array(NA);
  for (let k = 0; k < NA; k += 1) {
    cosA[k] = Math.cos(angOf(k));
    sinA[k] = Math.sin(angOf(k));
  }

  function bodyLen() {
    if (bodyT) return bodyT;
    if (Tlist.length) {
      const s = [...Tlist].sort((a, b) => a - b);
      return s[s.length >> 1];
    }
    return H * 0.17;
  }

  // 가운데 장면(b)의 증거 그림을 손 둘레 상자 안에서만 만들어요
  function markBody(info, box, T) {
    const [x0, y0, x1, y1] = box;
    for (let y = y0; y <= y1; y += 1) MASK.fill(0, y * W + x0, y * W + x1 + 1);
    if (!info?.body?.length || !T) return;
    const rad = 0.13 * T;
    for (const [ax, ay, bx, by] of info.body) {
      const minx = Math.max(x0, Math.floor(Math.min(ax, bx) - rad));
      const maxx = Math.min(x1, Math.ceil(Math.max(ax, bx) + rad));
      const miny = Math.max(y0, Math.floor(Math.min(ay, by) - rad));
      const maxy = Math.min(y1, Math.ceil(Math.max(ay, by) + rad));
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy || 1;
      for (let y = miny; y <= maxy; y += 1) {
        for (let x = minx; x <= maxx; x += 1) {
          let u = ((x - ax) * dx + (y - ay) * dy) / L2;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const ex = ax + u * dx - x;
          const ey = ay + u * dy - y;
          if (ex * ex + ey * ey <= rad * rad) MASK[y * W + x] = 1;
        }
      }
    }
  }

  function evidence(a, b, c, box, fast) {
    const [x0, y0, x1, y1] = box;
    const gb = b.g;
    hist.fill(0);
    histE.fill(0);
    let cnt = 0;
    for (let y = y0; y <= y1; y += 1) {
      const row = y * W;
      for (let x = x0; x <= x1; x += 1) {
        const i = row + x;
        const v = gb[i];
        let d1 = v - a.g[i];
        if (d1 < 0) d1 = -d1;
        let d2 = c.g[i] - v;
        if (d2 < 0) d2 = -d2;
        const d = d1 < d2 ? d1 : d2;
        let gl = 0;
        if (x >= 2 && x < W - 2 && y >= 2 && y < H - 2) {
          const hz = (gb[i - 2] + gb[i + 2]) / 2 - v;
          const vt = (gb[i - 2 * W] + gb[i + 2 * W]) / 2 - v;
          const ah = hz < 0 ? -hz : hz;
          const av = vt < 0 ? -vt : vt;
          gl = ah > av ? ah : av;
        }
        D[i] = d;
        G[i] = gl;
        hist[d] += 1;
        histE[gl > 255 ? 255 : gl | 0] += 1;
        cnt += 1;
      }
    }
    const sD = Math.max(2.5, pctFromHist(hist, cnt, 0.5) * 1.4 + 1);
    const sG = Math.max(2.5, pctFromHist(histE, cnt, 0.5) * 1.4 + 1);
    // 빠를 땐 움직임이 더 믿을 만해요 (몸 윤곽선 같은 가는 선은 덜 봐요)
    const wg = fast ? 0.2 : 0.45;
    for (let y = y0; y <= y1; y += 1) {
      const row = y * W;
      for (let x = x0; x <= x1; x += 1) {
        const i = row + x;
        D[i] /= sD;
        G[i] = D[i] + wg * (G[i] / sG);
      }
    }
    // 3×3 최댓값으로 살짝 넓혀요 (손 위치가 조금 어긋나도 샤프트를 놓치지 않게)
    histE.fill(0);
    histM.fill(0);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        let me = 0;
        let mm = 0;
        for (let yy = Math.max(y0, y - 1); yy <= Math.min(y1, y + 1); yy += 1) {
          const row = yy * W;
          for (let xx = Math.max(x0, x - 1); xx <= Math.min(x1, x + 1); xx += 1) {
            const ve = G[row + xx];
            if (ve > me) me = ve;
            const vm = D[row + xx];
            if (vm > mm) mm = vm;
          }
        }
        const i = y * W + x;
        const k = MASK[i] ? 0.35 : 1;
        E[i] = me * k;
        M[i] = mm * k;
        const qe = (me * 8) | 0;
        const qm = (mm * 8) | 0;
        histE[qe > 255 ? 255 : qe] += 1;
        histM[qm > 255 ? 255 : qm] += 1;
      }
    }
    // 배경이 보통 어느 정도인지 (상위 10% 값) → 그보다 뚜렷해야 샤프트로 봐요
    return { bgE: (pctFromHist(histE, cnt, 0.9) + 1) / 8, bgM: (pctFromHist(histM, cnt, 0.9) + 1) / 8 };
  }

  // 손에서 각 방향으로 선을 그어 증거 점수·길이를 재요
  function rays(P, L, box, info, vel, bg, scores, ext, piv) {
    const [x0, y0, x1, y1] = box;
    const r0 = Math.max(3, 0.1 * L);
    const rmin = 0.28 * L;
    const rmax = 1.15 * L;
    const base = Math.max(1.5, 1.2 * bg.bgE);
    const tauFar = Math.max(3, 2 * bg.bgM);
    const off = Math.max(1.5, 0.05 * L);
    const pivots = [
      [0, 0],
      [off, 0],
      [-off, 0],
      [0, off],
      [0, -off],
    ];
    // 손이 빠를 땐 관절이 한 장면쯤 늦게 따라와요 → 움직이는 쪽 앞도 후보로
    if (vel && Math.hypot(vel.x, vel.y) > 0.04 * L) {
      for (const m of [0.5, 1, 1.5]) pivots.push([vel.x * m, vel.y * m]);
    }
    // 팔꿈치 쪽(팔이 있는 쪽)은 샤프트가 아니에요
    const block = [];
    for (const e of [info?.lead, info?.trail]) {
      if (!e) continue;
      const dx = e.x - P.x;
      const dy = e.y - P.y;
      if (Math.hypot(dx, dy) > 0.15 * L) block.push(Math.atan2(dy, dx));
    }
    const lim = (38 * Math.PI) / 180;
    for (let k = 0; k < NA; k += 1) {
      scores[k] = 0;
      ext[k] = 0;
      piv[k] = 0;
      const a = angOf(k);
      let blocked = false;
      for (const b of block) if (Math.abs(wrapRad(a - b)) < lim) blocked = true;
      if (blocked) continue;
      const ux = cosA[k];
      const uy = sinA[k];
      for (let j = 0; j < pivots.length; j += 1) {
        const px = P.x + pivots[j][0];
        const py = P.y + pivots[j][1];
        let acc = 0;
        let best = 0;
        let bestR = 0;
        let far = 0;
        let win = 0;
        const ring = [0, 0, 0, 0, 0];
        let ri = 0;
        for (let r = r0; r <= rmax; r += 1) {
          const x = (px + ux * r + 0.5) | 0;
          const y = (py + uy * r + 0.5) | 0;
          let e = 0;
          let m = 0;
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
            const i = y * W + x;
            e = E[i];
            m = M[i];
          }
          if (e > 12) e = 12;
          acc += e - base;
          if (r >= rmin && acc > best) {
            best = acc;
            bestR = r;
          }
          win += m - ring[ri];
          ring[ri] = m;
          ri = (ri + 1) % 5;
          if (r >= rmin && win >= 5 * tauFar) far = r - 2;
        }
        if (best > scores[k]) {
          scores[k] = best;
          ext[k] = far > 0 ? far : -bestR; // 음수 = 움직임으로는 끝을 못 찾음(가는 선 기준)
          piv[k] = j;
        }
      }
    }
    return pivots;
  }

  function processMiddle() {
    const [a, b, c] = raw;
    const info = b.info || lastInfo;
    if (!info) {
      frames.push({ t: b.t, P: null });
      return;
    }
    const P = info.P;
    const L = 2.3 * bodyLen();
    const R = 1.2 * L;
    const box = [Math.max(0, Math.floor(P.x - R)), Math.max(0, Math.floor(P.y - R)), Math.min(W - 1, Math.ceil(P.x + R)), Math.min(H - 1, Math.ceil(P.y + R))];
    if (box[2] <= box[0] || box[3] <= box[1]) {
      frames.push({ t: b.t, P: null });
      return;
    }
    let vel = prevP ? { x: P.x - prevP.x, y: P.y - prevP.y } : null;
    // 이번 장면에서 손이 갑자기 멈춘 것처럼 보이면(관절이 늦게 따라온 것) 직전 속도를 써요
    if (vel && prevVel && Math.hypot(vel.x, vel.y) < 0.5 * Math.hypot(prevVel.x, prevVel.y)) vel = prevVel;
    const v = vel ? Math.hypot(vel.x, vel.y) : 0;
    const fast = v > 0.035 * L;
    markBody(b.info || info, box, bodyLen());
    const bg = evidence(a, b, c, box, fast);
    debug?.(b.t, E, box, P);
    const scores = new Float32Array(NA);
    const ext = new Float32Array(NA);
    const piv = new Uint8Array(NA);
    const pivots = rays(P, L, box, info, vel, bg, scores, ext, piv);
    prevVel = prevP ? { x: P.x - prevP.x, y: P.y - prevP.y } : null;
    prevP = P;
    // 팔 각도 (어깨 중심 → 손): 클럽은 팔이 도는 쪽으로 따라 돌아요
    const S = info.S;
    const arm = S ? Math.atan2(P.y - S.y, P.x - S.x) : null;
    frames.push({ t: b.t, P: { x: P.x, y: P.y }, scores, ext, piv, pivots, v, L, arm, own: !!b.info });
  }

  return {
    W,
    H,
    // gray: Uint8Array(W*H), lms: 관절 33개(0~1 좌표) 또는 null, t: 영상 시각(초)
    push(gray, lms, t) {
      const info = poseInfo(lms, W, H, hand);
      if (info) {
        lastInfo = info;
        if (info.T && Tlist.length < 40) Tlist.push(info.T);
      }
      raw.push({ g: gray, t, info });
      if (raw.length > 3) raw.shift();
      if (raw.length === 3) processMiddle();
    },
    finish() {
      return solve(frames);
    },
    get count() {
      return frames.length;
    },
  };
}

// 비터비: 증거 점수 합은 크게, 방향 변화는 '팔이 돈 만큼'에서 벗어날수록 벌점
export function solve(frames) {
  const F = frames.filter((f) => f.P && f.scores);
  const n = F.length;
  if (n < 5) return { ok: false, reason: '클럽을 찾을 장면이 너무 적어요.', points: [] };
  const L = F[0].L;
  const lam = 14;
  const tops = F.map((f) => {
    let m = 0;
    for (let k = 0; k < NA; k += 1) if (f.scores[k] > m) m = f.scores[k];
    return m;
  }).sort((a, b) => a - b);
  const ref = Math.max(20, tops[Math.floor(tops.length * 0.7)] || 20);
  const em = (f, k) => (100 * f.scores[k]) / ref;

  // 팔이 돈 각도 (장면 사이, 도) — 잡음을 줄이려고 앞뒤 1장면씩 평균
  const armD = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    const a = F[i].arm;
    const b = F[i - 1].arm;
    armD[i] = a != null && b != null ? wrapRad(a - b) * R2D : 0;
  }
  const armS = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(1, i - 1); j <= Math.min(n - 1, i + 1); j += 1) {
      s += armD[j];
      c += 1;
    }
    armS[i] = s / c;
  }

  const dp = new Float32Array(NA);
  const nd = new Float32Array(NA);
  const back = [];
  for (let k = 0; k < NA; k += 1) dp[k] = em(F[0], k);
  // 한 장면 사이 클럽이 d칸 돌 때의 벌점 (팔이 da도 돌았을 때)
  const stepCost = new Float32Array(NA + 1);
  for (let i = 1; i < n; i += 1) {
    const f = F[i];
    const dt = Math.max(1e-3, f.t - F[i - 1].t);
    const da = armS[i];
    const vRel = f.v / Math.max(1, f.L);
    const slack = 120 * Math.max(0, dt - 1 / 50) + 160 * vRel; // 장면 간격이 길거나 손이 빠르면 여유 있게
    const ada = Math.abs(da);
    const still = ada < 1.5;
    const cone = 4 * ada + 8 + slack; // 같은 쪽으로는 여기까지 자유
    const sig = (8 + ada + slack * 0.5) / 2.5;
    const maxJump = Math.min(NA / 2 - 1, Math.ceil((still ? sig * 3.5 : cone / 2.5 + sig * 3)));
    for (let d = -maxJump; d <= maxJump; d += 1) {
      const deg = d * 2.5;
      let c;
      if (still) c = lam * (d / sig) * (d / sig);
      else {
        const along = deg * Math.sign(da);
        if (along >= 0) {
          const ex = Math.max(0, along - cone) / 2.5;
          c = lam * (ex / sig) * (ex / sig);
        } else {
          const z = -along / 6;
          c = lam * (z * z + (along < -5 ? 2 : 0));
        }
      }
      stepCost[d + maxJump] = c;
    }
    const bk = new Int16Array(NA);
    for (let k = 0; k < NA; k += 1) {
      let best = -Infinity;
      let arg = k;
      for (let d = -maxJump; d <= maxJump; d += 1) {
        const j = (k - d + NA) % NA;
        const c = dp[j] - stepCost[d + maxJump];
        if (c > best) {
          best = c;
          arg = j;
        }
      }
      nd[k] = best + em(f, k);
      bk[k] = arg;
    }
    back.push(bk);
    dp.set(nd);
  }
  let kEnd = 0;
  for (let k = 1; k < NA; k += 1) if (dp[k] > dp[kEnd]) kEnd = k;
  const ks = new Int16Array(n);
  ks[n - 1] = kEnd;
  for (let i = n - 1; i >= 1; i -= 1) ks[i - 1] = back[i - 1][ks[i]];

  // 칸 사이를 포물선으로 다듬기 + 뚜렷함(믿을 만한 정도)
  const theta = new Float64Array(n);
  const rawR = new Float64Array(n);
  const moveR = new Uint8Array(n);
  const conf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const f = F[i];
    const k = ks[i];
    const s0 = f.scores[(k - 1 + NA) % NA];
    const s1 = f.scores[k];
    const s2 = f.scores[(k + 1) % NA];
    const den = s0 - 2 * s1 + s2;
    const sub = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (s0 - s2)) / den)) : 0;
    theta[i] = (k + sub) * STEP;
    const e = f.ext[k];
    rawR[i] = Math.abs(e);
    moveR[i] = e > 0 ? 1 : 0;
    const sorted = Array.from(f.scores).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    conf[i] = s1 > 0 ? Math.max(0, Math.min(1, (s1 - med) / Math.max(10, 0.6 * ref))) : 0;
  }
  // 각도 펼치기(360° 넘어감 처리) 후, 느릴 때만 살짝 부드럽게
  const un = new Float64Array(n);
  un[0] = theta[0];
  for (let i = 1; i < n; i += 1) un[i] = un[i - 1] + wrapRad(theta[i] - theta[i - 1]);
  const th2 = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    if (F[i].v > 0.05 * L || i === 0 || i === n - 1) th2[i] = un[i];
    else th2[i] = (un[i - 1] + 2 * un[i] + un[i + 1]) / 4;
  }
  // 클럽 길이: 빠르게 움직일 때(끝이 잘 보일 때) 잰 값들로 진짜 길이를 정하고
  // 장면마다는 그 범위 안에서 중앙값으로 고르게 (샤프트가 몸에 가리거나 배경 무늬로 길어지는 것 방지)
  const fastR = [];
  for (let i = 0; i < n; i += 1) if (moveR[i] && conf[i] > 0.3) fastR.push(rawR[i]);
  fastR.sort((a, b) => a - b);
  const allR = Array.from(rawR).filter((x) => x > 0).sort((a, b) => a - b);
  const Lg = fastR.length >= 6 ? fastR[Math.floor(fastR.length * 0.9)] : allR.length ? allR[Math.floor(allR.length * 0.6)] : 0.8 * L;
  const clampR = (x) => Math.max(0.35 * Lg, Math.min(1.0 * Lg, x || Lg));
  const r1 = Float64Array.from(rawR, (x, i) => (moveR[i] ? clampR(x) : clampR(Math.min(x, Lg))));
  const r2 = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const w = [];
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j += 1) w.push(r1[j]);
    w.sort((a, b) => a - b);
    r2[i] = w[w.length >> 1];
  }
  const points = [];
  for (let i = 0; i < n; i += 1) {
    const f = F[i];
    const pv = f.pivots[f.piv[ks[i]]] || [0, 0];
    const px = f.P.x + pv[0];
    const py = f.P.y + pv[1];
    const a = th2[i];
    points.push({ t: f.t, px, py, a, r: r2[i], hx: px + Math.cos(a) * r2[i], hy: py + Math.sin(a) * r2[i], conf: conf[i] });
  }
  bridgeWeak(points);
  smoothHeads(points, Lg);
  return { ok: true, points, L: Lg, ref };
}

// 클럽이 잘 안 보인 구간(예: 측후방 테이크어웨이에서 샤프트가 카메라를 향할 때)은
// 앞뒤의 확실한 위치를 곡선으로 이어요 (엉뚱한 곳으로 튀지 않게)
export function bridgeWeak(points, { th = 0.2, maxSec = 0.6 } = {}) {
  const n = points.length;
  const cr = (p0, p1, p2, p3, u) => {
    const u2 = u * u;
    const u3 = u2 * u;
    return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  };
  let i = 0;
  while (i < n) {
    if (points[i].conf >= th) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && points[j].conf < th) j += 1;
    if (i > 0 && j < n && points[j].t - points[i - 1].t <= maxSec) {
      const A = points[Math.max(0, i - 2)];
      const B = points[i - 1];
      const C = points[j];
      const D = points[Math.min(n - 1, j + 1)];
      for (let k = i; k < j; k += 1) {
        const u = (points[k].t - B.t) / Math.max(1e-6, C.t - B.t);
        points[k].hx = cr(A.hx, B.hx, C.hx, D.hx, u);
        points[k].hy = cr(A.hy, B.hy, C.hy, D.hy, u);
        points[k].bridged = true;
      }
    }
    i = j;
  }
  return points;
}

// 헤드 위치 다듬기: 한 장면만 튀는 점은 이웃 가운데로, 느릴 땐 넓게 빠를 땐 그대로
export function smoothHeads(points, Lg) {
  const n = points.length;
  if (n < 5) return points;
  const hx = points.map((p) => p.hx);
  const hy = points.map((p) => p.hy);
  for (let i = 1; i < n - 1; i += 1) {
    const mx = (hx[i - 1] + hx[i + 1]) / 2;
    const my = (hy[i - 1] + hy[i + 1]) / 2;
    const gap = Math.hypot(hx[i + 1] - hx[i - 1], hy[i + 1] - hy[i - 1]);
    if (Math.hypot(hx[i] - mx, hy[i] - my) > 0.15 * Lg && gap < 0.12 * Lg) {
      hx[i] = mx;
      hy[i] = my;
    }
  }
  const sp = hx.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    return Math.hypot(hx[b] - hx[a], hy[b] - hy[a]) / Math.max(1, b - a) / Math.max(1, Lg);
  });
  const ox = hx.slice();
  const oy = hy.slice();
  for (let i = 0; i < n; i += 1) {
    const sig = Math.max(0, 2.2 - 12 * sp[i]);
    if (sig < 0.4) continue;
    const w = Math.ceil(sig * 2.5);
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j += 1) {
      const wt = Math.exp(-((j - i) * (j - i)) / (2 * sig * sig));
      sx += ox[j] * wt;
      sy += oy[j] * wt;
      sw += wt;
    }
    hx[i] = sx / sw;
    hy[i] = sy / sw;
  }
  let prevA = null;
  for (let i = 0; i < n; i += 1) {
    const p = points[i];
    p.hx = hx[i];
    p.hy = hy[i];
    let a = Math.atan2(p.hy - p.py, p.hx - p.px);
    if (prevA != null) a = prevA + wrapRad(a - prevA);
    p.a = a;
    p.r = Math.hypot(p.hx - p.px, p.hy - p.py);
    prevA = a;
  }
  return points;
}

// 한 장면 사이를 원호로 촘촘히 채워요 (빠른 다운스윙에서 직선으로 끊기지 않게)
export function densify(points, maxDeg = 4) {
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (i > 0) {
      const q = points[i - 1];
      const da = p.a - q.a;
      const steps = Math.min(24, Math.max(1, Math.ceil(Math.abs(da * R2D) / maxDeg)));
      for (let s = 1; s < steps; s += 1) {
        const u = s / steps;
        const px = q.px + (p.px - q.px) * u;
        const py = q.py + (p.py - q.py) * u;
        const a = q.a + da * u;
        const r = q.r + (p.r - q.r) * u;
        out.push({ t: q.t + (p.t - q.t) * u, hx: px + Math.cos(a) * r, hy: py + Math.sin(a) * r, conf: Math.min(p.conf, q.conf), sub: true });
      }
    }
    out.push({ t: p.t, hx: p.hx, hy: p.hy, conf: p.conf });
  }
  return out;
}

export const _test = { NA, STEP };
