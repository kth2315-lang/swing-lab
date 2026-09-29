// 클럽, 8대 지표, 기준 범위, 교정 문구
// 기준 범위는 레슨에서 흔히 쓰는 목표값을 바탕으로 한 '초기 목표값'이에요.
// 내 기록이 쌓이면 조정할 수 있게 한곳에 모아 뒀어요.

export const CLUBS = [
  { id: 'DR', name: '드라이버', carry: 200 },
  { id: '3W', name: '3번 우드', carry: 180 },
  { id: '5W', name: '5번 우드', carry: 165 },
  { id: 'UT', name: '유틸리티', carry: 155 },
  { id: '5I', name: '5번 아이언', carry: 145 },
  { id: '6I', name: '6번 아이언', carry: 135 },
  { id: '7I', name: '7번 아이언', carry: 125 },
  { id: '8I', name: '8번 아이언', carry: 115 },
  { id: '9I', name: '9번 아이언', carry: 105 },
  { id: 'PW', name: '피칭 웨지', carry: 95, wedge: true },
  { id: 'AW', name: '어프로치 웨지', carry: 80, wedge: true },
  { id: 'SW', name: '샌드 웨지', carry: 65, wedge: true },
];
export const clubById = (id) => CLUBS.find((c) => c.id === id) || CLUBS[0];
export const WEDGE_DISTANCES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

export const PRO_NAMES = [
  '로리 매킬로이', '타이거 우즈', '스코티 셰플러', '콜린 모리카와', '욘 람',
  '빅토르 호블란', '브룩스 켑카', '브라이슨 디섐보', '더스틴 존슨', '잰더 쇼플리',
];

// 8대 지표 (설계서 순서)
export const METRIC_ORDER = ['sway', 'spine', 'tempo', 'lag', 'reversePivot', 'arc', 'chickenWing', 'head'];
export const METRIC_LABEL = {
  sway: '하체 스웨이',
  spine: '척추각 유지',
  tempo: '스윙 템포',
  lag: '손목 래깅·캐스팅',
  reversePivot: '리버스 피벗',
  arc: '스윙 아크 폭',
  chickenWing: '팔로스루 치킨윙',
  head: '머리 이동',
};

// 좋음/주의 경계. dir: 'max' = 값이 작을수록 좋음, 'min' = 클수록 좋음, 'band' = 범위 안이 좋음
export function limits(key, ctx = {}) {
  switch (key) {
    case 'tempo':
      return ctx.short
        ? { dir: 'band', good: [1.7, 2.5], warn: [1.4, 3.0], text: '짧은 샷 목표 약 2:1' }
        : { dir: 'band', good: [2.6, 3.4], warn: [2.2, 4.0], text: '투어 평균 약 3:1' };
    case 'sway':
      return { dir: 'max', good: 5, warn: 10, text: '뒤쪽 밀림 5cm 이내' };
    case 'reversePivot':
      return { dir: 'max', good: 3, warn: 8, text: '타깃 쪽 기울기 3° 이내' };
    case 'spine':
      return { dir: 'min', good: -4, warn: -9, text: '임팩트 때 일어섬 4° 이내' };
    case 'hipThrust':
      return { dir: 'max', good: 4, warn: 8, text: '골반 앞쪽 이동 4cm 이내' };
    case 'arc':
      return { dir: 'min', good: 92, warn: 85, text: '톱에서 리드 팔 92% 이상 펴짐' };
    case 'chickenWing':
      return { dir: 'min', good: 155, warn: 140, text: '임팩트 직후 팔꿈치 155° 이상' };
    case 'headH':
      return { dir: 'max', good: 8, warn: 12, text: '8cm 이내' };
    case 'headV':
      return { dir: 'max', good: 5, warn: 8, text: '5cm 이내' };
    default:
      return null;
  }
}

export function grade(key, value, ctx) {
  const L = limits(key, ctx);
  if (!L || value == null || !Number.isFinite(value)) return 'na';
  if (L.dir === 'band') {
    if (value >= L.good[0] && value <= L.good[1]) return 'good';
    if (value >= L.warn[0] && value <= L.warn[1]) return 'warn';
    return 'bad';
  }
  if (L.dir === 'max') return value <= L.good ? 'good' : value <= L.warn ? 'warn' : 'bad';
  return value >= L.good ? 'good' : value >= L.warn ? 'warn' : 'bad';
}

const worse = (a, b) => {
  const r = { na: 0, good: 1, warn: 2, bad: 3 };
  return r[a] >= r[b] ? a : b;
};
export const worseOf = (...gs) => gs.reduce((a, b) => worse(a, b), 'na');

