const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Cấu hình phòng và PIN cố định
const ROOM_ID = "khe2";
const ADMIN_PIN = "9999";

let devices = {};
let systemMode = 'NORMAL'; // 'NORMAL' (Option 1: Chill) hoặc 'SHIELD' (Option 2: Radar 10m)

app.use(express.static(__dirname));

// Đường dẫn tải trực tiếp file APK cho máy con
app.get('/khe2-radar.apk', (req, res) => {
    const file = path.join(__dirname, 'khe2-radar.apk');
    res.download(file, 'khe2-radar.apk', (err) => {
        if (err) {
            res.status(404).send("Chưa có file khe2-radar.apk trong thư mục server!");
        }
    });
});

io.on('connection', (socket) => {
    // 1. Phân loại thiết bị gia nhập
    socket.on('join_room', ({ role, roomId, pin, deviceId, name }) => {
        if (roomId !== ROOM_ID) {
            return socket.emit('auth_error', 'Mã nhóm không chính xác!');
        }

        if (role === 'ADMIN') {
            if (pin !== ADMIN_PIN) {
                return socket.emit('auth_error', 'Sai mã PIN Admin!');
            }
            socket.join(ROOM_ID);
            socket.role = 'ADMIN';
            socket.emit('auth_success', { role: 'ADMIN' });
            socket.emit('mode_changed', systemMode);
            socket.emit('dashboard_update', devices);
            console.log('👑 Admin đã kết nối vào trạm.');
        } else if (role === 'CHILD') {
            socket.join(ROOM_ID);
            socket.role = 'CHILD';
            socket.deviceId = deviceId;
            socket.deviceName = name;
            socket.emit('auth_success', { role: 'CHILD' });
            console.log(`📱 Máy con kết nối: ${name} (${deviceId})`);
        }
    });

    // 2. Chuyển đổi giữa 2 chế độ (Chỉ Admin)
    socket.on('switch_mode', (newMode) => {
        if (socket.role !== 'ADMIN') return;
        systemMode = newMode;
        console.log('⚡ [Khe2 Radar] Đổi chế độ:', systemMode);
        io.to(ROOM_ID).emit('mode_changed', systemMode);
    });

    // 3. Nhận dữ liệu cập nhật từ các máy con
    socket.on('device_update', (data) => {
        devices[data.deviceId] = {
            ...data,
            socketId: socket.id,
            online: true,
            lastSeen: new Date().toLocaleTimeString('vi-VN')
        };
        io.to(ROOM_ID).emit('dashboard_update', devices);
    });

    // 4. Nhận cảnh báo khẩn từ máy con (Chỉ kích hoạt khi ở SHIELD)
    socket.on('device_alert', (alertData) => {
        if (systemMode === 'SHIELD') {
            console.log(`🚨 [BÁO ĐỘNG] ${alertData.name}: ${alertData.message}`);
            io.to(ROOM_ID).emit('dashboard_alert', alertData);
        }
    });

    // 5. Truyền lệnh can thiệp xuống máy con (Chỉ Admin)
    socket.on('send_command', ({ targetDeviceId, command }) => {
        if (socket.role !== 'ADMIN') return;
        console.log(`📡 Lệnh điều khiển: [${command}] -> [${targetDeviceId}]`);
        if (targetDeviceId === 'ALL') {
            io.to(ROOM_ID).emit('execute_command', { command });
        } else if (devices[targetDeviceId]) {
            io.to(devices[targetDeviceId].socketId).emit('execute_command', { command });
        }
    });

    // 6. Xóa bớt máy offline trên web
    socket.on('remove_device', (id) => {
        if (socket.role !== 'ADMIN') return;
        delete devices[id];
        io.to(ROOM_ID).emit('dashboard_update', devices);
    });

    socket.on('disconnect', () => {
        for (let id in devices) {
            if (devices[id].socketId === socket.id) {
                devices[id].online = false;
                io.to(ROOM_ID).emit('dashboard_update', devices);
            }
        }
    });
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (let name of Object.keys(interfaces)) {
        for (let iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('====================================================');
    console.log('📡 KHE2 RADAR SERVER ĐÃ HOẠT ĐỘNG!');
    console.log(`👉 Web Quản lý: http://localhost:${PORT}`);
    console.log(`📱 Cấu hình App Android kết nối: http://${ip}:${PORT}`);
    console.log('====================================================');
});