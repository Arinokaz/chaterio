'use strict';

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);

const views = {
  idle: $('view-idle'),
  settings: $('view-settings'),
  create: $('view-create'),
  join: $('view-join'),
  shareAnswer: $('view-share-answer'),
  call: $('view-call'),
};
const statusEl = $('status');

function showView(name) {
  for (const v of Object.values(views)) v.classList.remove('active');
  views[name].classList.add('active');
}

function setStatus(msg, kind = 'info') {
  statusEl.textContent = msg || '';
  if (msg) statusEl.dataset.kind = kind;
  else delete statusEl.dataset.kind;
}

// ---------- Codec: SDP <-> короткая строка (base64 + deflate-raw) ----------
const SUPPORTS_COMPRESSION = typeof CompressionStream !== 'undefined'
  && typeof DecompressionStream !== 'undefined';

async function encodeDesc(desc) {
  const json = JSON.stringify({ type: desc.type, sdp: desc.sdp });
  if (!SUPPORTS_COMPRESSION) {
    // старые браузеры: без сжатия, маркер 'p' (plain)
    return 'p' + bufferToBase64Url(new TextEncoder().encode(json).buffer);
  }
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return 'c' + bufferToBase64Url(buf);
}

async function decodeDesc(str) {
  const cleaned = String(str).trim();
  if (!cleaned) throw new Error('пустой код');

  const marker = cleaned[0];
  const payload = cleaned.slice(1);

  if (marker === 'p') {
    const text = new TextDecoder().decode(base64UrlToBuffer(payload));
    return parseDescJson(text);
  }
  if (marker === 'c') {
    if (!SUPPORTS_COMPRESSION) {
      throw new Error('браузер слишком старый для этого кода (нет DecompressionStream)');
    }
    const stream = new Blob([base64UrlToBuffer(payload)]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return parseDescJson(await new Response(stream).text());
  }

  // Коды старого формата (без маркера) — deflate
  if (!SUPPORTS_COMPRESSION) throw new Error('невалидный код');
  try {
    const stream = new Blob([base64UrlToBuffer(cleaned)]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return parseDescJson(await new Response(stream).text());
  } catch (err) {
    if (err && err.message && /браузер|код chaterio|битый/.test(err.message)) throw err;
    throw new Error('невалидный код');
  }
}

function parseDescJson(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (_) { throw new Error('битый формат кода'); }
  if (!obj || (obj.type !== 'offer' && obj.type !== 'answer') || typeof obj.sdp !== 'string') {
    throw new Error('это не код chaterio');
  }
  return { type: obj.type, sdp: obj.sdp };
}

function bufferToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBuffer(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ---------- Clipboard / Share ----------
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
  return ok;
}

async function shareText(text, title) {
  if (!navigator.share) return { ok: false, reason: 'unsupported' };
  try {
    await navigator.share({ title, text });
    return { ok: true };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'error', err };
  }
}

function flashButton(btn, label, durationMs = 1200) {
  if (!btn) return;
  if (btn.dataset.flashing === '1') return;
  btn.dataset.flashing = '1';
  const prev = btn.textContent;
  btn.textContent = label;
  setTimeout(() => {
    btn.textContent = prev;
    delete btn.dataset.flashing;
  }, durationMs);
}

// ---------- Device settings ----------
const LS_KEYS = {
  cam: 'chaterio.camId',
  mic: 'chaterio.micId',
  spk: 'chaterio.spkId',
};
const supportsSinkId = typeof HTMLMediaElement !== 'undefined'
  && 'setSinkId' in HTMLMediaElement.prototype;

let previewStream = null;

function loadSavedDevices() {
  return {
    camId: localStorage.getItem(LS_KEYS.cam) || '',
    micId: localStorage.getItem(LS_KEYS.mic) || '',
    spkId: localStorage.getItem(LS_KEYS.spk) || '',
  };
}

function saveDevice(kind, id) {
  if (id) localStorage.setItem(LS_KEYS[kind], id);
  else localStorage.removeItem(LS_KEYS[kind]);
}

function hasSavedDevices() {
  const s = loadSavedDevices();
  return Boolean(s.camId || s.micId);
}

function stopPreview() {
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
}

async function startPreview(camId, micId) {
  stopPreview();
  const constraints = {
    video: camId ? { deviceId: { exact: camId } } : true,
    audio: micId ? { deviceId: { exact: micId } } : true,
  };
  try {
    previewStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (err && err.name === 'OverconstrainedError') {
      previewStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      saveDevice('cam', '');
      saveDevice('mic', '');
    } else {
      throw new Error(translateMediaError(err));
    }
  }
  $('settings-preview').srcObject = previewStream;
  $('preview-wrap').classList.add('live');
}

async function listDevicesWithLabels() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  // Если labels пустые (нет разрешения) — короткий temp-stream ради меток
  if (devices.length && !devices.some((d) => d.label)) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      tmp.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (_) {
      // permission denied — пусть UI обработает
    }
  }
  return devices;
}