// 교정 문구 (가장 심한 문제 하나만 보여 줘요)
export function coachingText(metrics, hand = 'R') {
  const lead = hand === 'R' ? '왼' : '오른';
  const trail = hand === 'R' ? '오른' : '왼';
  const weight = { sway: 1.0, spine: 1.1, tempo: 0.8, reversePivot: 1.0, arc: 0.7, chickenWing: 0.8, head: 0.9 };
  const sev = { bad: 3, warn: 1.5 };
  let best = null;
  for (const k of Object.keys(weight)) {
    const m = metrics[k];
    if (!m || !sev[m.grade]) continue;
    const s = sev[m.grade] * weight[k];
    if (!best || s > best.s) best = { k, s, m };
  }
  if (!best) return { title: '좋아요, 크게 고칠 곳이 없어요', body: '지금 느낌을 기억해 두고 같은 템포로 반복해 보세요.' };
  const { k, m } = best;
  const v = m.value;
  switch (k) {
    case 'sway':
      return { title: '백스윙 때 골반이 뒤로 밀려요', body: `골반이 ${trail}쪽으로 약 ${Math.round(v)}cm 밀렸어요. ${trail}발 안쪽에 체중을 두고 골반을 제자리에서 돌린다는 느낌으로 해 보세요.` };
    case 'spine': {
      const sg = m.sub?.spineGrade;
      const tg = m.sub?.thrustGrade;
      const thrustIsMain = tg === 'bad' || (tg === 'warn' && sg !== 'bad' && sg !== 'warn');
      return thrustIsMain
        ? { title: '임팩트 때 골반이 공 쪽으로 나와요 (배치기)', body: `골반이 공 쪽으로 약 ${Math.round(m.sub.thrust)}cm 나왔어요. 엉덩이 뒤쪽이 어드레스 때 위치를 지키게 해 보세요.` }
        : { title: '임팩트 때 상체가 일어나요 (배치기)', body: `척추 각도가 어드레스보다 약 ${Math.abs(Math.round(v))}° 세워졌어요. 엉덩이 뒤쪽을 유지하고 가슴을 공 쪽으로 누른 채 돌아 보세요.` };
    }
    case 'tempo':
      return v < (m.ctxShort ? 1.7 : 2.6)
        ? { title: '백스윙이 급해요', body: `템포가 ${v.toFixed(1)}:1이에요. 백스윙을 조금 더 여유 있게 가져가고, 다운스윙에서 힘을 쓰세요.` }
        : { title: '백스윙이 너무 길고 느려요', body: `템포가 ${v.toFixed(1)}:1이에요. 백스윙을 조금 더 간결하게, 멈추지 말고 이어서 내려와 보세요.` };
    case 'reversePivot':
      return { title: '톱에서 상체가 타깃 쪽으로 기울어요 (리버스 피벗)', body: `어드레스보다 타깃 쪽으로 약 ${Math.round(v)}° 기울었어요. 백스윙 때 가슴이 ${trail}발 위에 오도록 돌아 보세요.` };
    case 'arc':
      return { title: '톱에서 스윙 폭이 좁아요', body: `톱에서 ${lead}팔이 약 ${Math.round(v)}%만 펴졌어요. 백스윙 때 ${lead}팔을 곧게 뻗어 스윙 폭을 넓혀 보세요.` };
    case 'chickenWing':
      return { title: '임팩트 직후 팔꿈치가 굽어요 (치킨윙)', body: `${lead}팔꿈치가 약 ${Math.round(v)}°까지 굽었어요. 폴로스루에서 두 팔을 타깃 쪽으로 쭉 뻗어 보세요.` };
    case 'head':
      return { title: '스윙 중 머리가 많이 움직여요', body: `머리가 ${m.sub?.dirText || ''} 약 ${Math.round(v)}cm 움직였어요. 머리 높이와 위치를 지킨 채 가슴만 돌려 보세요.` };
    default:
      return { title: '', body: '' };
  }
}

// 샷 점수 (오잘공 선정용)
export function shotScore(metrics, resultTag) {
  let s = 100;
  for (const k of METRIC_ORDER) {
    const g = metrics[k]?.grade;
    if (g === 'bad') s -= 15;
    else if (g === 'warn') s -= 6;
  }
  if (resultTag === 'good') s += 10;
  if (resultTag === 'miss') s -= 15;
  return Math.max(0, Math.min(110, s));
}
