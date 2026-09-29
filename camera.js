// 카메라와 녹화
import { log, nowMs } from './util.js';

const PLAIN_BACK = /^(back camera|back wide camera|후면 카메라|후면 광각 카메라|뒷면 카메라)$/i;

export async function openCamera({ fps = 60, width = 1280, height = 720, deviceId = null } = {}) {
  const video = { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: 'environment' };
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  let stream = await navigator.mediaDevices.getUserMedia({ video, audio });
  let track = stream.getVideoTracks()[0];

  // 렌즈가 저절로 바뀌지 않게 기본 광각 후면 카메라로 고정해요
  if (!deviceId) {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const plain = cams.find((d) => PLAIN_BACK.test((d.label || '').trim()));
      if (plain && plain.deviceId !== track.getSettings().deviceId) {
        stream.getTracks().forEach((t) => t.stop());
        const fixed = { width: video.width, height: video.height, frameRate: video.frameRate, deviceId: { exact: plain.deviceId } };
        stream = await navigator.mediaDevices.getUserMedia({ video: fixed, audio });
        track = stream.getVideoTracks()[0];
      }
    } catch (e) {
      log(`렌즈 고정 실패, 기본 카메라로 계속해요 (${e.message})`);
    }
  }
  const st = track.getSettings?.() || {};
  log(`카메라 켜짐: ${track.label || '카메라'} ${st.width || '?'}×${st.height || '?'} ${st.frameRate ? Math.round(st.frameRate) : '?'}fps (요청 ${fps}fps)`);
  return { stream, track, settings: st };
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function pickMime() {
  if (!window.MediaRecorder) return null;
  return ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export class ClipRecorder {
  constructor(stream) {
    this.stream = stream;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mime = '';
  }

  get active() {
    return !!this.rec && this.rec.state === 'recording';
  }

  start() {
    const mime = pickMime();
    if (mime === null) throw new Error('이 기기는 녹화를 지원하지 않아요.');
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, videoBitsPerSecond: 10000000 } : undefined);
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.start();
    this.startedAt = nowMs();
    this.mime = this.rec.mimeType || mime || 'video/mp4';
  }

  stop() {
    return new Promise((resolve) => {
      const r = this.rec;
      if (!r || r.state === 'inactive') {
        resolve(null);
        return;
      }
      r.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime || 'video/mp4' });
        this.rec = null;
        resolve({ blob, mime: blob.type, startedAt: this.startedAt, seconds: (nowMs() - this.startedAt) / 1000 });
      };
      r.stop();
    });
  }

  cancel() {
    const r = this.rec;
    this.rec = null;
    this.chunks = [];
    if (r && r.state !== 'inactive') {
      r.onstop = null;
      r.ondataavailable = null;
      try {
        r.stop();
      } catch {
        /* 무시 */
      }
    }
  }
}
