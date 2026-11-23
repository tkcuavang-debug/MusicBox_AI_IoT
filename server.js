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
  vol: 60,
  aiPlaying: false,
  currentSong: '',
  songList: [],
  displayList: [],
  online: false,
  lastSeen: 0
};

const romajiCache = new Map();

let chatHistory = [];
let pendingCommand = 'NONE';
let hasNewAudioForEsp = false;
let lastGeminiError = 'None';

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

async function callGeminiRaw(parts) {
  if (!GEMINI_KEY) {
    lastGeminiError = 'MISSING_GEMINI_API_KEY';
    console.error('[GEMINI ERR] Thieu GEMINI_API_KEY trong bien moi truong!');
    return null;
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
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.85,
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

// Xu ly du phong khi Gemini bi loi quota/key de van mo nhac duoc
function tryLocalFallbackCommand(textPrompt) {
  const q = String(textPrompt || '').toLowerCase().trim();
  if (!q) return null;

  if (/(dừng nhạc|tắt nhạc|ngừng nhạc|stop music)/i.test(q)) {
    pendingCommand = 'AI_STOP';
    return { text: 'Ok bồ, mình đã dừng nhạc rồi nhé!', lang: 'vi' };
  }
  if (/(đổi bài|bài tiếp|next song|qua bài)/i.test(q)) {
    pendingCommand = 'AI_NEXT';
    return { text: 'Chuyển sang bài tiếp theo ngay đây!', lang: 'vi' };
  }
  if (/(mở bài|mở một bài|mở nhạc|bật nhạc|phát bài|phát nhạc|nghe bài|nghe nhạc|chơi bài|play )/i.test(q)) {
    const cleaned = q
      .replace(/mở cho tôi bài|mở bài|phát bài|nghe bài|chơi bài|play/gi, '')
      .trim();
    if (cleaned && deviceState.songList.length > 0) {
      const idx = deviceState.songList.findIndex((s) =>
        s.toLowerCase().includes(cleaned) || basicCleanAscii(s).toLowerCase().includes(cleaned)
      );
      if (idx >= 0) {
        pendingCommand = `AI_PLAY:${idx + 1}`;
        return { text: `Mở ngay bài ${basicCleanAscii(deviceState.songList[idx])} cho bồ đây!`, lang: 'vi' };
      }
    }
    pendingCommand = 'AI_PLAY';
    return { text: 'Mình bật nhạc trong thẻ nhớ lên cho bồ nhé!', lang: 'vi' };
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
    `Bạn là trợ lý AI thông minh, nhạy bén, dí dỏm và thân thiện như một người bạn thân trong Hộp Nhạc IoT.\n` +
    `Thời gian thực: ${nowVn}.\n` +
    `Trạng thái phần cứng:\n` +
    `- Nhiệt độ: ${deviceState.temp}°C | Độ ẩm: ${deviceState.hum}% | Ánh sáng: ${deviceState.light}% | Âm lượng loa: ${deviceState.vol}%\n` +
    `- Nguồn: ${deviceState.usbPower ? 'Đang cắm USB' : deviceState.bat + '% (' + deviceState.batV + 'V)'}\n` +
    `- Đồng hồ: ${deviceState.timeStr} | Báo thức: ${deviceState.alarmStr} (${deviceState.alarmOn ? 'Đang bật' : 'Tắt'}) | Nhạc chuông: ${deviceState.ringtone}\n` +
    `- Nhạc AI đang phát: ${deviceState.aiPlaying ? (deviceState.currentSong || 'Đang phát') : 'Không'}\n` +
    `- Kho nhạc SD (${deviceState.songList.length} bài): ${numberedSongs}\n` +
    (validHistory ? `\nLịch sử trò chuyện gần đây:\n${validHistory}\n` : '') +
    `\nCÁCH TRÒ CHUYỆN:\n` +
    `- Bạn là người bạn thông minh thực thụ: có thể trò chuyện tự nhiên, tâm sự, giải thích kiến thức, gợi ý nhạc theo tâm trạng, nhận xét thời tiết từ cảm biến, kể chuyện vui.\n` +
    `- KHÔNG gắn thẻ [CMD:...] nếu người dùng chỉ đang hỏi thăm, trò chuyện, hỏi kiến thức hoặc hỏi thông tin cảm biến/giờ giấc.\n` +
    `- Trả lời súc tích, tự nhiên (2–4 câu, tối đa ~300 ký tự), KHÔNG dùng markdown (*, #, _, \`) để đọc mượt ra loa.\n` +
    `- SONG NGỮ: Nếu người dùng nói/nhắn bằng tiếng Anh, trả lời hoàn toàn bằng tiếng Anh tự nhiên và thêm [LANG:en] ở đầu.\n\n` +
    `LỆNH ĐIỀU KHIỂN (chỉ gắn ĐÚNG 1 thẻ ở cuối câu KHI người dùng thật sự yêu cầu):\n` +
    `- Mở đúng 1 bài (dùng số thứ tự 1..${deviceState.songList.length}): [CMD:AI_PLAY:so_thu_tu]\n` +
    `- Mở nhạc ngẫu nhiên: [CMD:AI_PLAY] | Đổi bài: [CMD:AI_NEXT] | Dừng nhạc: [CMD:AI_STOP] | Phát tiếp: [CMD:AI_RESUME]\n` +
    `- Chỉnh âm lượng loa (0..100): [CMD:SET_VOL:muc_phan_tram]\n` +
    `- Đặt báo thức (HH:MM, 1=bật / 0=tắt): [CMD:SET_ALARM:HH:MM:1] hoặc [CMD:SET_ALARM:00:00:0]\n` +
    `- Chỉnh giờ đồng hồ (HH:MM): [CMD:SET_TIME:HH:MM]\n` +
    `- Đổi nhạc chuông: [CMD:SET_RING:so_thu_tu] | Thử chuông: [CMD:TEST_RING] | Tắt chuông: [CMD:STOP_ALARM]\n` +
    `- Chuyển chế độ phần cứng (chỉ khi được yêu cầu rõ): [CMD:MENU], [CMD:MODE_1], [CMD:MODE_2], [CMD:MODE_3_PLAY], [CMD:MODE_4]`;

  const parts = [{ text: systemContext }];
  if (audioBuffer) {
    parts.push({
      inline_data: { mime_type: 'audio/wav', data: audioBuffer.toString('base64') }
    });
    parts.push({ text: 'Nghe đoạn ghi âm trên (tiếng Việt hoặc tiếng Anh) và trả lời tự nhiên.' });
  } else if (textPrompt) {
    parts.push({ text: `Người dùng nói: ${textPrompt}` });
  }

  const rawText = await callGeminiRaw(parts);
  if (!rawText) {
    // Thu fallback mo nhac cuc bo neu nguoi dung dang ra lenh nhac
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
    online: deviceState.online
  });
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

    pushChat('Bạn', userText);
    const { text: replyText, lang } = await askGemini({ textPrompt: userText });
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