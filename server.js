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

// Trạng thái hệ thống dùng chung giữa ESP32 và Web App
let deviceState = {
  temp: 0, hum: 0, light: 0, bat: 0, batV: 0,
  timeStr: '--:--:--', online: false, lastSeen: 0
};
let pendingCommand = "NONE";
let hasNewAudioForEsp = false;

// Gọi Gemini với danh sách model dự phòng (tránh lỗi 503 quá tải)
async function askGemini({ textPrompt = null, audioBuffer = null }) {
  const systemContext =
    `Bạn là trợ lý ảo thông minh trong Hộp Nhạc IoT (giống XiaoZhi). ` +
    `Dữ liệu cảm biến hiện tại của phòng: Nhiệt độ ${deviceState.temp}°C, Độ ẩm ${deviceState.hum}%, ` +
    `Ánh sáng ${deviceState.light}%, Pin hộp nhạc ${deviceState.bat}%, Giờ ${deviceState.timeStr}. ` +
    `Trả lời ngắn gọn bằng tiếng Việt tự nhiên (tối đa 2 câu, không dùng ký tự đặc biệt/markdown) để đọc ra loa.`;

  const parts = [{ text: systemContext }];
  if (audioBuffer) {
    parts.push({
      inline_data: { mime_type: "audio/wav", data: audioBuffer.toString('base64') }
    });
    parts.push({ text: "Hãy nghe đoạn ghi âm trên và trả lời người dùng." });
  } else if (textPrompt) {
    parts.push({ text: `Người dùng hỏi: ${textPrompt}` });
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
        return text.replace(/[*#_`]/g, '').trim();
      }
      console.error(`[GEMINI ${model} ERR]`, JSON.stringify(data));
    } catch (err) {
      console.error(`[GEMINI ${model} FETCH ERR]`, err.message);
    }
  }

  return "Xin lỗi, hệ thống AI đang bận, bạn thử lại sau vài giây nhé.";
}

// Chuyển text tiếng Việt thành file MP3 nhẹ cho ESP32 tải về phát
async function textToMp3File(text) {
  const shortText = text.slice(0, 190);
  const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(shortText)}&tl=vi&client=tw-ob`;
  const res = await fetch(ttsUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(REPLY_MP3_PATH, buf);
}

// 1. ESP32 gửi cảm biến định kỳ & nhận lệnh/audio từ Web App
app.post('/api/telemetry', (req, res) => {
  deviceState = { ...deviceState, ...req.body, online: true, lastSeen: Date.now() };
  io.emit('telemetry', deviceState);

  const response = {
    cmd: pendingCommand,
    playAudio: hasNewAudioForEsp
  };
  pendingCommand = "NONE";
  hasNewAudioForEsp = false;
  res.json(response);
});

// 2. ESP32 gửi file ghi âm /voice.wav từ micro INMP441
app.post('/api/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file audio' });
    const replyText = await askGemini({ audioBuffer: req.file.buffer });
    await textToMp3File(replyText);

    io.emit('chat', { sender: 'ESP32 Mic', text: '(Đã gửi giọng nói)' });
    io.emit('chat', { sender: 'AI', text: replyText });
    res.json({ ok: true, reply: replyText });
  } catch (err) {
    console.error('[VOICE ERR]', err);
    res.status(500).json({ ok: false });
  }
});

// 3. Web App gửi text hoặc giọng nói từ Micro điện thoại -> ESP32 tự nói ra loa
app.post('/api/chat', async (req, res) => {
  try {
    const userText = req.body.text || '';
    io.emit('chat', { sender: 'Bạn', text: userText });

    const replyText = await askGemini({ textPrompt: userText });
    await textToMp3File(replyText);
    hasNewAudioForEsp = true;

    io.emit('chat', { sender: 'AI', text: replyText });
    res.json({ ok: true, reply: replyText });
  } catch (err) {
    console.error('[CHAT ERR]', err);
    res.status(500).json({ ok: false });
  }
});

// 4. Web App gửi lệnh điều khiển phần cứng (VD: TEST_RING, MODE_1, MODE_2)
app.post('/api/command', (req, res) => {
  pendingCommand = req.body.cmd || "NONE";
  res.json({ ok: true, cmd: pendingCommand });
});

// 5. ESP32 tải file MP3 câu trả lời về thẻ SD
app.get('/api/reply.mp3', (req, res) => {
  if (!fs.existsSync(REPLY_MP3_PATH)) return res.status(404).end();
  res.sendFile(REPLY_MP3_PATH);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Dang chay tai http://localhost:${PORT}`);
});