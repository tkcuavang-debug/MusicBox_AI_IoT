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
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const REPLY_MP3_PATH = path.join(__dirname, 'latest_reply.mp3');

let deviceState = {
  temp: 0,
  hum: 0,
  light: 0,
  bat: -1,
  batV: 0,
  usbPower: true,
  charging: false,
  timeStr: '--:--:--',
  alarmStr: '--:--',
  alarmOn: false,
  ringtone: 'Chua chon',
  mode: 5,
  aiPlaying: false,
  currentSong: '',
  songList: [],
  online: false,
  lastSeen: 0
};

let chatHistory = [];
let pendingCommand = 'NONE';
let hasNewAudioForEsp = false;

function pushChat(sender, text) {
  const msg = {
    sender,
    text,
    time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
  };
  chatHistory.push(msg);
  if (chatHistory.length > 40) chatHistory.shift();
  io.emit('chat', msg);
}

setInterval(() => {
  if (deviceState.online && Date.now() - deviceState.lastSeen > 16000) {
    deviceState.online = false;
    io.emit('telemetry', deviceState);
  }
}, 5000);

io.on('connection', (socket) => {
  socket.emit('init', { deviceState, chatHistory });
});

async function askGemini({ textPrompt = null, audioBuffer = null }) {
  const numberedSongs = deviceState.songList.length > 0
    ? deviceState.songList.map((name, idx) => `${idx + 1}. ${name}`).join(' | ')
    : '(Chưa đồng bộ được danh sách thẻ SD)';

  const systemContext =
    `Bạn là trợ lý ảo thân thiện, thông minh trong Hộp Nhạc IoT. ` +
    `Trạng thái hiện tại: Nhiệt độ ${deviceState.temp}°C, Độ ẩm ${deviceState.hum}%, ` +
    `Ánh sáng ${deviceState.light}%, Pin ${deviceState.usbPower ? 'nguồn USB' : deviceState.bat + '%'}, ` +
    `Giờ DS1307 ${deviceState.timeStr}, Nhạc chuông ${deviceState.ringtone}, ` +
    `Nhạc AI đang phát: ${deviceState.aiPlaying ? (deviceState.currentSong || 'Có') : 'Không'}. ` +
    `TOÀN BỘ ${deviceState.songList.length} bài nhạc có trong thẻ SD: ${numberedSongs}. ` +
    `QUY TẮC TRẢ LỜI: ` +
    `- Nếu người dùng hỏi liệt kê danh sách nhạc, hãy đọc tên một số bài tiêu biểu và báo tổng số bài (${deviceState.songList.length} bài), còn các câu khác trả lời ngắn gọn tối đa 2 câu bằng tiếng Việt tự nhiên (không dùng markdown * # _ \`). ` +
    `- Khi người dùng yêu cầu phát nhạc / đổi bài / tắt nhạc, MẶC ĐỊNH phát ngay trong chế độ AI (KHÔNG chuyển sang MODE_1 trừ khi người dùng nói rõ "chuyển sang chế độ 1"). ` +
    `- Gắn ĐÚNG 1 thẻ lệnh ở cuối câu trả lời (không giải thích thẻ): ` +
    `  * Mở 1 bài cụ thể trong thẻ SD (dùng ĐÚNG số thứ tự từ danh sách trên nếu tìm thấy, VD bài số 5 -> [CMD:AI_PLAY:5], hoặc tên từ khóa -> [CMD:AI_PLAY:habits]): [CMD:AI_PLAY:...] ` +
    `  * Mở nhạc chung chung / ngẫu nhiên: [CMD:AI_PLAY] ` +
    `  * Đổi bài khác / bài tiếp theo: [CMD:AI_NEXT] ` +
    `  * Dừng / tắt nhạc đang phát trong AI: [CMD:AI_STOP] ` +
    `  * Tiếp tục phát nhạc trong AI: [CMD:AI_RESUME] ` +
    `  * Về menu chính / thoát chế độ AI: [CMD:MENU] ` +
    `  * Chuyển hẳn sang chế độ 1 (SD thủ công): [CMD:MODE_1] ` +
    `  * Bật chế độ 2 Loa Bluetooth (nhắc người dùng kết nối ESP32_AI_Speaker): [CMD:MODE_2] ` +
    `  * Bật chế độ 3 tìm & tự kết nối loa/tai nghe Bluetooth ngoài rồi phát nhạc: [CMD:MODE_3_PLAY] (hoặc [CMD:MODE_3_PLAY:so_thu_tu_hoac_ten]) ` +
    `  * Bật chế độ 4 đồng hồ/báo thức & chọn chuông: [CMD:MODE_4:so_thu_tu_hoac_ten] (hoặc [CMD:MODE_4]) ` +
    `  * Thử chuông báo thức ngay: [CMD:TEST_RING]`;

  const parts = [{ text: systemContext }];
  if (audioBuffer) {
    parts.push({
      inline_data: { mime_type: 'audio/wav', data: audioBuffer.toString('base64') }
    });
    parts.push({ text: 'Hãy nghe đoạn ghi âm trên và trả lời người dùng.' });
  } else if (textPrompt) {
    parts.push({ text: `Người dùng nói: ${textPrompt}` }); }  const models = [ 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest' ];  for (const model of models) { try { const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': GEMINI_KEY
        },
        body: JSON.stringify({ contents: [{ parts }] })
      });
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        let cleanReply = text;
        const cmdMatch = cleanReply.match(/\[CMD:([A-Z0-9_]+(?::[^\]]+)?)\]/);
        if (cmdMatch) {
          pendingCommand = cmdMatch[1].trim();
          cleanReply = cleanReply.replace(cmdMatch[0], '');
        }
        return cleanReply.replace(/[*#_`]/g, '').trim();
      }
      console.error(`[GEMINI ${model} ERR]`, JSON.stringify(data));
    } catch (err) {
      console.error(`[GEMINI ${model} FETCH ERR]`, err.message);
    }
  }

  return 'Xin lỗi, hệ thống AI đang bận, bạn thử lại sau vài giây nhé.';
}

