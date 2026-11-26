/**
 * Cầu nối đồng bộ dữ liệu thời gian thực từ Render Cloud về MySQL cục bộ
 * Hiển thị gói tin truyền nhận dưới Terminal theo chuẩn JSON (bao gồm sound_db)
 *
 * Cài thư viện: npm install socket.io-client mysql2 dotenv
 * Chạy:         node sync_mysql.js
 */
require('dotenv').config();
const { io } = require('socket.io-client');
const mysql = require('mysql2/promise');

const CLOUD_URL = process.env.CLOUD_URL || 'https://musicbox-ai-iot.onrender.com';
const LOG_INTERVAL_MS = 5000; // Ghi 1 bản ghi sensor_logs mỗi 5 giây

let dbPool = null;
let lastSensorLogTime = 0;

async function initMySQL() {
  dbPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'musicbox_iot_db',
    waitForConnections: true,
    connectionLimit: 5,
    charset: 'utf8mb4'
  });

  await dbPool.query('SELECT 1');

  // Tự động bổ sung cột sound_db nếu bảng sensor_logs cũ chưa có (giữ nguyên toàn bộ dữ liệu cũ)
  const [cols] = await dbPool.query("SHOW COLUMNS FROM sensor_logs LIKE 'sound_db'");
  if (cols.length === 0) {
    await dbPool.query(
      'ALTER TABLE sensor_logs ADD COLUMN sound_db INT NOT NULL DEFAULT 35 AFTER light'
    );
    console.log('[MySQL] Đã tự động thêm cột sound_db vào bảng sensor_logs.');
  }

  console.log(`[MySQL] Đã kết nối thành công tới database: ${process.env.DB_NAME || 'musicbox_iot_db'}`);
}

async function saveSensor(state) {
  if (!dbPool || !state) return;
  if (!state.online && state.temp === 0 && state.hum === 0 && !state.soundDb) return;

  const now = Date.now();
  if (now - lastSensorLogTime < LOG_INTERVAL_MS) return;
  lastSensorLogTime = now;

  // Gói tin JSON chuẩn hiển thị dưới Terminal
  const jsonPacket = {
    event: 'telemetry',
    device_id: 'ESP32_MusicBox',
    timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }),
    sensors: {
      temp: Number(state.temp || 0),
      hum: Number(state.hum || 0),
      light: Number(state.light || 0),
      sound_db: Number(state.soundDb || 35),
      bat_pct: Number(state.bat ?? -1),
      bat_v: Number(state.batV || 0)
    },
    clock: {
      time: String(state.timeStr || '--:--:--'),
      alarm: String(state.alarmStr || '--:--'),
      alarm_on: Boolean(state.alarmOn)
    },
    mode: Number(state.mode || 5),
    vol: Number(state.vol || 0),
    ringtone: String(state.ringtone || '')
  };

  console.log('[RX JSON]', JSON.stringify(jsonPacket));

  try {
    const [result] = await dbPool.execute(
      `INSERT INTO sensor_logs (device_id, temp, hum, light, sound_db, bat_pct, bat_v, mode, alarm_str, alarm_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jsonPacket.device_id,
        jsonPacket.sensors.temp,
        jsonPacket.sensors.hum,
        jsonPacket.sensors.light,
        jsonPacket.sensors.sound_db,
        jsonPacket.sensors.bat_pct,
        jsonPacket.sensors.bat_v,
        jsonPacket.mode,
        jsonPacket.clock.alarm,
        jsonPacket.clock.alarm_on ? 1 : 0
      ]
    );
    console.log('[DB OK]  ', JSON.stringify({ table: 'sensor_logs', insertId: result.insertId, sound_db: jsonPacket.sensors.sound_db, status: 'SAVED' }));
  } catch (err) {
    console.error('[DB ERR] ', JSON.stringify({ table: 'sensor_logs', error: err.message }));
  }
}

async function saveChat(msg) {
  if (!dbPool || !msg || !msg.text) return;

  const chatPacket = {
    event: 'chat',
    sender: String(msg.sender || 'Unknown'),
    message: String(msg.text),
    time: String(msg.time || '')
  };
  console.log('[RX JSON]', JSON.stringify(chatPacket));

  try {
    const [result] = await dbPool.execute(
      `INSERT INTO chat_logs (sender, message) VALUES (?, ?)`,
      [chatPacket.sender, chatPacket.message]
    );
    console.log('[DB OK]  ', JSON.stringify({ table: 'chat_logs', insertId: result.insertId, status: 'SAVED' }));
  } catch (err) {
    console.error('[DB ERR] ', JSON.stringify({ table: 'chat_logs', error: err.message }));
  }
}

async function main() {
  await initMySQL();

  console.log(`[CLOUD] Đang kết nối Socket.IO tới ${CLOUD_URL} ...`);
  const socket = io(CLOUD_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true
  });

  socket.on('connect', () => {
    console.log('[CLOUD]  ', JSON.stringify({ status: 'CONNECTED', server: CLOUD_URL, socketId: socket.id }));
  });

  socket.on('init', (payload) => {
    if (payload && payload.deviceState) {
      saveSensor(payload.deviceState);
    }
  });

  socket.on('telemetry', (state) => {
    saveSensor(state);
  });

  socket.on('chat', (msg) => {
    saveChat(msg);
  });

  socket.on('disconnect', (reason) => {
    console.log('[CLOUD]  ', JSON.stringify({ status: 'DISCONNECTED', reason }));
  });
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});