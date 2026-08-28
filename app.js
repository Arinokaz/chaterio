'use strict';

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);

const views = {
  idle: $('view-idle'),
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
async function encodeDesc(desc) {
  const json = JSON.stringify({ type: desc.type, sdp: desc.sdp });
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return bufferToBase64Url(buf);
}

async function decodeDesc(str) {
  const cleaned = String(str).trim();
  const buf = base64UrlToBuffer(cleaned);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const text = await new Response(stream).text();
  const { type, sdp } = JSON.parse(text);
  return { type, sdp };
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

// ---------- WebRTC ----------
const ICE_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

let pc = null;
let localStream = null;
let remoteStream = null;
let micEnabled = true;
let camEnabled = true;

function waitForIceComplete(connection, timeoutMs = 4000) {
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
      if (!views.call.classList.contains('active')) showView('call');
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
    }
    remoteStream.addTrack(e.track);
  });

  for (const track of localStream.getTracks()) {
    conn.addTrack(track, localStream);
  }

  return conn;
}

async function getMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    $('local-video').srcObject = localStream;
  } catch (err) {
    throw new Error(translateMediaError(err));
  }
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
  $('btn-mute').textContent = 'Mute';
  $('btn-mute').classList.remove('off');
  $('btn-camera').textContent = 'Камера';
  $('btn-camera').classList.remove('off');
  setStatus('');
}

// ---------- Initiator ----------
async function startAsInitiator() {
  try {
    setStatus('Запрашиваю доступ к камере и микрофону...');
    await getMedia();
    setStatus('Готовлю предложение...');
    pc = createPeerConnection();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceComplete(pc);

    const inviteCode = await encodeDesc(pc.localDescription);
    $('invite-code').value = inviteCode;
    setStatus('Код готов — отправь его другу');
    showView('create');
  } catch (err) {
    console.error(err);
    setStatus('Ошибка: ' + (err.message || err), 'error');
    hangUp();
    showView('idle');
  }
}

async function acceptAnswer() {
  const code = $('answer-input').value.trim();
  if (!code) {
    setStatus('Вставь ответный код', 'error');
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
    // iceconnectionstatechange в createPeerConnection переключит на view-call
  } catch (err) {
    console.error(err);
    setStatus('Не удалось подключиться: ' + (err.message || err), 'error');
  }
}

// ---------- Answerer ----------
async function joinAsAnswerer() {
  const code = $('invite-input').value.trim();
  if (!code) {
    setStatus('Вставь код приглашения', 'error');
    return;
  }
  let offerDesc;
  try {
    offerDesc = await decodeDesc(code);
  } catch (err) {
    console.error(err);
    setStatus('Невалидный код: ' + (err.message || err), 'error');
    return;
  }
  try {
    setStatus('Запрашиваю доступ к камере и микрофону...');
    await getMedia();
    setStatus('Готовлю ответ...');
    pc = createPeerConnection();

    await pc.setRemoteDescription(offerDesc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceComplete(pc);

    const answerCode = await encodeDesc(pc.localDescription);
    $('answer-code').value = answerCode;
    setStatus('Отправь ответный код инициатору');
    showView('shareAnswer');
  } catch (err) {
    console.error(err);
    setStatus('Не удалось подключиться: ' + (err.message || err), 'error');
    hangUp();
    showView('idle');
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
$('btn-mute').addEventListener('click', () => setMic(!micEnabled));
$('btn-camera').addEventListener('click', () => setCam(!camEnabled));
$('btn-hangup').addEventListener('click', () => {
  hangUp();
  showView('idle');
});

document.querySelectorAll('[data-back]').forEach((b) => {
  b.addEventListener('click', () => {
    hangUp();
    showView('idle');
  });
});

// Удобство: клик по readonly textarea выделяет весь текст
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.matches && t.matches('textarea[readonly]')) t.select();
});

// Ctrl/Cmd+Enter в полях ввода = submit
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (views.join.classList.contains('active')) joinAsAnswerer();
    else if (views.create.classList.contains('active')) acceptAnswer();
  }
});

// Глобальный обработчик ошибок getUserMedia и прочего
window.addEventListener('error', (e) => {
  console.error(e);
});