async function textToMp3File(text) {
  const shortText = text.slice(0, 190);
  const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(shortText)}&tl=vi&client=tw-ob`;
  const res = await fetch(ttsUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(REPLY_MP3_PATH, buf);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'MusicBox_AI_Cloud', ts: Date.now() });
});

// Nhận toàn bộ danh sách bài hát trên thẻ SD từ ESP32 (không giới hạn 260 ký tự)
app.post('/api/songs', (req, res) => {
  if (Array.isArray(req.body.songs)) {
    deviceState.songList = req.body.songs.map(s => String(s).trim()).filter(Boolean);
    io.emit('telemetry', deviceState);
    console.log(`[SONGS] Da dong bo ${deviceState.songList.length} bai tu the SD`);
  }
  res.json({ ok: true, count: deviceState.songList.length });
});

app.post('/api/telemetry', (req, res) => {
  const { songs, ...rest } = req.body || {};
  deviceState = {
    ...deviceState,
    ...rest,
    online: true,
    lastSeen: Date.now()
  };
  io.emit('telemetry', deviceState);

  const response = {
    cmd: pendingCommand,
    playAudio: hasNewAudioForEsp
  };
  pendingCommand = 'NONE';
  hasNewAudioForEsp = false;
  res.json(response);
});

app.post('/api/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file audio' });
    const replyText = await askGemini({ audioBuffer: req.file.buffer });
    await textToMp3File(replyText);

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

    pushChat('Bạn', userText);
    const replyText = await askGemini({ textPrompt: userText });
    await textToMp3File(replyText);
    hasNewAudioForEsp = true;

    pushChat('AI', replyText);
    res.json({ ok: true, reply: replyText });
  } catch (err) {
    console.error('[CHAT ERR]', err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/command', (req, res) => {
  pendingCommand = (req.body.cmd || 'NONE').trim();
  res.json({ ok: true, cmd: pendingCommand });
});

app.get('/api/reply.mp3', (req, res) => {
  if (!fs.existsSync(REPLY_MP3_PATH)) return res.status(404).end();
  res.sendFile(REPLY_MP3_PATH);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Dang chay tai http://localhost:${PORT}`);
});