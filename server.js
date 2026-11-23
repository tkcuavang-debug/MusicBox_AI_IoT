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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const REPLY_MP3_PATH = path.join(__dirname, 'latest_reply.mp3');

let deviceState = {
  temp: 0,
  hum: 0,
  light: 0,
  bat: 0,
  batV: 0,
  charging: false,
  usbPower: true,
  timeStr: '--:--:--',
  ringtone: 'Mac dinh',
  mode: 4,
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

// Kiểm tra kết nối thiết bị mỗi 10 giây
setInterval(() => {
  if (deviceState.online && Date.now() - deviceState.lastSeen > 15000) {
    deviceState.online = false;
    io.emit('telemetry', deviceState);
  }
}, 5000);

io.on('connection', (socket) => {
  socket.emit('init', { deviceState, chatHistory });
});

async function askGemini({ textPrompt = null, audioBuffer = null }) {
  const systemContext =
    `Bạn là trợ lý ảo thông minh trong Hộp Nhạc IoT. ` +
    `Dữ liệu hiện tại: Nhiệt độ ${deviceState.temp}°C, Độ ẩm ${deviceState.hum}%, ` +
    `Ánh sáng ${deviceState.light}%, Pin ${deviceState.usbPower ? 'đang cắm USB' : deviceState.bat + '%'}, ` +
    `Giờ DS1307 ${deviceState.timeStr}, Nhạc chuông ${deviceState.ringtone}. ` +
    `Trả lời ngắn gọn, tự nhiên bằng tiếng Việt (tối đa 2 câu, không markdown/ký tự đặc biệt) để đọc ra loa. ` +
    `Nếu người dùng ra lệnh điều khiển hộp nhạc, LUÔN gắn ĐÚNG 1 thẻ lệnh ở cuối câu (không giải thích thẻ): ` +
    `- Về menu chính / thoát chế độ AI: [CMD:MENU] ` +
    `- Mở nhạc thẻ SD ngẫu nhiên/chung chung: [CMD:MODE_1] ` +
    `- Mở đúng tên bài nhạc cụ thể trong thẻ SD (VD: "mở bài mùa xuân"): [CMD:PLAY_SONG:mua xuan] ` +
    `- Bật chế độ 2 loa Bluetooth (nhắc người dùng bật Bluetooth kết nối vào hộp nhạc): [CMD:MODE_2] ` +
    `- Kết nối loa Bluetooth ngoài (chế độ 3), tìm thiết bị lân cận và phát nhạc: [CMD:MODE_3_PLAY] ` +
    `- Bật chế độ 5 đồng hồ/ATmega và chọn nhạc chuông theo yêu cầu (VD: "chọn chuông 2"): [CMD:MODE_5:chuong 2] ` +
    `- Thử chuông báo thức: [CMD:TEST_RING]`;

  const parts = [{ text: systemContext }];
  if (audioBuffer) {
    parts.push({
      inline_data: { mime_type: 'audio/wav', data: audioBuffer.toString('base64') }
    });
    parts.push({ text: 'Hãy nghe đoạn ghi âm trên và trả lời người dùng.' });
  } else if (textPrompt) {
    parts.push({ text: `Người dùng nói: ${textPrompt}` });
  }

  const models = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
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

// Endpoint kiểm tra Render đã thức & sẵn sàng cho ESP32
app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'MusicBox_AI_Cloud', ts: Date.now() });
});

// 1. ESP32 gửi trạng thái định kỳ & nhận lệnh/audio mới
app.post('/api/telemetry', (req, res) => {
  deviceState = {
    ...deviceState,
    ...req.body,
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

// 2. ESP32 gửi file ghi âm WAV từ INMP441
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

// 3. Web gửi tin nhắn -> AI trả lời & ESP32 tự phát giọng nói
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

// 4. Web gửi lệnh điều khiển trực tiếp
app.post('/api/command', (req, res) => {
  pendingCommand = (req.body.cmd || 'NONE').trim();
  res.json({ ok: true, cmd: pendingCommand });
});

// 5. ESP32 tải file MP3 giọng nói AI
app.get('/api/reply.mp3', (req, res) => {
  if (!fs.existsSync(REPLY_MP3_PATH)) return res.status(404).end();
  res.sendFile(REPLY_MP3_PATH);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Dang chay tai http://localhost:${PORT}`);
});