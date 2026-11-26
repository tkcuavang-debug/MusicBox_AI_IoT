require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const REPLY_MP3_PATH = path.join(__dirname, 'latest_reply.mp3');

let mysql = null;
try {
  mysql = require('mysql2/promise');
} catch (e) {
  console.log('[DB] Chua cai mysql2, bo qua luu MySQL (chay: npm install mysql2)');
}

let dbPool = null;
let lastDbLogTime = 0;
let lastHistoryPushTime = 0;
const DB_LOG_INTERVAL_MS = 5000;
const MAX_RAM_HISTORY = 100;

async function initDatabase() {
  if (!mysql || !process.env.DB_HOST) {
    console.log('[DB] Chua cau hinh DB_HOST trong .env -> chi chay che do RAM/Cloud.');
    return;
  }
  try {
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
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS sensor_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(32) NOT NULL DEFAULT 'ESP32_MusicBox',
        temp FLOAT NOT NULL,
        hum FLOAT NOT NULL,
        light INT NOT NULL,
        bat_pct INT NOT NULL,
        bat_v FLOAT NOT NULL,
        mode INT NOT NULL,
        alarm_str VARCHAR(10) DEFAULT '--:--',
        alarm_on TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS control_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        source VARCHAR(32) NOT NULL,
        command VARCHAR(100) NOT NULL,
        detail VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS chat_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender VARCHAR(32) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log(`[DB] Da ket noi MySQL thanh cong: ${process.env.DB_NAME || 'musicbox_iot_db'}`);
  } catch (err) {
    console.error('[DB ERR] Khong ket noi duoc MySQL:', err.message);
    dbPool = null;
  }
}

