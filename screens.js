// 클럽 선택 · 스크린 모드 시작 · 영상 불러오기 · 내 기록 · 설정
import { $, esc, log, getLog, toast, setVoice, dateText, shareFile } from './util.js';
import { CLUBS, clubById, WEDGE_DISTANCES, METRIC_ORDER, METRIC_LABEL } from './refs.js';
import * as store from './store.js';
import { unlockAudio, findHitInFile } from './sound.js';
import { bagDistances } from './field.js';
import { S, go, showModal, closeModal, confirmBox, clubLabel, saveProfile, saveSlots, onEnter } from './core.js';
import { startCapture, runAnalysis, newSession } from './capture.js';

/* ---------- 클럽 선택 ---------- */
export function openClubPicker({ title = '클럽 선택', club = '7I', wedge = null, cta = '촬영 시작', onDone }) {
  const st = { club, wedge };
  $('#clubTitle').textContent = title;
  $('#clubNext').textContent = cta;
  const dist = (c) => Math.round(S.profile.clubs?.[c.id] ?? c.carry);
  const render = () => {
    $('#clubGrid').innerHTML = CLUBS.map((c) => `<button data-id="${c.id}" class="${st.club === c.id ? 'on' : ''}">${esc(c.name)}<small>${dist(c)}m</small></button>`).join('');
    const isWedge = !!clubById(st.club).wedge;
    $('#wedgeBox').hidden = !isWedge;
    if (isWedge) {
      if (!st.wedge) st.wedge = 50;
      $('#wedgeDist').innerHTML = WEDGE_DISTANCES.map((d) => `<button data-d="${d}" class="${st.wedge === d ? 'on' : ''}">${d}m</button>`).join('');
      $('#wedgeDist').querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          st.wedge = Number(b.dataset.d);
          render();
        };
      });
    } else {
      st.wedge = null;
    }
    $('#clubGrid').querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        st.club = b.dataset.id;
        render();
      };
    });
  };
  render();
  $('#clubNext').onclick = () => onDone(st.club, st.wedge);
  go('club');
}

export function startScreenFlow() {
  openClubPicker({
    title: '스크린 모드 · 클럽 선택',
    club: S.lastClub || '7I',
    onDone: async (club, wedge) => {
      unlockAudio();
      S.lastClub = club;
      await newSession('screen', { club });
      startCapture({ mode: 'screen', view: 'face', club, wedge });
    },
  });
}

/* ---------- 영상 불러오기 ---------- */
const IM = { file: null, url: null, view: 'face', slow: 1, club: '7I', wedge: null };

export function openImport() {
  go('import');
}
onEnter('import', () => renderImport());

