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

// Cache phien am Romaji cho tung ten file goc de khong ton quota Gemini khi dong bo lai
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

async function callGeminiRaw(parts) {
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
      if (text) return text;
      console.error(`[GEMINI ${model} ERR]`, JSON.stringify(data));
    } catch (err) {
      console.error(`[GEMINI ${model} FETCH ERR]`, err.message);
    }
  }
  return null;
}

// Lam sach ten file ASCII co ban
function basicCleanAscii(name) {
  let s = String(name || '')
    .replace(/\.mp3$/i, '')
    .replace(/\s*-\s*YouTube$/i, '')
    .replace(/[\(\[]?(Official\s+)?(Music\s+)?(Lyric\s+)?(Animation\s+)?(Video\vert{}MV)[\)\]]?/gi, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || 'Track';
}

// Tu dong nho Gemini phien am cac bai co chu Nhat/Han/Trung sang Romaji/ASCII cho OLED
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
      `Return ONLY lines in exact format: INDEX|CLEAN_ASCII_TITLE (only ASCII 32-126, no markdown, no explanations).\n` +
      `Examples: YOASOBIアイドル -> YOASOBI - Idol ; YOASOBI怪物 -> YOASOBI - Kaibutsu ; 恋愛脳 - ナナヲアカリ -> Renai Nou - Nanawoakari\n\n` +
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

  const systemContext =
    `Bạn là trợ lý ảo cực kỳ dí dỏm, hài hước, lầy lội nhẹ nhàng và thân thiện như một người bạn thân của Vang trong Hộp Nhạc IoT.\n` +
    `Trạng thái mạch: Nhiệt độ ${deviceState.temp}°C, Độ ẩm ${deviceState.hum}%, Ánh sáng ${deviceState.light}%, ` +
    `Pin ${deviceState.usbPower ? 'đang cắm USB' : deviceState.bat + '%'}, Giờ DS1307 ${deviceState.timeStr}, ` +
    `Nhạc chuông ${deviceState.ringtone}, Nhạc AI đang phát: ${deviceState.aiPlaying ? (deviceState.currentSong || 'Có') : 'Không'}.\n` +
    `TOÀN BỘ ${deviceState.songList.length} BÀI NHẠC TRONG THẺ SD (gồm cả tiếng Anh, tiếng Việt và tiếng Nhật): ${numberedSongs}.\n` +
    `QUY TẮC:\n` +
    `- Tính cách dí dỏm, tự nhiên, xưng hô bạn bè thân mật ("tui/bạn" hoặc "mình/bồ"), tránh cứng nhắc kiểu robot ("Dạ em... ạ").\n` +
    `- SONG NGỮ: Nếu người dùng hỏi hoặc nói bằng tiếng Anh, HÃY TRẢ LỜI HOÀN TOÀN BẰNG TIẾNG ANH tự nhiên, hài hước và gắn thêm thẻ [LANG:en] ở đầu câu trả lời. Nếu người dùng nói tiếng Việt, trả lời bằng tiếng Việt.\n` +
    `- Trả lời ngắn gọn (tối đa 2 câu, không dùng markdown * # _ \`) để đọc mượt ra loa. Nếu được hỏi liệt kê danh sách nhạc thì báo tổng số bài (${deviceState.songList.length} bài) và kể vài bài nổi bật.\n` +
    `- Bạn hiểu tất cả tên bài tiếng Nhật (Kanji/Kana), Romaji, tiếng Anh và tiếng Việt (VD: Idol = アイドル, Kaibutsu = 怪物, Renai Nou = 恋愛脳, Kami no Manimani = 神のまにまに, Hyururirappa = ひゅるりらっぱ).\n` +
    `- Khi người dùng yêu cầu mở nhạc / đổi bài / dừng nhạc, MẶC ĐỊNH phát ngay trong chế độ AI (KHÔNG chuyển sang MODE_1 trừ khi người dùng nói rõ "chuyển chế độ 1").\n` +
    `- Khi có lệnh điều khiển, LUÔN gắn ĐÚNG 1 thẻ lệnh ở cuối câu (không giải thích thẻ):\n` +
    `  * Mở đúng 1 bài trong thẻ SD (BẮT BUỘC dùng đúng số thứ tự 1..${deviceState.songList.length} nếu khớp, VD bài số 21 -> [CMD:AI_PLAY:21]): [CMD:AI_PLAY:so_thu_tu]\n` +
    `  * Mở nhạc ngẫu nhiên / bất kỳ: [CMD:AI_PLAY]\n` +
    `  * Đổi bài khác / bài tiếp theo: [CMD:AI_NEXT]\n` +
    `  * Dừng / tắt nhạc đang phát trong AI: [CMD:AI_STOP]\n` +
    `  * Phát tiếp nhạc đang tạm dừng: [CMD:AI_RESUME]\n` +
    `  * Về menu chính / thoát chế độ AI: [CMD:MENU]\n` +
    `  * Chuyển hẳn sang chế độ 1 (SD thủ công): [CMD:MODE_1]\n` +
    `  * Bật chế độ 2 Loa Bluetooth (nhắc người dùng mở Bluetooth kết nối ESP32_AI_Speaker): [CMD:MODE_2]\n` +
    `  * Bật chế độ 3 tìm & tự kết nối loa/tai nghe Bluetooth ngoài rồi phát nhạc: [CMD:MODE_3_PLAY] (hoặc [CMD:MODE_3_PLAY:so_thu_tu])\n` +
    `  * Bật chế độ 4 đồng hồ/báo thức & chọn nhạc chuông: [CMD:MODE_4:so_thu_tu] (hoặc [CMD:MODE_4])\n` +
    `  * Thử chuông báo thức ngay: [CMD:TEST_RING]`;

  const parts = [{ text: systemContext }];
  if (audioBuffer) {
    parts.push({
      inline_data: { mime_type: 'audio/wav', data: audioBuffer.toString('base64') }
    });
    parts.push({ text: 'Nghe đoạn ghi âm trên (có thể bằng tiếng Việt hoặc tiếng Anh) và trả lời tự nhiên.' });
  } else if (textPrompt) {
    parts.push({ text: `Người dùng nói: ${textPrompt}` });
  }

  const rawText = await callGeminiRaw(parts);
  if (!rawText) {
    return { text: 'Ui não AI hơi lag xíu, bồ gọi lại sau vài giây nha!', lang: 'vi' };
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

  // Tu dong nhan dien tieng Anh du phong neu Gemini quen gan [LANG:en]
  const hasViDiacritics = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(cleanReply);
  if (!hasViDiacritics && /[a-zA-Z]{3,}/.test(cleanReply)) {
    lang = 'en';
  }

  return { text: cleanReply, lang };
}

async function textToMp3File(text, lang = 'vi') {
  const shortText = text.slice(0, 195);
  const tl = lang === 'en' ? 'en' : 'vi';
  const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(shortText)}&tl=${tl}&client=tw-ob`;
  const res = await fetch(ttsUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(REPLY_MP3_PATH, buf);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'MusicBox_AI_Cloud', ts: Date.now() });
});

// Nhan danh sach full bai hat dang text/plain (moi dong 1 ten file) -> tra ve ten Romaji/ASCII sach cho OLED
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