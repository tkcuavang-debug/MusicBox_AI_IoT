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
  bat: -1,
  batV: 0,
  usbPower: true,
  charging: false,
  timeStr: '--:--:--',
  alarmStr: '--:--',
  alarmOn: false,
  ringtone: 'Chua chon',
  mode: 5,
  songs: '',
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
  if (deviceState.online && Date.now() - deviceState.lastSeen > 15000) {
    deviceState.online = false;
    io.emit('telemetry', deviceState);
  }
}, 5000);

io.on('connection', (socket) => {
  socket.emit('init', { deviceState, chatHistory });
});

async function askGemini({ textPrompt = null, audioBuffer = null }) {
  const songInfo = deviceState.songs ? `Danh sách bài nhạc trong thẻ SD: ${deviceState.songs}. ` : '';
  const systemContext =
    `Bạn là trợ lý ảo thông minh của Vang tên của bạn sẽ là Rae. ` +
    `Trạng thái hiện tại: Nhiệt độ ${deviceState.temp}°C, Độ ẩm ${deviceState.hum}%, ` +
    `Ánh sáng ${deviceState.light}%, Pin ${deviceState.usbPower ? 'nguồn USB' : deviceState.bat + '%'}, ` +
    `Giờ DS1307 ${deviceState.timeStr}, Nhạc chuông hiện tại ${deviceState.ringtone}. ` +
    songInfo +
    `Trả lời dí dỏm, tinh nghịch, tự nhiên bằng tiếng Việt và cả tiếng anh nếu câu hỏi bằng tiếng anh, nếu người dùng đọc tiếng anh phát âm sai thì chủ động nhắc nhở kèm giải thích trước khi trả lời, tựa như một người bạn thay vì chủ tớ ( không markdown/ký tự đặc biệt) để đọc ra loa. ` +
    `Nếu người dùng ra lệnh điều khiển hộp nhạc, LUÔN gắn ĐÚNG 1 thẻ lệnh ở cuối câu trả lời (không giải thích thẻ): ` +
    `- Về menu chính / thoát AI: [CMD:MENU] ` +
    `- Bật nhạc từ thẻ SD chung chung: [CMD:MODE_1] ` +
    `- Mở đúng tên bài nhạc cụ thể trong thẻ SD (ưu tiên chọn khớp danh sách thẻ SD ở trên, VD "mở bài mùa xuân"): [CMD:PLAY_SONG:mua xuan] ` +
    `- Bật chế độ 2 Loa Bluetooth (và nhắc người dùng mở Bluetooth kết nối ESP32_AI_Speaker): [CMD:MODE_2] ` +
    `- Tìm & tự kết nối loa/tai nghe Bluetooth lân cận rồi phát nhạc (chế độ 3): [CMD:MODE_3_PLAY] (hoặc [CMD:MODE_3_PLAY:ten bai] nếu có yêu cầu bài) ` +
    `- Bật chế độ 4 đồng hồ/báo thức và chọn nhạc chuông theo yêu cầu: [CMD:MODE_4:ten chuong] (hoặc [CMD:MODE_4]) ` +
    `- Thử chuông báo thức ngay: [CMD:TEST_RING]`;

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

app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'MusicBox_AI_Cloud', ts: Date.now() });
});

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