function renderImport() {
  const sheet = $('#importSheet');
  const isWedge = !!clubById(IM.club).wedge;
  if (isWedge && !IM.wedge) IM.wedge = 50;
  if (!isWedge) IM.wedge = null;
  sheet.innerHTML = `
    <label class="btn ghost file-btn">${IM.file ? '다른 영상 고르기' : '갤러리에서 영상 고르기'}<input type="file" id="imFile" accept="video/*"></label>
    ${IM.file
      ? `<video class="preview" id="imPrev" src="${IM.url}" playsinline muted controls></video><p class="fine">${esc(IM.file.name)} · ${(IM.file.size / 1048576).toFixed(1)}MB</p>`
      : '<p class="fine">스윙 한 번이 담긴 20초 이내 영상이 좋아요. 타구음이 녹음돼 있으면 스윙 구간을 더 정확히 찾아요.</p>'}
    <h3>촬영 구도</h3>
    <div class="chips" id="imView"><button data-v="face">정면</button><button data-v="dtl">측후방</button></div>
    <h3>촬영 속도</h3>
    <div class="chips" id="imSlow"><button data-s="1">일반</button><button data-s="4">슬로모션 120fps</button><button data-s="8">슬로모션 240fps</button></div>
    <h3>클럽</h3>
    <select id="imClub">${CLUBS.map((c) => `<option value="${c.id}" ${c.id === IM.club ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    ${isWedge ? `<h3>목표 거리</h3><div class="chips" id="imWedge">${WEDGE_DISTANCES.map((d) => `<button data-d="${d}" class="${IM.wedge === d ? 'on' : ''}">${d}m</button>`).join('')}</div>` : ''}
    <button class="btn primary wide" id="imGo" ${IM.file ? '' : 'disabled'}>분석 시작</button>`;

  const chips = (sel, key, val) => sheet.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset[key] === String(val)));
  chips('#imView', 'v', IM.view);
  chips('#imSlow', 's', IM.slow);
  sheet.querySelector('#imFile').onchange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (IM.url) URL.revokeObjectURL(IM.url);
    IM.file = f;
    IM.url = URL.createObjectURL(f);
    renderImport();
  };
  sheet.querySelectorAll('#imView button').forEach((b) => { b.onclick = () => { IM.view = b.dataset.v; chips('#imView', 'v', IM.view); }; });
  sheet.querySelectorAll('#imSlow button').forEach((b) => { b.onclick = () => { IM.slow = Number(b.dataset.s); chips('#imSlow', 's', IM.slow); }; });
  sheet.querySelector('#imClub').onchange = (e) => { IM.club = e.target.value; renderImport(); };
  sheet.querySelectorAll('#imWedge button').forEach((b) => { b.onclick = () => { IM.wedge = Number(b.dataset.d); renderImport(); }; });
  sheet.querySelector('#imGo').onclick = runImport;
}

async function runImport() {
  if (!IM.file) return;
  unlockAudio();
  const btn = $('#imGo');
  btn.disabled = true;
  btn.textContent = '타구음 찾는 중…';
  const hitMedia = await findHitInFile(IM.file);
  const dur = $('#imPrev')?.duration;
  let from = 0;
  let to = null;
  let impactHint = null;
  if (hitMedia != null) {
    from = Math.max(0, hitMedia - 2.4 * IM.slow);
    to = hitMedia + 1.4 * IM.slow;
    impactHint = hitMedia / IM.slow;
  } else if (Number.isFinite(dur) && dur > (IM.slow > 1 ? 45 : 20)) {
    toast('영상이 길고 타구음을 못 찾았어요. 사진 앱에서 스윙 부분만 남기고 잘라서 다시 불러와 주세요.', 7000);
    btn.disabled = false;
    btn.textContent = '분석 시작';
    return;
  }
  await newSession('import', { status: 'done' });
  await runAnalysis({ blob: IM.file, url: IM.url, mime: IM.file.type, impactHint, from, to, slow: IM.slow, view: IM.view, club: IM.club, wedge: IM.wedge, mode: 'import' });
}

/* ---------- 내 기록 ---------- */
const TYPE = { screen: '스크린', field: '필드', import: '불러오기' };
export async function renderHistory() {
  const sheet = $('#historySheet');
  let list = [];
  try {
    list = (await store.all('sessions')).sort((a, b) => b.startedAt - a.startedAt);
  } catch (e) {
    log(`기록 읽기 실패: ${e.message}`, 'error');
  }
  const withShots = list.filter((s) => (s.shots || []).length || s.type === 'field');
  if (!withShots.length) {
    sheet.innerHTML = '<p class="empty-msg">아직 기록이 없어요.<br>스크린 모드나 영상 불러오기로 첫 샷을 분석해 보세요.</p>';
    return;
  }
  const all = withShots.flatMap((s) => (s.shots || []).filter((x) => x.ok));
  const byClub = {};
  for (const x of all) (byClub[x.club] ||= []).push(x);
  const clubRows = Object.entries(byClub)
    .map(([id, xs]) => {
      const avg = Math.round(xs.reduce((a, b) => a + b.score, 0) / xs.length);
      const tempos = xs.map((x) => x.metrics?.tempo?.value).filter(Number.isFinite);
      const t = tempos.length ? (tempos.reduce((a, b) => a + b, 0) / tempos.length).toFixed(1) : '–';
      return `<li><b>${esc(clubById(id).name)}</b><small>${xs.length}샷 · 평균 ${avg}점 · 평균 템포 ${t}:1</small></li>`;
    })
    .join('');
  sheet.innerHTML = `
    ${clubRows ? `<h3>클럽별 요약</h3><ul class="list">${clubRows}</ul>` : ''}
    <h3>연습·라운드</h3>
    <ul class="list">${withShots
      .map((s) => {
        const ok = (s.shots || []).filter((x) => x.ok);
        const best = ok.length ? Math.max(...ok.map((x) => x.score)) : null;
        const title = s.type === 'field' ? `${esc(s.courseName || '필드')}` : `${TYPE[s.type] || ''} 연습`;
        return `<li><button class="rowbtn" data-id="${s.id}"><span><b>${title}</b><small>${dateText(s.startedAt)} · 분석 ${ok.length}샷${best != null ? ` · 최고 ${best}점` : ''}</small></span><span class="tag">${TYPE[s.type] || ''}</span></button></li>`;
      })
      .join('')}</ul>`;
  sheet.querySelectorAll('.rowbtn').forEach((b) => {
    b.onclick = () => showSession(list.find((s) => s.id === b.dataset.id));
  });
}

function showSession(s) {
  if (!s) return;
  const shots = (s.shots || []).slice().reverse();
  const rows = shots.length
    ? shots
        .map((x) => {
          const chips = METRIC_ORDER.filter((k) => x.metrics?.[k] && x.metrics[k].grade !== 'na')
            .slice(0, 4)
            .map((k) => `${METRIC_LABEL[k]} ${esc(x.metrics[k].text)}`)
            .join(' · ');
          return `<li><b>${esc(clubLabel(x.club, x.wedge))} · ${x.ok ? `${x.score}점` : '분석 실패'}</b><small>${dateText(x.at)} · ${x.view === 'face' ? '정면' : '측후방'}</small><small>${chips}</small></li>`;
        })
        .join('')
    : '<li><small>분석한 샷이 없어요.</small></li>';
  showModal(
    `<h3>${esc(TYPE[s.type] || '')} · ${dateText(s.startedAt)}</h3><ul class="list">${rows}</ul><div class="stack"><button class="btn ghost" data-a="close">닫기</button><button class="btn danger" data-a="del">이 기록 지우기</button></div>`,
    (c) => {
      c.querySelector('[data-a=close]').onclick = closeModal;
      c.querySelector('[data-a=del]').onclick = async () => {
        await store.del('sessions', s.id).catch(() => {});
        await store.del('clips', s.id).catch(() => {});
        closeModal();
        toast('기록을 지웠어요');
        renderHistory();
      };
    },
  );
}

/* ---------- 설정 ---------- */
export function renderSettings() {
  const p = S.profile;
  const bag = bagDistances(p, S.clubStats);
  const sheet = $('#settingsSheet');
  const left = 'style="text-align:left"';
  sheet.innerHTML = `
    <h3>스윙 방향</h3><div class="chips" id="stHand"><button data-h="R">오른손 (우타)</button><button data-h="L">왼손 (좌타)</button></div>
    <h3>음성 안내</h3><div class="chips" id="stVoice"><button data-v="1">켜기</button><button data-v="0">끄기</button></div>
    <h3>카메라 속도</h3><div class="chips" id="stFps">${[30, 60, 120, 240].map((f) => `<button data-f="${f}">${f}fps</button>`).join('')}</div>
    <p class="fine" ${left}>60fps가 기본이에요. 120·240은 폰과 사파리가 지원할 때만 적용되고, 어두운 곳에선 화면이 거칠어질 수 있어요.</p>
    <h3>타구음 감지 기준</h3>
    <label class="f">현재 <span id="stThrV">${p.threshold.toFixed(2)}</span><input type="range" id="stThr" min="0.1" max="0.8" step="0.05" value="${p.threshold}"></label>
    <p class="fine" ${left}>주변 소리에 자주 반응하면 올리고, 내 샷을 못 잡으면 내려 주세요.</p>
    <h3>내 클럽 거리 (m)</h3>
    ${bag.map((c) => `<div class="clubrow"><span>${esc(c.name)}</span><input type="number" inputmode="numeric" data-club="${c.id}" value="${Math.round(c.base)}"><small>${c.learned ? `실제 ${Math.round(c.learned)}m<br>${c.summary.n}샷` : ''}</small></div>`).join('')}
    <h3>비교 기준 스윙 (1~10번)</h3>
    <p class="fine" ${left}>영상 불러오기로 분석한 스윙에서 '비교 기준으로 저장'을 누르면 채워져요. 영상은 저장하지 않고 관절 좌표와 지표만 저장해요.</p>
    ${S.slots.map((s, i) => `<div class="slotrow"><span>${i + 1}</span><input type="text" data-slot="${i}" value="${esc(s.name)}"><button class="btn ghost small" data-clear="${i}" ${s.data ? '' : 'disabled'}>${s.data ? '비우기' : '비어 있음'}</button></div>`).join('')}
    <h3>바람·고도 정보</h3>
    <p class="fine" ${left}>${S.windConsent ? '필드 모드에서 날씨 서버(Open-Meteo)에 대략 위치를 보내는 데 동의했어요.' : '아직 동의하지 않았어요. 필드 모드에서 처음 쓸 때 물어봐요.'}</p>
    ${S.windConsent ? '<button class="btn ghost small" id="stWindOff">동의 취소</button>' : ''}
    <h3>데이터</h3>
    <div class="stack">
      <button class="btn ghost" id="stExport">백업 파일 내보내기</button>
      <label class="btn ghost file-btn">백업 불러오기<input type="file" id="stImport" accept="application/json,.json"></label>
      <button class="btn danger" id="stWipe">모든 기록 지우기</button>
    </div>
    <h3>보안</h3>
    <p class="fine" ${left}>🔒 이 앱은 자기 주소 안의 파일만 써요. 바깥 연결은 동의한 날씨 서버만 허용하고 나머지는 모두 막아요.<br>막은 연결: ${S.blocked.length ? esc(S.blocked.join(', ')) : '없음'}</p>
    <details><summary>진행 기록 보기 (문제 생기면 캡처해서 보내 주세요)</summary><pre class="log">${esc(getLog())}</pre></details>
    <p class="fine">스윙 랩 v1.0</p>`;

  const mark = (sel, key, val) => sheet.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset[key] === String(val)));
  mark('#stHand', 'h', p.hand);
  mark('#stVoice', 'v', p.voice === false ? 0 : 1);
  mark('#stFps', 'f', p.fps);
  sheet.querySelectorAll('#stHand button').forEach((b) => { b.onclick = () => { p.hand = b.dataset.h; saveProfile(); mark('#stHand', 'h', p.hand); }; });
  sheet.querySelectorAll('#stVoice button').forEach((b) => { b.onclick = () => { p.voice = b.dataset.v === '1'; setVoice(p.voice); saveProfile(); mark('#stVoice', 'v', p.voice ? 1 : 0); }; });
  sheet.querySelectorAll('#stFps button').forEach((b) => {
    b.onclick = () => {
      p.fps = Number(b.dataset.f);
      saveProfile();
      mark('#stFps', 'f', p.fps);
      if (S.cam) toast('다음에 카메라를 켤 때 적용돼요');
    };
  });
  sheet.querySelector('#stThr').oninput = (e) => {
    p.threshold = Number(e.target.value);
    sheet.querySelector('#stThrV').textContent = p.threshold.toFixed(2);
    saveProfile();
  };
  sheet.querySelectorAll('[data-club]').forEach((inp) => {
    inp.onchange = () => {
      const v = Number(inp.value);
      p.clubs = p.clubs || {};
      if (Number.isFinite(v) && v > 0) p.clubs[inp.dataset.club] = v;
      else delete p.clubs[inp.dataset.club];
      saveProfile();
    };
  });
  sheet.querySelectorAll('[data-slot]').forEach((inp) => {
    inp.onchange = () => {
      const i = Number(inp.dataset.slot);
      S.slots[i].name = inp.value.trim() || `${i + 1}번 기준`;
      saveSlots();
    };
  });
  sheet.querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = async () => {
      const i = Number(b.dataset.clear);
      if (!(await confirmBox({ title: `${i + 1}번 칸 비우기`, text: `${S.slots[i].name} 칸에 저장된 기준 스윙을 지울까요?`, ok: '비우기', danger: true }))) return;
      S.slots[i].data = null;
      await saveSlots();
      renderSettings();
    };
  });
  const off = sheet.querySelector('#stWindOff');
  if (off) off.onclick = async () => { S.windConsent = false; await store.setKV('windConsent', false); renderSettings(); };
  sheet.querySelector('#stExport').onclick = async () => {
    const data = await store.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const d = new Date();
    const name = `swinglab-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    showModal(
      `<h3>백업 파일이 준비됐어요</h3><p>샷 기록 ${data.sessions.length}개와 골프장·설정이 들어 있어요 (영상 제외). '파일에 저장'을 골라 보관해 두세요.</p><div class="stack"><button class="btn primary" data-a="save">백업 파일 저장</button><button class="btn ghost" data-a="close">닫기</button></div>`,
      (c) => {
        c.querySelector('[data-a=save]').onclick = async () => {
          const r = await shareFile(blob, name);
          closeModal();
          if (r !== 'cancelled') toast('백업 파일을 저장했어요');
        };
        c.querySelector('[data-a=close]').onclick = closeModal;
      },
    );
  };
  sheet.querySelector('#stImport').onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      await store.importAll(JSON.parse(await f.text()));
      toast('백업을 불러왔어요. 앱을 다시 열면 모두 반영돼요.');
    } catch (err) {
      toast(`불러오지 못했어요: ${err.message}`);
    }
  };
  sheet.querySelector('#stWipe').onclick = async () => {
    if (!(await confirmBox({ title: '모든 기록 지우기', text: '샷 기록, 골프장, 클럽 거리, 비교 기준이 모두 지워지고 되돌릴 수 없어요.', ok: '모두 지우기', danger: true }))) return;
    await store.wipeAll();
    toast('모두 지웠어요. 앱을 다시 열어 주세요.');
  };
}

