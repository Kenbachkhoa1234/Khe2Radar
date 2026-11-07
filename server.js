const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const ROOM_ID = process.env.ROOM_ID || 'khe2';
const ADMIN_PIN = process.env.ADMIN_PIN || '9999';
const CHILD_TOKEN = process.env.CHILD_TOKEN || 'khe2-device';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://khe2-radar.vercel.app')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

const io = new Server(server, { cors: {
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed'));
  },
  methods: ['GET', 'POST'],
} });

const ADMIN_ROOM = `admins:${ROOM_ID}`;
const CHILD_ROOM = `children:${ROOM_ID}`;
const VALID_MODES = new Set(['NORMAL', 'SHIELD']);
const VALID_COMMANDS = new Set(['PING_HEART', 'RING', 'LOCK', 'FAKE_SHUTDOWN', 'PANIC', 'UNLOCK']);
const devices = Object.create(null);
let systemMode = 'NORMAL';

function safeEqual(received, expected) {
  const left = Buffer.from(String(received || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanText(value, maxLength = 80) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function cleanNumber(value, min, max, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function cleanDeviceId(value) {
  return cleanText(value, 100).replace(/[^a-zA-Z0-9._:-]/g, '_');
}

function publicDevices() {
  return Object.fromEntries(Object.entries(devices).map(([id, device]) => [id, {
    deviceId: id, name: device.name, battery: device.battery,
    isCharging: device.isCharging, isMoving: device.isMoving,
    lat: device.lat, lng: device.lng, online: device.online, lastSeen: device.lastSeen,
  }]));
}

function updateAdmins() {
  io.to(ADMIN_ROOM).emit('dashboard_update', publicDevices());
}

function reject(socket, message, disconnect = false) {
  socket.emit('server_error', message);
  if (disconnect) socket.disconnect(true);
}

function requireRole(socket, role) {
  if (socket.data.role === role) return true;
  reject(socket, 'Bạn không có quyền thực hiện thao tác này.');
  return false;
}

app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({
  ok: true, mode: systemMode,
  connectedDevices: Object.values(devices).filter((device) => device.online).length,
}));

app.get('/khe2-radar.apk', (_req, res) => {
  res.download(path.join(__dirname, 'khe2-radar.apk'), 'khe2-radar.apk', (error) => {
    if (error && !res.headersSent) res.status(404).send('APK chưa được phát hành trên server.');
  });
});

io.on('connection', (socket) => {
  socket.data.authAttempts = 0;

  socket.on('join_room', (payload = {}) => {
    if (socket.data.role) return reject(socket, 'Kết nối này đã được xác thực.');
    socket.data.authAttempts += 1;
    const role = cleanText(payload.role, 10).toUpperCase();
    const roomId = cleanText(payload.roomId, 40);

    if (roomId !== ROOM_ID) {
      socket.emit('auth_error', 'Mã nhóm không chính xác.');
    } else if (role === 'ADMIN' && safeEqual(payload.pin, ADMIN_PIN)) {
      socket.data.role = 'ADMIN';
      socket.join(ADMIN_ROOM);
      socket.emit('auth_success', { role: 'ADMIN', roomId: ROOM_ID });
      socket.emit('mode_changed', systemMode);
      socket.emit('dashboard_update', publicDevices());
    } else if (role === 'CHILD' && safeEqual(payload.token, CHILD_TOKEN)) {
      const deviceId = cleanDeviceId(payload.deviceId);
      if (!deviceId) {
        socket.emit('auth_error', 'Thiết bị không có mã định danh hợp lệ.');
      } else {
        const oldSocketId = devices[deviceId]?.socketId;
        if (oldSocketId && oldSocketId !== socket.id) io.sockets.sockets.get(oldSocketId)?.disconnect(true);
        socket.data.role = 'CHILD';
        socket.data.deviceId = deviceId;
        socket.data.deviceName = cleanText(payload.name, 80) || 'Android';
        socket.join(CHILD_ROOM);
        socket.emit('auth_success', { role: 'CHILD', roomId: ROOM_ID });
        socket.emit('mode_changed', systemMode);
      }
    } else {
      socket.emit('auth_error', role === 'ADMIN' ? 'Sai mã PIN Admin.' : 'Máy con không được cấp quyền.');
    }
    if (!socket.data.role && socket.data.authAttempts >= 5) socket.disconnect(true);
  });

  socket.on('switch_mode', (newMode) => {
    if (!requireRole(socket, 'ADMIN')) return;
    const mode = cleanText(newMode, 10).toUpperCase();
    if (!VALID_MODES.has(mode)) return reject(socket, 'Chế độ không hợp lệ.');
    systemMode = mode;
    io.to(ADMIN_ROOM).to(CHILD_ROOM).emit('mode_changed', systemMode);
  });

  socket.on('device_update', (payload = {}) => {
    if (!requireRole(socket, 'CHILD')) return;
    const deviceId = socket.data.deviceId;
    devices[deviceId] = {
      socketId: socket.id,
      name: socket.data.deviceName,
      battery: Math.round(cleanNumber(payload.battery, 0, 100, 0)),
      isCharging: Boolean(payload.isCharging), isMoving: Boolean(payload.isMoving),
      lat: cleanNumber(payload.lat, -90, 90, 0), lng: cleanNumber(payload.lng, -180, 180, 0),
      online: true, lastSeen: Date.now(),
    };
    updateAdmins();
  });

  socket.on('device_alert', (payload = {}) => {
    if (!requireRole(socket, 'CHILD') || systemMode !== 'SHIELD') return;
    io.to(ADMIN_ROOM).emit('dashboard_alert', {
      deviceId: socket.data.deviceId, name: socket.data.deviceName,
      message: cleanText(payload.message, 200) || 'Thiết bị đang di chuyển.', timestamp: Date.now(),
    });
  });

  socket.on('send_command', (payload = {}) => {
    if (!requireRole(socket, 'ADMIN')) return;
    const targetDeviceId = payload.targetDeviceId === 'ALL' ? 'ALL' : cleanDeviceId(payload.targetDeviceId);
    const command = cleanText(payload.command, 30).toUpperCase();
    if (!VALID_COMMANDS.has(command)) return reject(socket, 'Lệnh không hợp lệ.');
    if (targetDeviceId === 'ALL') {
      io.to(CHILD_ROOM).emit('execute_command', { command, timestamp: Date.now() });
      return;
    }
    const target = devices[targetDeviceId];
    if (!target?.online) return reject(socket, 'Thiết bị đang ngoại tuyến.');
    io.to(target.socketId).emit('execute_command', { command, timestamp: Date.now() });
  });

  socket.on('remove_device', (rawId) => {
    if (!requireRole(socket, 'ADMIN')) return;
    const deviceId = cleanDeviceId(rawId);
    if (devices[deviceId]?.online) return reject(socket, 'Không thể xóa thiết bị đang trực tuyến.');
    delete devices[deviceId];
    updateAdmins();
  });

  socket.on('disconnect', () => {
    const deviceId = socket.data.deviceId;
    if (socket.data.role === 'CHILD' && devices[deviceId]?.socketId === socket.id) {
      devices[deviceId].online = false;
      devices[deviceId].lastSeen = Date.now();
      updateAdmins();
    }
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  if (!process.env.ADMIN_PIN || !process.env.CHILD_TOKEN) {
    console.warn('WARNING: Set ADMIN_PIN and CHILD_TOKEN environment variables in production.');
  }
  console.log(`Khe2 Radar server listening on port ${PORT}.`);
});
