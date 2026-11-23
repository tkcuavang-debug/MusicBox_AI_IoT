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
  songList: [],     // Ten goc (co ca tieng Nhat/Viet/Anh)
  displayList: [],  // Ten ASCII/Romaji sach de hien OLED
  online: false,
  lastSeen: 0
};

const romajiCache = new Map();

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

async function callGemini(contents, systemInstructionText = null, temperature = 0.85) {
  const models = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest'
  ];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const payload = {
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens: 320
        }
      };
      if (systemInstructionText) {
        payload.systemInstruction = {
          parts: [{ text: systemInstructionText }]
        };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': GEMINI_KEY
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
      console.error(`[GEMINI ${model} ERR]`, JSON.stringify(data));
    } catch (err) {
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

async function buildCleanDisplayNames(rawList) {
  const needTranslate = [];
  rawList.forEach((raw, idx) => {
    const cleanBase = raw.replace(/\.mp3$/i, '').trim();
    const hasNonLatin = /[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]/.test(cleanBase);
    if (hasNonLatin && !romajiCache.has(raw)) {
      needTranslate.push({ idx, raw: cleanBase });
    }
  });

  if (needTranslate.length > 0) {
    const promptLines = needTranslate.map((item, i) => `${i}|${item.raw}`).join('\n');
    const prompt =
      `Convert these song filenames (many contain Japanese Kanji/Kana) into short, clean ASCII Romaji/English display titles for a small OLED screen (max 28 chars, remove "- YouTube", "Official Music Video", keep artist + title).\n` +
      `Return ONLY lines in exact format: INDEX|CLEAN_ASCII_TITLE (only ASCII 32-126, no markdown, no explanations).\n\n` +
      promptLines;

    const result = await callGemini([{ role: 'user', parts: [{ text: prompt }] }], null, 0.2);
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

  const systemContext =
    `Bạn là trợ lý AI thông minh, nhạy bén, giàu kiến thức và có cá tính dí dỏm thân thiện trong chiếc Hộp Nhạc IoT.\n` +
    `Thời gian thực hệ thống: ${nowVn}.\n` +
    `Trạng thái phần cứng hiện tại:\n` +
    `- Nhiệt độ: ${deviceState.temp}°C | Độ ẩm: ${deviceState.hum}% | Ánh sáng: ${deviceState.light}%\n` +
    `- Nguồn: ${deviceState.usbPower ? 'Đang cắm USB' : deviceState.bat + '% (' + deviceState.batV + 'V)'}\n` +
    `- Đồng hồ: ${deviceState.timeStr} | Báo thức: ${deviceState.alarmStr} (${deviceState.alarmOn ? 'Đang bật' : 'Tắt'}) | Nhạc chuông: ${deviceState.ringtone}\n` +
    `- Nhạc AI đang phát: ${deviceState.aiPlaying ? (deviceState.currentSong || 'Đang phát') : 'Không'}\n` +
    `- Kho nhạc SD (${deviceState.songList.length} bài): ${numberedSongs}\n\n` +
    `CÁCH TRÒ CHUYỆN & TRẢ LỜI:\n` +
    `1. Bạn là một người bạn thông minh thực thụ: có thể trò chuyện tự nhiên, tâm sự, giải thích kiến thức khoa học/đời sống, gợi ý nhạc theo tâm trạng, nhận xét thời tiết trong phòng từ cảm biến, kể chuyện vui hoặc tranh luận nhẹ nhàng.\n` +
    `2. KHÔNG tự ý mở nhạc hay gắn thẻ [CMD:...] nếu người dùng chỉ đang hỏi thăm, trò chuyện, hỏi kiến thức, hoặc hỏi thông tin cảm biến/giờ giấc!\n` +
    `3. Trả lời tự nhiên, súc tích, có hồn (2–4 câu, tối đa ~320 ký tự), KHÔNG dùng ký tự markdown (*, #, _, \`) để hệ thống đọc mượt ra loa.\n` +
    `4. SONG NGỮ: Nếu người dùng nói/nhắn bằng tiếng Anh, trả lời hoàn toàn bằng tiếng Anh tự nhiên và thêm [LANG:en] ở đầu. Nếu tiếng Việt, trả lời tiếng Việt.\n\n` +
    `QUY TẮC LỆNH ĐIỀU KHIỂN (chỉ gắn ĐÚNG 1 thẻ ở cuối câu KHI người dùng thật sự yêu cầu hành động):\n` +
    `- Mở 1 bài cụ thể trong AI (dùng đúng số thứ tự 1..${deviceState.songList.length}): [CMD:AI_PLAY:so_thu_tu]\n` +
    `- Mở nhạc ngẫu nhiên trong AI: [CMD:AI_PLAY]\n` +
    `- Đổi bài tiếp theo trong AI: [CMD:AI_NEXT]\n` +
    `- Dừng / tắt nhạc đang phát trong AI: [CMD:AI_STOP]\n` +
    `- Phát tiếp nhạc đang tạm dừng: [CMD:AI_RESUME]\n` +
    `- Đặt báo thức trên hộp nhạc (HH:MM dạng 24h, trạng thái 1=bật, 0=tắt): [CMD:SET_ALARM:HH:MM:1] hoặc [CMD:SET_ALARM:00:00:0]\n` +
    `- Chỉnh giờ đồng hồ trên web/hộp nhạc (HH:MM dạng 24h): [CMD:SET_TIME:HH:MM]\n` +
    `- Đổi nhạc chuông báo thức (không thoát AI): [CMD:SET_RING:so_thu_tu]\n` +
    `- Nghe thử chuông báo thức ngay: [CMD:TEST_RING]\n` +
    `- Tắt chuông báo thức đang kêu: [CMD:STOP_ALARM]\n` +
    `- Chuyển chế độ phần cứng (CHỈ dùng khi người dùng nói rõ muốn chuyển chế độ): [CMD:MENU], [CMD:MODE_1], [CMD:MODE_2], [CMD:MODE_3_PLAY], [CMD:MODE_4]`;

  // Dua toi da 10 luot hoi thoai gan nhat vao lich su de AI nho ngu canh
  const recentHistory = chatHistory.slice(-10).map((m) => ({
    role: m.sender === 'AI' ? 'model' : 'user',
    parts: [{ text: m.text }]
  }));

  const currentParts = [];
  if (audioBuffer) {
    currentParts.push({
      inline_data: { mime_type: 'audio/wav', data: audioBuffer.toString('base64') }
    });
    currentParts.push({ text: 'Hãy nghe kỹ đoạn âm thanh trên (tiếng Việt hoặc tiếng Anh) và phản hồi thật tự nhiên, thông minh theo mạch hội thoại.' });
  } else if (textPrompt) {
    currentParts.push({ text: textPrompt });
  }

  const contents = [...recentHistory, { role: 'user', parts: currentParts }];
  const rawText = await callGemini(contents, systemContext, 0.85);

  if (!rawText) {
    return { text: 'Mạng tới Gemini hơi chập chờn xíu, bồ nói lại giúp mình nha!', lang: 'vi' };
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
    cleanReply = cleanReply.replace(cmdMatch[0], '');
  }

  cleanReply = cleanReply.replace(/[*#_`]/g, '').trim();

  const hasViDiacritics = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(cleanReply);
  if (!hasViDiacritics && /[a-zA-Z]{3,}/.test(cleanReply)) {
    lang = 'en';
  }

  return { text: cleanReply, lang };
}

// Chia van ban thanh tung doan <= 180 ky tu de Google TTS doc tron ven khong bi cat giua cau
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

app.post('/api/songs', async (req, res) => {
  try {
    let rawList = [];
    if (typeof req.body === 'string') {
      rawList = req.body.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(req.body?.songs)) {
      rawList = req.body.songs.map(s => String(s).trim()).filter(Boolean);
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
    playAudio: hasNewAudioForEsp,
    needSongs: deviceState.songList.length === 0
  };
  pendingCommand = 'NONE';
  hasNewAudioForEsp = false;
  res.json(response);
});

app.post('/api/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file audio' });
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

    const { text: replyText, lang } = await askGemini({ textPrompt: userText });
    pushChat('Bạn', userText);
    await textToMp3File(replyText, lang);
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