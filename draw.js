// 화면 그리기: 관절 선, 촬영 가이드, 비교 기준 겹쳐 보기

// 몸통·팔·다리 연결 (얼굴은 코 한 점만)
const BODY = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];
const vis = (p) => p && (p.v ?? p.visibility ?? 1) >= 0.35;

export function drawSkeleton(g, lms, rect, opt = {}) {
  if (!lms) return;
  const { color = 'rgba(255,255,255,0.95)', joint = '#F2B705', scale = 1, dash = null, width = 3 } = opt;
  const X = (p) => rect.x + p.x * rect.w;
  const Y = (p) => rect.y + p.y * rect.h;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = width * scale;
  g.strokeStyle = color;
  if (dash) g.setLineDash(dash.map((d) => d * scale));
  for (const [a, b] of BODY) {
    const p = lms[a];
    const q = lms[b];
    if (!vis(p) || !vis(q)) continue;
    g.beginPath();
    g.moveTo(X(p), Y(p));
    g.lineTo(X(q), Y(q));
    g.stroke();
  }
  g.setLineDash([]);
  g.fillStyle = joint;
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    const p = lms[i];
    if (!vis(p)) continue;
    g.beginPath();
    g.arc(X(p), Y(p), (i === 0 ? 5 : 3.5) * scale, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

// 촬영 가이드 (정면: 발선·실루엣·머리 영역 / 측후방: 1/3 실루엣·타깃 쪽 빈 공간·조준선)
export function drawGuides(g, W, H, { view = 'face', hand = 'R', ball = null, level = null, scale = 1, fast = false }) {
  g.save();
  const flip = (x) => (hand === 'R' ? x : 1 - x);
  const px = (x) => flip(x) * W;
  const py = (y) => y * H;
  const lw = 3 * scale;

  if (!fast) {
    // 발선
    g.strokeStyle = 'rgba(242,183,5,0.95)';
    g.lineWidth = 4 * scale;
    g.beginPath();
    if (view === 'face') {
      g.moveTo(0.2 * W, py(0.88));
      g.lineTo(0.8 * W, py(0.88));
    } else {
      g.moveTo(px(0.14), py(0.88));
      g.lineTo(px(0.52), py(0.88));
    }
    g.stroke();

    // 실루엣
    g.strokeStyle = 'rgba(255,255,255,0.32)';
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 14 * scale;
    g.lineCap = 'round';
    const seg = (a, b) => {
      g.beginPath();
      g.moveTo(px(a[0]), py(a[1]));
      g.lineTo(px(b[0]), py(b[1]));
      g.stroke();
    };
    if (view === 'face') {
      const head = [0.5, 0.2];
      g.beginPath();
      g.arc(px(head[0]), py(head[1]), 0.045 * H, 0, Math.PI * 2);
      g.fill();
      seg([0.41, 0.34], [0.59, 0.34]);
      seg([0.5, 0.34], [0.5, 0.53]);
      seg([0.44, 0.53], [0.56, 0.53]);
      seg([0.44, 0.53], [0.42, 0.7]);
      seg([0.42, 0.7], [0.4, 0.87]);
      seg([0.56, 0.53], [0.58, 0.7]);
      seg([0.58, 0.7], [0.6, 0.87]);
      seg([0.41, 0.34], [0.48, 0.61]);
      seg([0.59, 0.34], [0.52, 0.61]);
      // 머리 영역
      g.setLineDash([8 * scale, 6 * scale]);
      g.lineWidth = 2 * scale;
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.strokeRect(0.4 * W, py(0.11), 0.2 * W, py(0.19));
      g.setLineDash([]);
    } else {
      g.beginPath();
      g.arc(px(0.37), py(0.22), 0.042 * H, 0, Math.PI * 2);
      g.fill();
      seg([0.28, 0.52], [0.36, 0.33]);
      seg([0.36, 0.33], [0.43, 0.6]);
      seg([0.28, 0.52], [0.32, 0.7]);
      seg([0.32, 0.7], [0.3, 0.87]);
      // 타깃 쪽 빈 공간
      g.setLineDash([10 * scale, 8 * scale]);
      g.lineWidth = 2 * scale;
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      const x0 = hand === 'R' ? 0.56 * W : 0.04 * W;
      g.strokeRect(x0, py(0.14), 0.4 * W, py(0.66));
      g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.font = `600 ${14 * scale}px -apple-system, sans-serif`;
      g.textAlign = 'center';
      g.fillText('타깃 방향 (비워 두기)', x0 + 0.2 * W, py(0.19));
    }
  }

  // 조준선 (측후방에서 공을 눌러 정했을 때)
  if (view === 'dtl' && ball) {
    g.strokeStyle = 'rgba(242,183,5,0.95)';
    g.lineWidth = lw;
    g.setLineDash([12 * scale, 8 * scale]);
    g.beginPath();
    g.moveTo(ball.x * W, ball.y * H);
    g.lineTo(px(0.74), py(0.3));
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(ball.x * W, ball.y * H, 7 * scale, 0, Math.PI * 2);
    g.fill();
  }

  // 상태 테두리
  if (level) {
    const c = { red: '#D2283C', yellow: '#F2B705', green: '#2FA85A' }[level];
    g.strokeStyle = c;
    g.lineWidth = 8 * scale;
    g.strokeRect(4 * scale, 4 * scale, W - 8 * scale, H - 8 * scale);
  }
  g.restore();
}

// 비교 기준 관절을 내 몸 위치·크기에 맞춰 옮겨요 (골반 중심을 맞추고 몸통 길이로 크기 조절)
export function alignRef(ref, refDims, mine, myDims, mirror = false) {
  if (!ref || !mine) return null;
  const toPx = (l, d) => l.map((p) => ({ x: p.x * d.w, y: p.y * d.h, v: p.v ?? 1 }));
  const R = toPx(ref, refDims);
  const M = toPx(mine, myDims);
  const hip = (a) => ({ x: (a[23].x + a[24].x) / 2, y: (a[23].y + a[24].y) / 2 });
  const shc = (a) => ({ x: (a[11].x + a[12].x) / 2, y: (a[11].y + a[12].y) / 2 });
  const hR = hip(R);
  const hM = hip(M);
  const tR = Math.hypot(shc(R).x - hR.x, shc(R).y - hR.y);
  const tM = Math.hypot(shc(M).x - hM.x, shc(M).y - hM.y);
  if (!tR || !tM) return null;
  const k = tM / tR;
  return R.map((p) => {
    const dx = (mirror ? hR.x - p.x : p.x - hR.x) * k;
    return { x: (hM.x + dx) / myDims.w, y: (hM.y + (p.y - hR.y) * k) / myDims.h, v: 1 };
  });
}

// 필드 트레이서 (공이 날아간 방향을 선택하면 그 모양으로 궤적을 그려요)
export function drawTracer(g, W, H, ball, dir, progress, scale = 1) {
  if (!ball) return;
  const bend = { hookL: -0.3, left: -0.14, straight: 0, right: 0.14, sliceR: 0.3 }[dir] ?? 0;
  const sx = ball.x * W;
  const sy = ball.y * H;
  const ex = sx + (0.12 + bend) * W * 0.9;
  const ey = 0.3 * H;
  const cx = sx + (ex - sx) * 0.2;
  const cy = Math.min(sy, ey) - 0.28 * H;
  g.save();
  g.lineCap = 'round';
  const steps = 40;
  const upto = Math.max(1, Math.round(steps * Math.min(1, progress)));
  for (let pass = 0; pass < 2; pass += 1) {
    g.strokeStyle = pass === 0 ? 'rgba(210,40,60,0.45)' : '#FFFFFF';
    g.lineWidth = (pass === 0 ? 10 : 3.5) * scale;
    g.beginPath();
    for (let i = 0; i <= upto; i += 1) {
      const u = i / steps;
      const x = (1 - u) * (1 - u) * sx + 2 * (1 - u) * u * cx + u * u * ex;
      const y = (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * cy + u * u * ey;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.restore();
}
