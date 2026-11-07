const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const port = 3217;
const url = `http://127.0.0.1:${port}`;
let serverProcess;

function once(socket, event, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
    socket.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

function connect() {
  return io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
}

before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), ADMIN_PIN: '2468', CHILD_TOKEN: 'device-secret', ALLOWED_ORIGINS: '*' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

after(() => serverProcess?.kill());

test('rejects an untrusted child', async () => {
  const child = connect();
  await once(child, 'connect');
  child.emit('join_room', { role: 'CHILD', roomId: 'khe2', token: 'wrong', deviceId: 'fake' });
  const [message] = await once(child, 'auth_error');
  assert.match(message, /không được cấp quyền/i);
  child.disconnect();
});

test('enforces ADMIN and CHILD permissions end to end', async () => {
  const admin = connect();
  await once(admin, 'connect');
  admin.emit('join_room', { role: 'ADMIN', roomId: 'khe2', pin: '2468' });
  const [adminAuth] = await once(admin, 'auth_success');
  assert.equal(adminAuth.role, 'ADMIN');

  const child = connect();
  await once(child, 'connect');
  child.emit('join_room', { role: 'CHILD', roomId: 'khe2', token: 'device-secret', deviceId: 'phone-1', name: 'Test Phone' });
  const [childAuth] = await once(child, 'auth_success');
  assert.equal(childAuth.role, 'CHILD');

  const dashboardUpdate = once(admin, 'dashboard_update');
  child.emit('device_update', { deviceId: 'spoofed', battery: 77, lat: 10.1, lng: 106.1 });
  const [devices] = await dashboardUpdate;
  assert.equal(devices['phone-1'].battery, 77);
  assert.equal(devices.spoofed, undefined);

  const denied = once(child, 'server_error');
  child.emit('switch_mode', 'SHIELD');
  assert.match((await denied)[0], /không có quyền/i);

  const modeChanged = once(child, 'mode_changed');
  admin.emit('switch_mode', 'SHIELD');
  assert.equal((await modeChanged)[0], 'SHIELD');

  const commandReceived = once(child, 'execute_command');
  admin.emit('send_command', { targetDeviceId: 'phone-1', command: 'RING' });
  assert.equal((await commandReceived)[0].command, 'RING');

  admin.disconnect();
  child.disconnect();
});