async function logSensorToDb(state) {
  if (!dbPool) return;
  const now = Date.now();
  if (now - lastDbLogTime < DB_LOG_INTERVAL_MS) return;
  lastDbLogTime = now;
  try {
    await dbPool.execute(
      `INSERT INTO sensor_logs (device_id, temp, hum, light, bat_pct, bat_v, mode, alarm_str, alarm_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'ESP32_MusicBox',
        Number(state.temp || 0),
        Number(state.hum || 0),
        Number(state.light || 0),
        Number(state.bat ?? -1),
        Number(state.batV || 0),
        Number(state.mode || 5),
        String(state.alarmStr || '--:--'),
        state.alarmOn ? 1 : 0
      ]
    );
  } catch (err) {
    console.error('[DB INSERT sensor_logs ERR]', err.message);
  }
}

async function logControlToDb(source, command, detail = '') {
  if (!dbPool || !command || command === 'NONE') return;
  try {
    await dbPool.execute(
      `INSERT INTO control_logs (source, command, detail) VALUES (?, ?, ?)`,
      [String(source), String(command), String(detail)]
    );
  } catch (err) {
    console.error('[DB INSERT control_logs ERR]', err.message);
  }
}

async function logChatToDb(sender, message) {
  if (!dbPool || !message) return;
  try {
    await dbPool.execute(
      `INSERT INTO chat_logs (sender, message) VALUES (?, ?)`,
      [String(sender), String(message)]
    );
  } catch (err) {
    console.error('[DB INSERT chat_logs ERR]', err.message);
  }
}

initDatabase();

let deviceState = {
  temp: 0,
  hum: 0,
  light: 0,
  soundDb: 35,
  soundPct: 0,
  soundSource: 'Chờ tín hiệu Mic',
  bat: -1,
  batV: 0,
  usbPower: true,
  charging: false,
  timeStr: '--:--:--',
  alarmStr: '--:--',
  alarmOn: false,
  ringtone: 'Chua chon',
  mode: 5,
  vol: 60,
  aiPlaying: false,
  currentSong: '',
  currentSongIndex: -1,
  songList: [],
  displayList: [],
  online: false,
  lastSeen: 0
};

const romajiCache = new Map();

let chatHistory = [];
let sensorHistory = [];
let historySeq = 1;
let pendingCommand = 'NONE';
let hasNewAudioForEsp = false;
let lastGeminiError = 'None';

function formatVnTime(date = new Date()) {
  return date.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function recordSensorHistory(state) {
  const now = Date.now();
  if (now - lastHistoryPushTime < DB_LOG_INTERVAL_MS) return null;
  lastHistoryPushTime = now;
  const entry = {
    id: historySeq++,
    created_at: formatVnTime(new Date(now)),
    timeStr: state.timeStr || '--:--:--',
    temp: Number(state.temp || 0),
    hum: Number(state.hum || 0),
    light: Number(state.light || 0),
    soundDb: Number(state.soundDb || 35),
    bat_pct: Number(state.bat ?? -1),
    bat_v: Number(state.batV || 0),
    usbPower: Boolean(state.usbPower),
    mode: Number(state.mode || 5),
    alarm_str: String(state.alarmStr || '--:--'),
    alarm_on: state.alarmOn ? 1 : 0
  };
  sensorHistory.unshift(entry);
  if (sensorHistory.length > MAX_RAM_HISTORY) sensorHistory.pop();
  io.emit('sensor_history_entry', entry);
  return entry;
}

function pushChat(sender, text) {
  const msg = {
    sender,
    text,
    time: new Date().toLocaleTimeString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit'
    })
  };
  chatHistory.push(msg);
  if (chatHistory.length > 40) chatHistory.shift();
  io.emit('chat', msg);
  logChatToDb(sender, text);
}

function applyOptimisticCommandState(rawCmd) {
  const cmd = String(rawCmd || '').trim();
  if (!cmd || cmd === 'NONE') return;

  if (cmd === 'AI_STOP') {
    deviceState.aiPlaying = false;
    io.emit('telemetry', deviceState);
    return;
  }

  if (cmd === 'AI_RESUME') {
    if (deviceState.songList.length > 0 || deviceState.currentSong) {
      deviceState.aiPlaying = true;
      io.emit('telemetry', deviceState);
    }
    return;
  }

  if (cmd === 'AI_PLAY') {
    if (deviceState.songList.length > 0) {
      const idx = deviceState.currentSongIndex >= 0
        ? deviceState.currentSongIndex % deviceState.songList.length
        : 0;
      deviceState.currentSongIndex = idx;
      deviceState.currentSong = deviceState.displayList[idx] || basicCleanAscii(deviceState.songList[idx]);
      deviceState.aiPlaying = true;
      io.emit('telemetry', deviceState);
    }
    return;
  }

  if (cmd.startsWith('AI_PLAY:')) {
    const param = cmd.slice('AI_PLAY:'.length).trim();
    const num = parseInt(param, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= deviceState.songList.length) {
      const idx = num - 1;
      deviceState.currentSongIndex = idx;
      deviceState.currentSong = deviceState.displayList[idx] || basicCleanAscii(deviceState.songList[idx]);
      deviceState.aiPlaying = true;
      io.emit('telemetry', deviceState);
    } else if (param) {
      const idx = findBestSongIndexServer(param);
      if (idx >= 0) {
        deviceState.currentSongIndex = idx;
        deviceState.currentSong = deviceState.displayList[idx] || basicCleanAscii(deviceState.songList[idx]);
        deviceState.aiPlaying = true;
        io.emit('telemetry', deviceState);
      }
    }
    return;
  }

  if (cmd === 'AI_NEXT' && deviceState.songList.length > 0) {
    const nextIdx = (Math.max(0, deviceState.currentSongIndex) + 1) % deviceState.songList.length;
    deviceState.currentSongIndex = nextIdx;
    deviceState.currentSong = deviceState.displayList[nextIdx] || basicCleanAscii(deviceState.songList[nextIdx]);
    deviceState.aiPlaying = true;
    io.emit('telemetry', deviceState);
    return;
  }

  if (cmd.startsWith('SET_VOL:')) {
    const v = parseInt(cmd.slice('SET_VOL:'.length), 10);
    if (!Number.isNaN(v)) {
      deviceState.vol = Math.max(0, Math.min(100, v));
      io.emit('telemetry', deviceState);
    }
  }
}

setInterval(() => {
  if (deviceState.online && Date.now() - deviceState.lastSeen > 16000) {
    deviceState.online = false;
    io.emit('telemetry', deviceState);
  }
}, 5000);

io.on('connection', (socket) => {
  socket.emit('init', { deviceState, chatHistory, sensorHistory });
});

async function callGeminiRaw(parts) {
  if (!GEMINI_KEY) {
    lastGeminiError = 'MISSING_GEMINI_API_KEY';
    console.error('[GEMINI ERR] Thieu GEMINI_API_KEY trong bien moi truong!');
    return null;
  }

  const models = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-flash-latest'
  ];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': GEMINI_KEY
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024
          }
        })
      });
      const data = await res.json();
      const respParts = data?.candidates?.[0]?.content?.parts || [];
      const text = respParts
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
        .trim();

      if (text) {
        lastGeminiError = 'OK (' + model + ')';
        return text;
      }
      const errMsg = data?.error?.message || JSON.stringify(data);
      const errCode = data?.error?.code || res.status;
      lastGeminiError = `${model} -> HTTP ${errCode}: ${errMsg}`;
      console.error(`[GEMINI ${model} ERR]`, lastGeminiError);
    } catch (err) {
      lastGeminiError = `${model} -> FETCH: ${err.message}`;
      console.error(`[GEMINI ${model} FETCH ERR]`, err.message);
    }
  }
  return null;
}

function basicCleanAscii(name) {
  let s = String(name || '')
    .replace(/\.mp3$/i, '')
    .replace(/\s*-\s*YouTube$/i, '')
    .replace(/[\(\[]?(Official\s+)?(Music\s+)?(Lyric\s+)?(Animation\s+)?(Video|MV)[\)\]]?/gi, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || 'Track';
}

function normalizeForSearch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findBestSongIndexServer(query) {
  const list = deviceState.songList || [];
  if (list.length === 0) return -1;

  const numMatch = String(query || '').match(/\b(\d{1,3})\b/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n >= 1 && n <= list.length) return n - 1;
  }

  const qNorm = normalizeForSearch(query);
  if (!qNorm) return -1;
  const qTokens = qNorm.split(' ').filter((w) => w.length >= 2);

  let bestIdx = -1;
  let bestScore = 0;

  list.forEach((raw, idx) => {
    const disp = deviceState.displayList[idx] || '';
    const target = normalizeForSearch(`${raw} ${disp}`);
    let score = 0;

    if (target.includes(qNorm)) score += 100;
    for (const tok of qTokens) {
      if (target.includes(tok)) score += 15;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });

  return bestScore >= 15 ? bestIdx : -1;
}

async function buildCleanDisplayNames(rawList) {
  const needTranslate = [];
  rawList.forEach((raw, idx) => {
    const cleanBase = raw.replace(/\.mp3$/i, '').trim();
    const hasNonLatin = /[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]/.test(cleanBase);
    if (hasNonLatin && !romajiCache.has(raw)) {
      needTranslate.push({ idx, raw: cleanBase });
    }
  });

  if (needTranslate.length > 0 && GEMINI_KEY) {
    const promptLines = needTranslate.map((item, i) => `${i}|${item.raw}`).join('\n');
    const prompt =
      `Convert these song filenames (many contain Japanese Kanji/Kana) into short, clean ASCII Romaji/English display titles for a small OLED screen (max 28 chars, remove "- YouTube", "Official Music Video", keep artist + title).\n` +
      `Return ONLY lines in exact format: INDEX|CLEAN_ASCII_TITLE (only ASCII 32-126, no markdown, no explanations).\n\n` +
      promptLines;

    const result = await callGeminiRaw([{ text: prompt }]);
    if (result) {
      result.split('\n').forEach((line) => {
        const sep = line.indexOf('|');
        if (sep > 0) {
          const i = parseInt(line.slice(0, sep).trim(), 10);
          const clean = line.slice(sep + 1).replace(/[^\x20-\x7E]/g, '').trim();
          if (!Number.isNaN(i) && needTranslate[i] && clean.length > 0) {
            romajiCache.set(needTranslate[i].raw + '.mp3', clean.slice(0, 32));
            romajiCache.set(needTranslate[i].raw, clean.slice(0, 32));
          }
        }
      });
    }
  }

  return rawList.map((raw) => {
    if (romajiCache.has(raw)) return romajiCache.get(raw);
    const stripped = raw.replace(/\.mp3$/i, '').trim();
    if (romajiCache.has(stripped)) return romajiCache.get(stripped);
    return basicCleanAscii(raw).slice(0, 32);
  });
}

// Xu ly du phong nhanh khi Gemini loi quota/mang: van mo dung bai nhac & doc cam bien/gio duoc
function tryLocalFallbackCommand(textPrompt) {
  const q = String(textPrompt || '').toLowerCase().trim();
  if (!q) return null;

  if (/(dừng nhạc|tắt nhạc|ngừng nhạc|stop music|pause)/i.test(q)) {
    pendingCommand = 'AI_STOP';
    applyOptimisticCommandState(pendingCommand);
    return { text: 'Ok bồ, mình đã dừng nhạc rồi nhé!', lang: 'vi' };
  }
  if (/(phát tiếp|nghe tiếp|resume)/i.test(q)) {
    pendingCommand = 'AI_RESUME';
    applyOptimisticCommandState(pendingCommand);
    return { text: 'Tiếp tục phát bài nhạc đang dang dở ngay đây!', lang: 'vi' };
  }
  if (/(đổi bài|bài tiếp|next song|qua bài|bài khác)/i.test(q)) {
    pendingCommand = 'AI_NEXT';
    applyOptimisticCommandState(pendingCommand);
    return { text: 'Chuyển sang bài tiếp theo ngay đây!', lang: 'vi' };
  }
  if (/(mấy giờ|thời gian|giờ hiện tại|đồng hồ)/i.test(q)) {
    const nowTime = deviceState.timeStr && deviceState.timeStr !== '--:--:--'
      ? deviceState.timeStr
      : new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    return {
      text: `Bây giờ là ${nowTime}. Nhiệt độ phòng đang là ${deviceState.temp} độ C, độ ẩm ${deviceState.hum}% và ánh sáng ${deviceState.light}%.`,
      lang: 'vi'
    };
  }
  if (/(nhiệt độ|độ ẩm|ánh sáng|âm thanh|độ ồn|tiếng ồn|cảm biến|pin bao nhiêu|còn bao nhiêu pin)/i.test(q)) {
    const batStr = deviceState.usbPower || deviceState.bat < 0
      ? 'đang cắm nguồn USB'
      : `${deviceState.bat}% (${Number(deviceState.batV || 0).toFixed(2)}V)`;
    return {
      text: `Thông số hiện tại: nhiệt độ ${deviceState.temp} độ C, độ ẩm ${deviceState.hum}%, ánh sáng ${deviceState.light}%, âm thanh Mic ${deviceState.soundDb} dB, pin ${batStr}.`,
      lang: 'vi'
    };
  }
  if (/(mở bài|mở một bài|mở nhạc|bật bài|bật nhạc|phát bài|phát nhạc|nghe bài|nghe nhạc|chơi bài|tìm bài|play )/i.test(q)) {
    const cleaned = q
      .replace(/mở cho tôi bài|mở giúp tôi bài|mở giùm bài|mở bài|bật bài|phát bài|nghe bài|chơi bài|tìm bài|mở nhạc|bật nhạc|phát nhạc|nghe nhạc|play/gi, '')
      .trim();
    if (cleaned && deviceState.songList.length > 0) {
      const idx = findBestSongIndexServer(cleaned);
      if (idx >= 0) {
        pendingCommand = `AI_PLAY:${idx + 1}`;
        applyOptimisticCommandState(pendingCommand);
        const title = deviceState.displayList[idx] || basicCleanAscii(deviceState.songList[idx]);
        return { text: `Mở ngay bài số ${idx + 1}: ${title} cho bồ thưởng thức đây!`, lang: 'vi' };
      }
    }
    pendingCommand = 'AI_PLAY';
    applyOptimisticCommandState(pendingCommand);
    return { text: 'Mình bật nhạc từ thẻ nhớ SD cho bồ nghe ngay nhé!', lang: 'vi' };
  }
  return null;
}

async function askGemini({ textPrompt = null, audioBuffer = null }) {
  const numberedSongs = deviceState.songList.length > 0
    ? deviceState.songList.map((raw, idx) => {
        const disp = deviceState.displayList[idx] || '';
        const cleanRaw = raw.replace(/\.mp3$/i, '');
        return disp && disp.toLowerCase() !== cleanRaw.toLowerCase()
          ? `${idx + 1}. ${cleanRaw} [${disp}]`
          : `${idx + 1}. ${cleanRaw}`;
      }).join(' | ')
    : '(Chưa nhận được danh sách từ ESP32)';

  const nowVn = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const validHistory = chatHistory
    .filter((m) => m.text && !m.text.includes('Lỗi Gemini') && !m.text.includes('chập chờn'))
    .slice(-8)
    .map((m) => `${m.sender}: ${m.text}`)
    .join('\n');

  const systemContext =
    `Bạn là Trợ lý Âm nhạc & IoT thông minh, thân thiện trong Hộp Nhạc ESP32.\n` +
    `Thời gian hệ thống: ${nowVn}.\n` +
    `Trạng thái phần cứng thời gian thực:\n` +
    `- Đồng hồ DS1307: ${deviceState.timeStr} | Báo thức: ${deviceState.alarmStr} (${deviceState.alarmOn ? 'Đang bật' : 'Tắt'}) | Nhạc chuông: ${deviceState.ringtone}\n` +
    `- Cảm biến môi trường: Nhiệt độ ${deviceState.temp}°C | Độ ẩm ${deviceState.hum}% | Ánh sáng ${deviceState.light}% | Âm thanh Mic: ${deviceState.soundDb} dB\n` +
    `- Nguồn điện & Loa: ${deviceState.usbPower ? 'Đang cắm USB' : deviceState.bat + '% (' + Number(deviceState.batV || 0).toFixed(2) + 'V)'} | Âm lượng: ${deviceState.vol}%\n` +
    `- Bài đang phát: ${deviceState.aiPlaying ? (deviceState.currentSong || 'Đang phát') : 'Đang dừng'}\n` +
    `- Kho nhạc thẻ SD (${deviceState.songList.length} bài): ${numberedSongs}\n` +
    (validHistory ? `\nLịch sử hội thoại gần đây:\n${validHistory}\n` : '') +
    `\nNHIỆM VỤ ƯU TIÊN:\n` +
    `1. ƯU TIÊN HÀNG ĐẦU — MỞ NHẠC QUA MICRO & TÌM BÀI: Khi người dùng yêu cầu mở/phát/tìm bài hát (bằng tên bài, tên ca sĩ, số thứ tự, một đoạn tên gần đúng hoặc thể loại), hãy đối chiếu thật kỹ với Kho nhạc thẻ SD ở trên, chọn ra bài khớp nhất và LUÔN gắn đúng thẻ [CMD:AI_PLAY:so_thu_tu] ở cuối câu trả lời. Nếu người dùng chỉ nói "mở nhạc" chung chung, chọn 1 bài hay hoặc gắn [CMD:AI_PLAY]. Nếu không có bài nào khớp, thông báo nhẹ nhàng và gợi ý 2–3 bài có sẵn trong thẻ SD.\n` +
    `2. ĐỌC THỜI GIAN & CẢM BIẾN: Khi người dùng hỏi giờ, báo thức, nhiệt độ, độ ẩm, ánh sáng hoặc pin, hãy đọc chính xác số liệu thực tế ở trên một cách tự nhiên.\n` +
    `3. TRÒ CHUYỆN CƠ BẢN: Trả lời ngắn gọn, thân thiện (1–3 câu, tối đa ~260 ký tự), KHÔNG dùng ký tự markdown (*, #, _, \`) để đọc mượt ra loa.\n` +
    `4. KHÔNG tự ý gắn thẻ [CMD:...] nếu người dùng chỉ hỏi thăm, trò chuyện hoặc hỏi thông số cảm biến/giờ.\n` +
    `5. SONG NGỮ: Nếu người dùng nói/nhắn tiếng Anh, trả lời tiếng Anh tự nhiên và thêm [LANG:en] ở đầu.\n\n` +
    `BẢNG THẺ LỆNH (chỉ gắn ĐÚNG 1 thẻ ở cuối câu KHI người dùng yêu cầu):\n` +
    `- Phát đúng bài (1..${deviceState.songList.length}): [CMD:AI_PLAY:so_thu_tu]\n` +
    `- Phát nhạc ngẫu nhiên: [CMD:AI_PLAY] | Đổi bài kế: [CMD:AI_NEXT] | Dừng nhạc: [CMD:AI_STOP] | Phát tiếp: [CMD:AI_RESUME]\n` +
    `- Chỉnh âm lượng (0..100): [CMD:SET_VOL:muc_phan_tram]\n` +
    `- Đặt báo thức (HH:MM, 1=bật/0=tắt): [CMD:SET_ALARM:HH:MM:1] hoặc [CMD:SET_ALARM:00:00:0]\n` +
    `- Chỉnh giờ đồng hồ: [CMD:SET_TIME:HH:MM]\n` +
    `- Đổi nhạc chuông: [CMD:SET_RING:so_thu_tu] | Thử chuông: [CMD:TEST_RING] | Tắt chuông: [CMD:STOP_ALARM]\n` +
    `- Chuyển chế độ phần cứng: [CMD:MENU], [CMD:MODE_1], [CMD:MODE_2], [CMD:MODE_3_PLAY], [CMD:MODE_4]`;

  const parts = [{ text: systemContext }];
  if (audioBuffer) {
    parts.push({
      inline_data: { mime_type: 'audio/wav', data: audioBuffer.toString('base64') }
    });
    parts.push({ text: 'Nghe kỹ đoạn ghi âm trên (đặc biệt tên bài hát, yêu cầu mở nhạc hoặc hỏi cảm biến/giờ) và trả lời tự nhiên.' });
  } else if (textPrompt) {
    parts.push({ text: `Người dùng nói: ${textPrompt}` });
  }

  const rawText = await callGeminiRaw(parts);
  if (!rawText) {
    if (textPrompt) {
      const localRes = tryLocalFallbackCommand(textPrompt);
      if (localRes) return localRes;
    }
    return {
      text: `Lỗi Gemini (${lastGeminiError.slice(0, 95)}). Kiểm tra lại GEMINI_API_KEY trên Render nha!`,
      lang: 'vi'
    };
  }

  let cleanReply = rawText;
  let lang = 'vi';

  if (/\[LANG:en\]/i.test(cleanReply)) {
    lang = 'en';
    cleanReply = cleanReply.replace(/\[LANG:en\]/gi, '');
  }

  const cmdMatch = cleanReply.match(/\[CMD:([A-Z0-9_]+(?::[^\]]+)?)\]/);
  if (cmdMatch) {
    pendingCommand = cmdMatch[1].trim();
    logControlToDb('AI_Gemini', pendingCommand, textPrompt || 'Voice');
    applyOptimisticCommandState(pendingCommand);
    cleanReply = cleanReply.replace(cmdMatch[0], '');
  }

  cleanReply = cleanReply.replace(/[*#_`]/g, '').trim();

  const hasViDiacritics = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(cleanReply);
  if (!hasViDiacritics && /[a-zA-Z]{3,}/.test(cleanReply)) {
    lang = 'en';
  }

  return { text: cleanReply, lang };
}

function splitTtsChunks(text, maxLen = 180) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';

  for (const s of sentences) {
    if ((current + ' ' + s).trim().length <= maxLen) {
      current = (current + ' ' + s).trim();
    } else {
      if (current) chunks.push(current);
      if (s.length <= maxLen) {
        current = s;
      } else {
        const words = s.split(' ');
        current = '';
        for (const w of words) {
          if ((current + ' ' + w).trim().length <= maxLen) {
            current = (current + ' ' + w).trim();
          } else {
            if (current) chunks.push(current);
            current = w;
          }
        }
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 3);
}

async function textToMp3File(text, lang = 'vi') {
  const tl = lang === 'en' ? 'en' : 'vi';
  const chunks = splitTtsChunks(text, 180);
  if (chunks.length === 0) return;

  const buffers = [];
  for (const chunk of chunks) {
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${tl}&client=tw-ob`;
    const res = await fetch(ttsUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      buffers.push(Buffer.from(await res.arrayBuffer()));
    }
  }
  if (buffers.length > 0) {
    fs.writeFileSync(REPLY_MP3_PATH, Buffer.concat(buffers));
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'MusicBox_AI_Cloud', ts: Date.now() });
});

app.get('/api/debug', (req, res) => {
  res.json({
    hasKey: Boolean(GEMINI_KEY),
    keyPrefix: GEMINI_KEY ? GEMINI_KEY.slice(0, 8) + '...' : null,
    lastGeminiError,
    songCount: deviceState.songList.length,
    historyCount: sensorHistory.length,
    online: deviceState.online
  });
});

app.get('/api/songs', (req, res) => {
  const q = normalizeForSearch(req.query.q || '');
  const items = deviceState.songList.map((raw, idx) => ({
    index: idx + 1,
    raw,
    display: deviceState.displayList[idx] || basicCleanAscii(raw)
  }));
  const filtered = q
    ? items.filter((item) => normalizeForSearch(`${item.raw} ${item.display}`).includes(q))
    : items;
  res.json({
    ok: true,
    total: items.length,
    aiPlaying: deviceState.aiPlaying,
    currentSong: deviceState.currentSong,
    currentSongIndex: deviceState.currentSongIndex,
    songs: filtered
  });
});

app.post('/api/songs', async (req, res) => {
  try {
    let rawList = [];
    if (typeof req.body === 'string') {
      rawList = req.body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(req.body?.songs)) {
      rawList = req.body.songs.map((s) => String(s).trim()).filter(Boolean);
    }

    deviceState.songList = rawList;
    deviceState.displayList = await buildCleanDisplayNames(rawList);
    io.emit('telemetry', deviceState);
    console.log(`[SONGS] Da dong bo ${rawList.length} bai & tao ten OLED sach`);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(deviceState.displayList.join('\n'));
  } catch (err) {
    console.error('[SONGS ERR]', err);
    res.status(500).send('');
  }
});

app.post('/api/play-song', (req, res) => {
  const index = parseInt(req.body?.index, 10);
  if (Number.isNaN(index) || index < 1 || index > deviceState.songList.length) {
    return res.status(400).json({ ok: false, error: 'Chi so bai hat khong hop le' });
  }
  const cmd = `AI_PLAY:${index}`;
  pendingCommand = cmd;
  const title = deviceState.displayList[index - 1] || basicCleanAscii(deviceState.songList[index - 1]);
  logControlToDb('Web_Player', cmd, title);
  applyOptimisticCommandState(cmd);
  res.json({ ok: true, cmd, index, title });
});

app.post('/api/telemetry', (req, res) => {
  const { songs, ...rest } = req.body || {};
  deviceState = {
    ...deviceState,
    ...rest,
    online: true,
    lastSeen: Date.now()
  };

  if (deviceState.currentSong && deviceState.songList.length > 0) {
    const matchedIdx = findBestSongIndexServer(deviceState.currentSong);
    if (matchedIdx >= 0) deviceState.currentSongIndex = matchedIdx;
  }

  io.emit('telemetry', deviceState);
  recordSensorHistory(deviceState);
  logSensorToDb(deviceState);

  const response = {
    cmd: pendingCommand,
    playAudio: hasNewAudioForEsp,
    needSongs: deviceState.songList.length === 0
  };
  pendingCommand = 'NONE';
  hasNewAudioForEsp = false;
  res.json(response);
});

function analyzeWavSoundLevel(buf) {
  if (!buf || buf.length <= 46) return { soundDb: 35, soundPct: 0 };
  const start = 44; // Standard 44-byte RIFF/WAVE header (16-bit PCM LE)
  let sumSq = 0;
  let count = 0;
  for (let i = start; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i) / 32768.0;
    sumSq += sample * sample;
    count++;
  }
  if (count === 0) return { soundDb: 35, soundPct: 0 };
  const rms = Math.sqrt(sumSq / count);
  const dbfs = 20 * Math.log10(Math.max(rms, 1e-5)); // -100 .. 0 dBFS
  // Quy doi tuong duong muc ap suat am thanh (30 .. 100 dB)
  const soundDb = Math.round(Math.max(30, Math.min(100, dbfs + 95)));
  const soundPct = Math.round(Math.max(0, Math.min(100, ((soundDb - 30) / 70) * 100)));
  return { soundDb, soundPct };
}

app.post('/api/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file audio' });
    const { soundDb, soundPct } = analyzeWavSoundLevel(req.file.buffer);
    deviceState.soundDb = soundDb;
    deviceState.soundPct = soundPct;
    deviceState.soundSource = 'ESP32 INMP441';
    io.emit('telemetry', deviceState);
    const { text: replyText, lang } = await askGemini({ audioBuffer: req.file.buffer });
    await textToMp3File(replyText, lang);

    pushChat('ESP32 Mic', '(Đã nói qua micro hộp nhạc)');
    pushChat('AI', replyText);

    const cmdToSend = pendingCommand;
    pendingCommand = 'NONE';
    res.json({ ok: true, reply: replyText, cmd: cmdToSend });
  } catch (err) {
    console.error('[VOICE ERR]', err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const userText = (req.body.text || '').trim();
    if (!userText) return res.status(400).json({ ok: false });

    const viaMic = Boolean(req.body.viaMic);
    pushChat(viaMic ? 'Bạn (Mic)' : 'Bạn', userText);
    const { text: replyText, lang } = await askGemini({ textPrompt: userText });
    await textToMp3File(replyText, lang);
    hasNewAudioForEsp = true;

    pushChat('AI', replyText);
    res.json({ ok: true, reply: replyText, cmd: pendingCommand });
  } catch (err) {
    console.error('[CHAT ERR]', err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/sound', (req, res) => {
  const db = Math.round(Math.max(30, Math.min(100, Number(req.body?.soundDb || 35))));
  const pct = Math.round(Math.max(0, Math.min(100, ((db - 30) / 70) * 100)));
  deviceState.soundDb = db;
  deviceState.soundPct = pct;
  deviceState.soundSource = String(req.body?.source || 'Web Mic');
  io.emit('telemetry', deviceState);
  res.json({ ok: true, soundDb: db, soundPct: pct });
});

app.post('/api/command', (req, res) => {
  pendingCommand = (req.body.cmd || 'NONE').trim();
  logControlToDb('Web_Dashboard', pendingCommand, 'Dieu khien thu cong');
  applyOptimisticCommandState(pendingCommand);
  res.json({ ok: true, cmd: pendingCommand });
});

app.get('/api/history/sensors', async (req, res) => {
  if (dbPool) {
    try {
      const [rows] = await dbPool.query('SELECT * FROM sensor_logs ORDER BY id DESC LIMIT 100');
      return res.json({ ok: true, source: 'mysql', rows });
    } catch (err) {
      console.error('[DB SELECT sensor_logs ERR]', err.message);
    }
  }
  res.json({ ok: true, source: 'ram', rows: sensorHistory });
});

app.get('/api/history/controls', async (req, res) => {
  if (!dbPool) return res.json({ ok: false, rows: [] });
  try {
    const [rows] = await dbPool.query('SELECT * FROM control_logs ORDER BY id DESC LIMIT 50');
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/reply.mp3', (req, res) => {
  if (!fs.existsSync(REPLY_MP3_PATH)) return res.status(404).end();
  res.sendFile(REPLY_MP3_PATH);
});

server.listen(PORT, () => {
  console.log(`MusicBox AI & IoT Server running on port ${PORT}`);
});