function fillSelect(select, devices, kind, selectedId) {
  select.innerHTML = '';
  const filtered = devices.filter((d) => d.kind === kind);
  if (filtered.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'Не найдено';
    opt.disabled = true;
    select.appendChild(opt);
    return;
  }
  let matched = false;
  for (const d of filtered) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${kind} (${d.deviceId.slice(0, 6)})`;
    if (d.deviceId && d.deviceId === selectedId) {
      opt.selected = true;
      matched = true;
    }
    select.appendChild(opt);
  }
  if (!matched && selectedId) {
    // сохранённое устройство отвалилось — добавим пометку
    const opt = document.createElement('option');
    opt.value = selectedId;
    opt.textContent = 'Недоступно (отключено)';
    opt.selected = true;
    select.insertBefore(opt, select.firstChild);
  }
}

async function populateSettingsSelects() {
  const devices = await listDevicesWithLabels();
  const s = loadSavedDevices();
  fillSelect($('sel-camera'), devices, 'videoinput', s.camId);
  fillSelect($('sel-mic'), devices, 'audioinput', s.micId);
  fillSelect($('sel-speaker'), devices, 'audiooutput', s.spkId);
  $('field-speaker').hidden = !supportsSinkId;
}

async function populateCallSelects() {
  const devices = await listDevicesWithLabels();
  const s = loadSavedDevices();
  fillSelect($('sel-camera-call'), devices, 'videoinput', s.camId);
  fillSelect($('sel-mic-call'), devices, 'audioinput', s.micId);
  fillSelect($('sel-speaker-call'), devices, 'audiooutput', s.spkId);
  $('field-speaker-call').hidden = !supportsSinkId;
}

function applySpeakerToRemote() {
  if (!supportsSinkId) return;
  const spkId = loadSavedDevices().spkId;
  const v = $('remote-video');
  if (spkId && v && typeof v.setSinkId === 'function') {
    v.setSinkId(spkId).catch((err) => console.warn('setSinkId failed:', err));
  }
}

// ---------- WebRTC ----------
const ICE_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

let pc = null;
let localStream = null;
let remoteStream = null;
let micEnabled = true;
let camEnabled = true;
let currentFacingMode = 'user';
let speakerOn = false;

let currentInviteCode = '';
let currentAnswerCode = '';

// Защита от гонок: busy — от повторного входа, flowGen — от отмены в процессе
let busy = false;
let flowGen = 0;

function cancelFlows() {
  flowGen++;
  busy = false;
}

function waitForIceComplete(connection, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (connection.iceGatheringState === 'complete') return resolve();
    let timer = null;
    const done = () => {
      connection.removeEventListener('icegatheringstatechange', onChange);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (connection.iceGatheringState === 'complete') done();
    };
    connection.addEventListener('icegatheringstatechange', onChange);
    timer = setTimeout(done, timeoutMs);
  });
}

function createPeerConnection() {
  const conn = new RTCPeerConnection(ICE_CONFIG);

  conn.addEventListener('iceconnectionstatechange', () => {
    const s = conn.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      if (!views.call.classList.contains('active')) {
        showView('call');
        updateFlipVisibility();
        updateSpeakerToggle();
      }
      setStatus('Звонок активен');
    } else if (s === 'failed') {
      setStatus('Не удалось установить соединение (попробуй ещё раз)', 'error');
    } else if (s === 'disconnected') {
      setStatus('Связь потеряна', 'error');
    } else if (s === 'checking') {
      setStatus('Проверяю соединение...');
    }
  });

  conn.addEventListener('track', (e) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      $('remote-video').srcObject = remoteStream;
      applySpeakerToRemote();
    }
    remoteStream.addTrack(e.track);
  });

  for (const track of localStream.getTracks()) {
    conn.addTrack(track, localStream);
  }

  return conn;
}

async function getMedia() {
  const { camId, micId } = loadSavedDevices();
  const tryGet = (v, a) => navigator.mediaDevices.getUserMedia({ video: v, audio: a });
  let stream;
  try {
    stream = await tryGet(
      camId ? { deviceId: { exact: camId } } : true,
      micId ? { deviceId: { exact: micId } } : true,
    );
  } catch (err) {
    if (err && err.name === 'OverconstrainedError') {
      stream = await tryGet(true, true);
      saveDevice('cam', '');
      saveDevice('mic', '');
    } else {
      throw new Error(translateMediaError(err));
    }
  }
  localStream = stream;
  $('local-video').srcObject = localStream;
}

function translateMediaError(err) {
  const name = err && err.name;
  if (name === 'NotReadableError') {
    return 'Камера или микрофон уже заняты другим приложением или вкладкой — закрой их и попробуй снова';
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Доступ к камере/микрофону запрещён — разреши его в настройках браузера';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'Камера или микрофон не найдены';
  }
  if (name === 'OverconstrainedError') {
    return 'Запрошенные параметры медиа не поддерживаются устройством';
  }
  if (name === 'SecurityError') {
    return 'Доступ заблокирован политикой безопасности (нужен https:// или localhost)';
  }
  return (err && err.message) || String(err);
}

function setMic(on) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach((t) => (t.enabled = on));
  micEnabled = on;
  $('btn-mute').textContent = on ? 'Mute' : 'Unmute';
  $('btn-mute').classList.toggle('off', !on);
}

function setCam(on) {
  if (!localStream) return;
  localStream.getVideoTracks().forEach((t) => (t.enabled = on));
  camEnabled = on;
  $('btn-camera').textContent = on ? 'Камера' : 'Камера выкл';
  $('btn-camera').classList.toggle('off', !on);
}

function hangUp() {
  cancelFlows();
  closeDevicePanel();
  if (pc) {
    try { pc.close(); } catch (_) {}
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  remoteStream = null;
  $('remote-video').srcObject = null;
  $('local-video').srcObject = null;
  micEnabled = true;
  camEnabled = true;
  currentFacingMode = 'user';
  speakerOn = false;
  $('btn-mute').textContent = 'Mute';
  $('btn-mute').classList.remove('off');
  $('btn-camera').textContent = 'Камера';
  $('btn-camera').classList.remove('off');
  $('btn-flip').hidden = true;
  $('btn-speaker').hidden = true;
  $('btn-speaker').classList.remove('on');
  currentInviteCode = '';
  currentAnswerCode = '';
  setStatus('');
}

// ---------- Settings (pre-call) ----------
async function openSettings() {
  showView('settings');
  try {
    await populateSettingsSelects();
    const { camId, micId } = loadSavedDevices();
    await startPreview(camId, micId);
  } catch (err) {
    setStatus(err.message || String(err), 'error');
  }
}

function closeSettings() {
  stopPreview();
  $('settings-preview').srcObject = null;
  $('preview-wrap').classList.remove('live');
  showView('idle');
}

function wireSettingsSelects() {
  const onChange = async () => {
    const camId = $('sel-camera').value;
    const micId = $('sel-mic').value;
    const spkId = $('sel-speaker').value;
    saveDevice('cam', camId);
    saveDevice('mic', micId);
    saveDevice('spk', spkId);
    try {
      await startPreview(camId, micId);
    } catch (err) {
      setStatus(err.message || String(err), 'error');
    }
  };
  $('sel-camera').addEventListener('change', onChange);
  $('sel-mic').addEventListener('change', onChange);
  $('sel-speaker').addEventListener('change', onChange);
}

// ---------- In-call device panel ----------
function openDevicePanel() {
  $('device-panel').hidden = false;
  populateCallSelects().catch((err) => console.warn(err));
}

function closeDevicePanel() {
  $('device-panel').hidden = true;
}

async function replaceTrackInCall(kind, deviceId, label) {
  if (!pc || !localStream) return;
  const constraints = kind === 'video'
    ? { video: { deviceId: { exact: deviceId } } }
    : { audio: { deviceId: { exact: deviceId } } };
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    setStatus('Не удалось переключить ' + label + ': ' + (err.message || err), 'error');
    return;
  }
  const newTrack = newStream.getTracks()[0];
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === kind);
  if (sender) {
    try {
      await sender.replaceTrack(newTrack);
    } catch (err) {
      setStatus('Ошибка замены трека: ' + (err.message || err), 'error');
      newTrack.stop();
      return;
    }
  }
  const oldTracks = kind === 'video' ? localStream.getVideoTracks() : localStream.getAudioTracks();
  oldTracks.forEach((t) => {
    localStream.removeTrack(t);
    t.stop();
  });
  localStream.addTrack(newTrack);
  // синхронизируем текущее состояние mute/cam с новым треком
  if (kind === 'audio') newTrack.enabled = micEnabled;
  if (kind === 'video') newTrack.enabled = camEnabled;
  saveDevice(kind === 'video' ? 'cam' : 'mic', deviceId);
  setStatus(label + ' переключен(а)', 'ok');
}

function switchSpeakerInCall(deviceId) {
  if (!supportsSinkId) return;
  const v = $('remote-video');
  if (!v || typeof v.setSinkId !== 'function') return;
  v.setSinkId(deviceId)
    .then(() => {
      saveDevice('spk', deviceId);
      updateSpeakerToggle();
    })
    .catch((err) => {
      setStatus('Не удалось переключить динамик: ' + (err.message || err), 'error');
    });
}

function wireCallDeviceSelects() {
  $('sel-camera-call').addEventListener('change', (e) => replaceTrackInCall('video', e.target.value, 'Камера'));
  $('sel-mic-call').addEventListener('change', (e) => replaceTrackInCall('audio', e.target.value, 'Микрофон'));
  $('sel-speaker-call').addEventListener('change', (e) => switchSpeakerInCall(e.target.value));
}

// ---------- Camera flip (front <-> back) ----------
async function acquireVideoTrack(facing) {
  const tryC = async (c) => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: c, audio: false });
      return s.getVideoTracks()[0] || null;
    } catch (_) {
      return null;
    }
  };
  return (
    (await tryC({ facingMode: { exact: facing } })) ||
    (await tryC({ facingMode: { ideal: facing } })) ||
    (await tryC(true))
  );
}

let flipping = false;

async function flipCamera() {
  if (!pc || !localStream || flipping) return;
  flipping = true;
  try {
    const target = currentFacingMode === 'user' ? 'environment' : 'user';
    setStatus('Переключаю камеру...');

    // iOS Safari требует остановить старый трек до открытия второй камеры
    const oldTrack = localStream.getVideoTracks()[0];
    if (oldTrack) {
      oldTrack.stop();
      localStream.removeTrack(oldTrack);
    }

    const newTrack = await acquireVideoTrack(target);
    if (!newTrack) {
      setStatus('Не удалось переключить камеру', 'error');
      // попробуем вернуть прежнюю камеру
      const prevFacing = target === 'user' ? 'environment' : 'user';
      const fallback = await acquireVideoTrack(prevFacing);
      if (fallback) {
        localStream.addTrack(fallback);
        const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
        if (s) {
          try { await s.replaceTrack(fallback); } catch (_) {}
        }
        fallback.enabled = camEnabled;
        let fs = {};
        try { fs = fallback.getSettings(); } catch (_) {}
        currentFacingMode = (fs.facingMode === 'user' || fs.facingMode === 'environment')
          ? fs.facingMode
          : prevFacing;
      }
      updateFlipVisibility();
      return;
    }

    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch (err) {
        newTrack.stop();
        setStatus('Ошибка замены трека: ' + (err.message || err), 'error');
        updateFlipVisibility();
        return;
      }
    }
    localStream.addTrack(newTrack);
    newTrack.enabled = camEnabled;

    let settings = {};
    try { settings = newTrack.getSettings(); } catch (_) {}
    currentFacingMode = (settings && (settings.facingMode === 'user' || settings.facingMode === 'environment'))
      ? settings.facingMode
      : target;

    setStatus(currentFacingMode === 'user' ? 'Фронтальная камера' : 'Основная камера', 'ok');
  } finally {
    flipping = false;
  }
}

async function updateFlipVisibility() {
  const btn = $('btn-flip');
  if (!btn) return;
  if (!localStream) { btn.hidden = true; return; }
  const track = localStream.getVideoTracks()[0];
  if (!track) { btn.hidden = true; return; }
  let settings = {};
  try { settings = track.getSettings(); } catch (_) {}
  const facing = settings && settings.facingMode;
  if (facing !== 'user' && facing !== 'environment') { btn.hidden = true; return; }
  currentFacingMode = facing;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const count = devices.filter((d) => d.kind === 'videoinput').length;
    btn.hidden = count < 2;
  } catch (_) {
    btn.hidden = true;
  }
}

// ---------- Speaker toggle (loud / earpiece) ----------
const SPEAKER_LABEL_RE = /speaker|громк|динамик|spk|loudspeaker/i;

async function updateSpeakerToggle() {
  const btn = $('btn-speaker');
  if (!btn) return;
  if (!supportsSinkId) { btn.hidden = true; return; }
  if (!views.call.classList.contains('active')) { btn.hidden = true; return; }
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (_) { btn.hidden = true; return; }
  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  if (outputs.length < 2) { btn.hidden = true; return; }
  btn.hidden = false;

  const v = $('remote-video');
  const sinkId = v ? (v.sinkId || '') : '';
  const speaker = outputs.find((d) => SPEAKER_LABEL_RE.test(d.label));
  speakerOn = Boolean(speaker && speaker.deviceId === sinkId);
  btn.classList.toggle('on', speakerOn);
}

async function toggleSpeaker() {
  if (!supportsSinkId) return;
  const v = $('remote-video');
  if (!v || typeof v.setSinkId !== 'function') return;

  let outputs;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    outputs = devices.filter((d) => d.kind === 'audiooutput');
  } catch (err) {
    setStatus('Не удалось получить список динамиков', 'error');
    return;
  }
  if (outputs.length < 2) {
    setStatus('Доступен только один динамик', 'error');
    return;
  }

  const currentSinkId = v.sinkId || '';
  const speaker = outputs.find((d) => SPEAKER_LABEL_RE.test(d.label));
  const currentIsSpeaker = Boolean(speaker && speaker.deviceId === currentSinkId);

  let target;
  if (currentIsSpeaker) {
    target = outputs.find((d) => d.deviceId !== (speaker && speaker.deviceId)) || outputs[0];
  } else {
    target = speaker || outputs.find((d) => d.deviceId !== currentSinkId) || outputs[0];
  }
  if (!target) { setStatus('Не удалось выбрать динамик', 'error'); return; }

  try {
    await v.setSinkId(target.deviceId);
  } catch (err) {
    setStatus('Не удалось переключить динамик: ' + (err.message || err), 'error');
    return;
  }

  speakerOn = !currentIsSpeaker;
  saveDevice('spk', target.deviceId);

  const btn = $('btn-speaker');
  if (btn) btn.classList.toggle('on', speakerOn);
  const sel = $('sel-speaker-call');
  if (sel) sel.value = target.deviceId;

  setStatus(speakerOn ? 'Громкая связь' : 'Динамик телефона', 'ok');
}

// ---------- Initiator ----------
async function startAsInitiator() {
  if (busy) return;
  busy = true;
  const gen = ++flowGen;
  try {
    setStatus('Запрашиваю доступ к камере и микрофону...');
    await getMedia();
    if (gen !== flowGen) return;
    setStatus('Готовлю предложение...');
    pc = createPeerConnection();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceComplete(pc);
    if (gen !== flowGen) return;

    currentInviteCode = await encodeDesc(pc.localDescription);
    if (gen !== flowGen) return;
    setStatus('Код готов — отправь его другу');
    showView('create');
  } catch (err) {
    console.error(err);
    setStatus('Ошибка: ' + (err.message || err), 'error');
    hangUp();
    showView('idle');
  } finally {
    if (gen === flowGen) busy = false;
  }
}

async function acceptAnswer() {
  const code = $('answer-input').value.trim();
  if (!code) {
    setStatus('Вставь ответный код', 'error');
    return;
  }
  if (!pc) {
    setStatus('Звонок отменён — начни заново', 'error');
    return;
  }
  let desc;
  try {
    desc = await decodeDesc(code);
  } catch (err) {
    console.error(err);
    setStatus('Невалидный код: ' + (err.message || err), 'error');
    return;
  }
  try {
    setStatus('Подключаюсь...');
    await pc.setRemoteDescription(desc);
  } catch (err) {
    console.error(err);
    setStatus('Не удалось подключиться: ' + (err.message || err), 'error');
  }
}

// ---------- Answerer ----------
async function joinAsAnswerer() {
  if (busy) return;
  busy = true;
  const gen = ++flowGen;
  const code = $('invite-input').value.trim();
  if (!code) {
    setStatus('Вставь код приглашения', 'error');
    busy = false;
    return;
  }
  let offerDesc;
  try {
    offerDesc = await decodeDesc(code);
  } catch (err) {
    console.error(err);
    setStatus('Невалидный код: ' + (err.message || err), 'error');
    busy = false;
    return;
  }
  try {
    setStatus('Запрашиваю доступ к камере и микрофону...');
    await getMedia();
    if (gen !== flowGen) return;
    setStatus('Готовлю ответ...');
    pc = createPeerConnection();

    await pc.setRemoteDescription(offerDesc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceComplete(pc);
    if (gen !== flowGen) return;

    currentAnswerCode = await encodeDesc(pc.localDescription);
    if (gen !== flowGen) return;
    setStatus('Отправь ответный код инициатору');
    showView('shareAnswer');
  } catch (err) {
    console.error(err);
    setStatus('Не удалось подключиться: ' + (err.message || err), 'error');
    hangUp();
    showView('idle');
  } finally {
    if (gen === flowGen) busy = false;
  }
}

// ---------- Button handlers: Copy / Share ----------
async function handleCopy(code, btn, label) {
  if (!code) return;
  const ok = await copyToClipboard(code);
  if (ok) {
    setStatus(label + ' скопирован', 'ok');
    flashButton(btn, 'Скопировано');
  } else {
    setStatus('Не удалось скопировать — выдели и скопируй вручную', 'error');
  }
}

async function handleShare(code, label) {
  if (!code) return;
  const res = await shareText(code, 'Код для chaterio');
  if (res.ok) {
    setStatus(label + ' отправлен', 'ok');
  } else if (res.reason === 'cancelled') {
    // пользователь закрыл шторку — молча
  } else if (res.reason === 'unsupported') {
    setStatus('Твой браузер не поддерживает отправку — используй «Скопировать»', 'error');
  } else {
    setStatus('Не удалось отправить: ' + ((res.err && res.err.message) || ''), 'error');
  }
}

// ---------- Wire up ----------
$('btn-create').addEventListener('click', startAsInitiator);
$('btn-join').addEventListener('click', () => {
  $('invite-input').value = '';
  showView('join');
});
$('btn-accept-invite').addEventListener('click', joinAsAnswerer);
$('btn-accept-answer').addEventListener('click', acceptAnswer);

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-done').addEventListener('click', closeSettings);

$('btn-copy-invite').addEventListener('click', (e) => handleCopy(currentInviteCode, e.currentTarget, 'Код приглашения'));
$('btn-share-invite').addEventListener('click', () => handleShare(currentInviteCode, 'Код приглашения'));
$('btn-copy-answer').addEventListener('click', (e) => handleCopy(currentAnswerCode, e.currentTarget, 'Ответный код'));
$('btn-share-answer').addEventListener('click', () => handleShare(currentAnswerCode, 'Ответный код'));

$('btn-mute').addEventListener('click', () => setMic(!micEnabled));
$('btn-camera').addEventListener('click', () => setCam(!camEnabled));
$('btn-flip').addEventListener('click', () => flipCamera());
$('btn-speaker').addEventListener('click', () => toggleSpeaker());
$('btn-devices').addEventListener('click', openDevicePanel);
$('btn-devices-close').addEventListener('click', closeDevicePanel);
$('btn-hangup').addEventListener('click', () => {
  hangUp();
  showView('idle');
});

// Тап по затемнённому фону панели устройств — закрыть
$('device-panel').addEventListener('click', (e) => {
  if (e.target === $('device-panel')) closeDevicePanel();
});

document.querySelectorAll('[data-back]').forEach((b) => {
  b.addEventListener('click', () => {
    stopPreview();
    hangUp();
    showView('idle');
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('device-panel').hidden) {
    closeDevicePanel();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (views.join.classList.contains('active')) joinAsAnswerer();
    else if (views.create.classList.contains('active')) acceptAnswer();
  }
});

// Если браузер не умеет шарить — спрячем кнопку
if (!navigator.share) {
  document.querySelectorAll('.code-actions .primary').forEach((b) => {
    b.style.display = 'none';
  });
}

// Если воткнули/выдернули устройство — обновим открытые списки
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    try {
      if (views.settings.classList.contains('active')) await populateSettingsSelects();
      if (!$('device-panel').hidden) await populateCallSelects();
      if (views.call.classList.contains('active')) {
        await updateFlipVisibility();
        await updateSpeakerToggle();
      }
    } catch (_) { /* ignore */ }
  });
}

wireSettingsSelects();
wireCallDeviceSelects();

// Первый визит (нет сохранённых устройств) — открыть настройки автоматически
if (!hasSavedDevices()) {
  // даём браузеру отрисовать idle-экран, потом открываем
  requestAnimationFrame(() => openSettings());
}

window.addEventListener('error', (e) => {
  console.error(e);
});

// Закрытие вкладки в звонке — приберём за собой, чтобы вторая сторона
// не ждала ICE-таймаут на замёрзшем видео
window.addEventListener('pagehide', () => {
  if (pc) {
    try { pc.close(); } catch (_) {}
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
  }
});
