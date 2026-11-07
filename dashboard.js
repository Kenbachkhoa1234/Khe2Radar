const SERVER_URL = 'https://khe2-radar.onrender.com';
const socket = io(SERVER_URL, { autoConnect: false, transports: ['websocket', 'polling'] });
const map = L.map('map').setView([10.762622, 106.660172], 16);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

const markers = Object.create(null);
const safeCircles = Object.create(null);
let currentMode = 'NORMAL';
let roomId = 'khe2';
let authenticated = false;
let pendingCredentials = null;

function logEvent(message) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString('vi-VN')}] ${message}`;
  document.getElementById('logs').prepend(line);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function setLoginState(message, error = false) {
  const label = document.getElementById('login-err');
  label.textContent = message;
  label.style.color = error ? '#ff1744' : '#ffea00';
  document.getElementById('login-btn').disabled = !error && Boolean(message);
}

function authenticate() {
  if (pendingCredentials && socket.connected) socket.emit('join_room', { role: 'ADMIN', ...pendingCredentials });
}

function doLogin() {
  roomId = document.getElementById('room-input').value.trim();
  const pin = document.getElementById('pin-input').value.trim();
  if (!roomId || !pin) return setLoginState('Nhập mã nhóm và PIN Admin.', true);
  pendingCredentials = { roomId, pin };
  setLoginState('Đang kết nối máy chủ...');
  if (socket.connected) authenticate(); else socket.connect();
}

function enterDashboard() {
  document.getElementById('login-modal').style.display = 'none';
  document.getElementById('pin-input').value = '';
  setTimeout(() => map.invalidateSize(), 200);
  logEvent(`Đăng nhập thành công vào nhóm [${roomId}].`);
}

function switchMode(mode) {
  if (authenticated) socket.emit('switch_mode', mode);
}

function sendCommand(targetDeviceId, command) {
  if (!authenticated) return logEvent('Bạn chưa đăng nhập.');
  socket.emit('send_command', { targetDeviceId, command });
  logEvent(`Đã gửi lệnh [${command}] tới [${targetDeviceId}].`);
}

function applyMode(mode) {
  currentMode = mode === 'SHIELD' ? 'SHIELD' : 'NORMAL';
  const shield = currentMode === 'SHIELD';
  document.body.classList.toggle('shield-mode', shield);
  document.getElementById('btn-normal').className = `mode-btn${shield ? '' : ' active-normal'}`;
  document.getElementById('btn-shield').className = `mode-btn${shield ? ' active-shield' : ''}`;
  document.getElementById('badge-mode').textContent = shield ? '🔴 RADAR 10M' : '🟢 CHILL MODE';
  if (!shield) Object.keys(safeCircles).forEach((id) => {
    map.removeLayer(safeCircles[id]);
    delete safeCircles[id];
  });
  logEvent(shield ? 'Đã kích hoạt Radar 10m.' : 'Đã chuyển sang chế độ Chill.');
}

function renderDevices(devices = {}) {
  const list = document.getElementById('device-list');
  const ids = Object.keys(devices);
  if (!ids.length) {
    list.textContent = 'Đang chờ máy con kết nối...';
    return;
  }
  list.innerHTML = ids.map((id) => {
    const device = devices[id] || {};
    const safeId = escapeHtml(id);
    const lat = Number(device.lat) || 0;
    const lng = Number(device.lng) || 0;
    const online = Boolean(device.online);
    const disabled = online ? '' : 'disabled';
    const lastSeen = device.lastSeen ? new Date(device.lastSeen).toLocaleTimeString('vi-VN') : 'Chưa rõ';
    return `<div class="device-card ${currentMode === 'SHIELD' && device.isMoving ? 'moving-alert' : ''}">
      <div style="display:flex;justify-content:space-between"><strong>${escapeHtml(device.name || id)}</strong>
        <span>${online ? '🟢' : '⚫'} 🔋 ${Number(device.battery) || 0}% ${device.isCharging ? '⚡' : ''}</span></div>
      <small style="color:#aaa">${device.isMoving ? '🏃 Đang di chuyển' : 'Đứng yên'} | ⏱ ${escapeHtml(lastSeen)}</small>
      <div class="btn-group">
        <button class="action" style="background:#00e676;color:#000" onclick="map.flyTo([${lat},${lng}],18)">📍 Định vị</button>
        <button class="action" style="background:#ff4081;color:#fff" onclick="sendCommand('${safeId}','PING_HEART')" ${disabled}>💖 Thả tim</button>
      </div>
      <div class="shield-actions">
        <button class="action" style="background:#ff9100;color:#000" onclick="sendCommand('${safeId}','RING')" ${disabled}>🔊 Hú còi</button>
        <button class="action" style="background:#2979ff;color:#fff" onclick="sendCommand('${safeId}','LOCK')" ${disabled}>🔒 Khóa</button>
        <button class="action" style="background:#444;color:#fff" onclick="sendCommand('${safeId}','FAKE_SHUTDOWN')" ${disabled}>⬛ Tắt giả</button>
        <button class="action" style="background:#00e676;color:#000" onclick="sendCommand('${safeId}','UNLOCK')" ${disabled}>🔓 Mở</button>
      </div></div>`;
  }).join('');

  ids.forEach((id) => {
    const device = devices[id];
    const lat = Number(device.lat);
    const lng = Number(device.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng)) return;
    if (!markers[id]) markers[id] = L.marker([lat, lng]).addTo(map);
    else markers[id].setLatLng([lat, lng]);
    markers[id].bindPopup(`<b>${escapeHtml(device.name || id)}</b><br>Pin: ${Number(device.battery) || 0}%`);
    if (currentMode === 'SHIELD') {
      if (!safeCircles[id]) safeCircles[id] = L.circle([lat, lng], { color: '#ff1744', fillOpacity: 0.15, radius: 10 }).addTo(map);
      else safeCircles[id].setLatLng([lat, lng]);
    }
  });
}

socket.on('connect', authenticate);
socket.on('auth_success', (data) => {
  if (data?.role !== 'ADMIN') return;
  authenticated = true;
  pendingCredentials = null;
  enterDashboard();
});
socket.on('auth_error', (message) => {
  authenticated = false;
  pendingCredentials = null;
  socket.disconnect();
  setLoginState(String(message || 'Đăng nhập thất bại.'), true);
});
socket.on('connect_error', () => setLoginState('Không kết nối được backend Render. Thử lại sau ít phút.', true));
socket.on('disconnect', () => {
  if (authenticated) logEvent('Mất kết nối server; đang tự kết nối lại.');
  authenticated = false;
});
socket.on('server_error', (message) => logEvent(`Server: ${message}`));
socket.on('mode_changed', applyMode);
socket.on('dashboard_update', renderDevices);
socket.on('dashboard_alert', (alert) => {
  logEvent(`BÁO ĐỘNG [${alert?.name || alert?.deviceId || 'Thiết bị'}]: ${alert?.message || ''}`);
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    oscillator.connect(context.destination);
    oscillator.start();
    setTimeout(() => oscillator.stop(), 500);
  } catch (_) {}
});

document.getElementById('pin-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') doLogin();
});

try {
  const apkUrl = `${SERVER_URL}/khe2-radar.apk`;
  new QRCode(document.getElementById('qrcode'), { text: apkUrl, width: 125, height: 125 });
  document.getElementById('apk-url').href = apkUrl;
} catch (_) {}
