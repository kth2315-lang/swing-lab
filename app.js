// 스윙 랩 시작점
import { $, $$, log, toast, setVoice } from './util.js';
import * as store from './store.js';
import { checkModels } from './pose.js';
import { S, go, goBack, onEnter, noteBlocked, updateLock } from './core.js';
import { startScreenFlow, openImport, renderHistory, renderSettings } from './screens.js';
import { openField, checkRecovery, fieldVisible, fieldHidden } from './fieldui.js';
import { captureVisible } from './capture.js';
import { unlockAudio } from './sound.js';
import { setMapKey } from './maptiles.js';

// 보안 잠금에 걸린 연결은 기록만 하고 넘어가요 (구글 사용통계 포함)
document.addEventListener('securitypolicyviolation', (e) => {
  let host = e.blockedURI || '';
  try {
    host = new URL(e.blockedURI).host;
  } catch {
    /* 주소 모양이 아니면 그대로 */
  }
  noteBlocked(/odml\.pa\.googleapis\.com/.test(host) ? '구글 사용통계' : host);
  log(`🔒 바깥 연결을 막았어요: ${host}`);
});
window.addEventListener('error', (e) => log(`오류: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => log(`오류: ${e.reason?.message || e.reason}`, 'error'));

async function boot() {
  try {
    const p = await store.getKV('profile');
    if (p) S.profile = { ...S.profile, ...p };
    const slots = await store.getKV('slots');
    if (Array.isArray(slots) && slots.length === 10) S.slots = slots;
    S.clubStats = (await store.getKV('clubStats')) || {};
    S.windConsent = !!(await store.getKV('windConsent'));
    S.mapKey = (await store.getKV('vworldKey')) || null;
    setMapKey(S.mapKey);
  } catch (e) {
    log(`저장소를 열지 못했어요: ${e.message}`, 'error');
    toast('기록 저장소를 열지 못했어요. 이번 사용 내용은 저장되지 않을 수 있어요.', 5000);
  }
  setVoice(S.profile.voice !== false);
  updateLock();

  document.addEventListener('pointerdown', () => unlockAudio(), { passive: true });
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) go(g.dataset.go);
    if (e.target.closest('[data-back]')) goBack();
  });
  $$('.mode').forEach((b) => {
    b.addEventListener('click', () => {
      const m = b.dataset.mode;
      if (m === 'screen') startScreenFlow();
      else if (m === 'field') openField();
      else openImport();
    });
  });
  onEnter('history', renderHistory);
  onEnter('settings', renderSettings);

  checkModels().then((m) => {
    if (m.lite || m.full) return;
    const n = $('#modelNotice');
    n.hidden = false;
    n.innerHTML = '<b>관절 인식 모델 파일이 없어요.</b><br>pose_landmarker_lite.task 파일을 앱 파일들과 같은 곳(깃허브 저장소)에 올려 주세요. 올리기 전에는 분석이 안 돼요.';
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => log(`오프라인 준비 실패: ${e.message}`));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      captureVisible();
      fieldVisible();
    } else {
      fieldHidden();
    }
  });

  log('스윙 랩 시작');
  await checkRecovery();
}

boot();
