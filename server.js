const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// ── Directories ───────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR    = path.join(__dirname, 'data');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const NICK_FILE   = path.join(DATA_DIR, 'taken_nicks.json'); // global nick registry
[UPLOADS_DIR, DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── JSON helpers ──────────────────────────────────────────────────────────────
const readJSON  = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// Per-user bots file path
const userBotsFile = (username) => path.join(DATA_DIR, `bots_${username.toLowerCase()}.json`);

// ── Multer ─────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── In-memory state ───────────────────────────────────────────────────────────
const activeBots = new Map(); // botId → mineflayer/bedrock instance
const botLogs    = new Map(); // botId → string[]
const botConfigs = new Map(); // botId → config (all users, all bots, in memory)
const socketUser = new Map(); // socketId → username (track who owns each socket session)

// ── Load ALL persisted bots on startup ────────────────────────────────────────
if (fs.existsSync(DATA_DIR)) {
  fs.readdirSync(DATA_DIR).forEach(file => {
    if (file.startsWith('bots_') && file.endsWith('.json')) {
      const bots = readJSON(path.join(DATA_DIR, file), []);
      bots.forEach(cfg => {
        botConfigs.set(cfg.id, { ...cfg, status: 'offline', statusDetails: '' });
        botLogs.set(cfg.id, []);
      });
    }
  });
}

// ── Save bots for a specific user ─────────────────────────────────────────────
function saveUserBots(username) {
  const userBots = [...botConfigs.values()].filter(b => b.owner === username.toLowerCase());
  writeJSON(userBotsFile(username), userBots.map(c => ({ ...c, status: 'offline', statusDetails: '' })));
}

// ── Logging ────────────────────────────────────────────────────────────────────
function logBot(botId, message) {
  const msg = `[${new Date().toLocaleTimeString()}] ${message}`;
  if (!botLogs.has(botId)) botLogs.set(botId, []);
  const logs = botLogs.get(botId);
  logs.push(msg);
  if (logs.length > 600) logs.shift();
  io.emit('bot-log', { botId, message: msg });
}

function setBotStatus(botId, status, details = '') {
  const cfg = botConfigs.get(botId);
  if (!cfg) return;
  cfg.status = status; cfg.statusDetails = details;
  io.emit('bot-status', { botId, status, details });
}

// ── Nick Registry ─────────────────────────────────────────────────────────────
// taken_nicks.json: { "NickName": "ownerUsername", ... }
function isNickTaken(nick) {
  const registry = readJSON(NICK_FILE, {});
  return !!registry[nick.toLowerCase()];
}
function getNickOwner(nick) {
  const registry = readJSON(NICK_FILE, {});
  return registry[nick.toLowerCase()] || null;
}
function registerNick(nick, username) {
  const registry = readJSON(NICK_FILE, {});
  registry[nick.toLowerCase()] = username.toLowerCase();
  writeJSON(NICK_FILE, registry);
}
function releaseNick(nick) {
  const registry = readJSON(NICK_FILE, {});
  delete registry[nick.toLowerCase()];
  writeJSON(NICK_FILE, registry);
}

// ── AI ─────────────────────────────────────────────────────────────────────────
const AI_FALLBACKS = [
  q => `Hmm, "${q}" ilginç bir şey! Ben de düşünüyordum tam bunu.`,
  q => `${q} diyorsun... Katılıyorum aslında!`,
  () => 'Anlıyorum, devam et bakalım.',
  () => 'İyi soru! Kendim de bazen bunu merak ediyorum.',
  () => 'Kesinlikle haklısın!',
  () => 'Biraz düşünmem lazım bunu, ama güzel nokta.',
  () => 'Haha bilmiyorum tam olarak ama ilginç!',
];

async function getAIResponse(question, apiKey) {
  if (apiKey && apiKey.trim().length > 10) {
    try {
      const { default: fetch } = await import('node-fetch');
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Sen bir Minecraft oyuncususun, kesinlikle bir bot veya yapay zeka değilsin. Bunu ima eden sorulara sinirlenerek inkar et. Doğal, kısa (max 2 cümle) ve samimi cevaplar ver. Soru: ${question}` }] }]
          })
        }
      );
      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    } catch (e) { console.error('Gemini API error:', e.message); }
  }
  const fn = AI_FALLBACKS[Math.floor(Math.random() * AI_FALLBACKS.length)];
  return fn(question);
}

// ── World Border Movement ──────────────────────────────────────────────────────
function startWorldBorderMovement(bot, botId) {
  logBot(botId, '[Anti-Detect] Teleporting to world border + sky limit (uzay modu)...');
  setTimeout(() => { try { bot.chat('/tp @s 29999984 319 29999984'); } catch(e){} }, 3500);

  const moves = [
    () => { bot.setControlState('sneak', true);   setTimeout(() => bot.setControlState('sneak', false), 900); },
    () => { bot.setControlState('jump', true);    setTimeout(() => bot.setControlState('jump', false), 400); },
    () => { bot.look(Math.random() * Math.PI * 2, -Math.PI / 3 + Math.random() * 0.4); },
    () => { bot.setControlState('forward', true); setTimeout(() => bot.setControlState('forward', false), 700); },
    () => { bot.setControlState('left', true);    setTimeout(() => bot.setControlState('left', false), 500); },
    () => { bot.setControlState('right', true);   setTimeout(() => bot.setControlState('right', false), 500); },
  ];

  return setInterval(() => {
    if (!bot.entity) return;
    moves[Math.floor(Math.random() * moves.length)]();
    logBot(botId, '[Anti-Detect] World-border movement done.');
  }, 25000);
}

// ── Auto-apply all mods when bot spawns ───────────────────────────────────────
function applyMods(bot, botId, cfg) {
  const mods = cfg.mods || {};

  // 1. Skin command (for cracked servers with SkinsRestorer etc.)
  if (cfg.skin) {
    setTimeout(() => {
      try { bot.chat(`/skin set ${cfg.skin}`); } catch(e){}
      try { bot.chat(`/skin ${cfg.skin}`); }    catch(e){}
      logBot(botId, `[Skin] Applied skin: ${cfg.skin}`);
    }, 3500);
  }

  // 2. World-border anti-detect movement (always on)
  const wbInterval = startWorldBorderMovement(bot, botId);

  // 3. Anti-AFK (periodic random movement)
  let afkInterval = null;
  if (mods.antiAfk !== false) { // default ON
    afkInterval = setInterval(() => {
      if (!bot.entity) return;
      const r = Math.random();
      if (r < 0.33) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 400); }
      else if (r < 0.66) bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6);
      else { bot.setControlState('sneak', true); setTimeout(() => bot.setControlState('sneak', false), 700); }
      logBot(botId, '[Anti-AFK] Movement done.');
    }, 32000);
    logBot(botId, '[Mod] Anti-AFK aktif edildi.');
  }

  // 4. Auto-Eat
  if (mods.autoEat) {
    logBot(botId, '[Mod] Oto-Yemek aktif edildi.');
    bot.on('health', () => {
      if (bot.food < 15) {
        const food = bot.inventory.items().find(i =>
          i.name.includes('apple') || i.name.includes('cooked') ||
          i.name.includes('bread') || i.name.includes('carrot') ||
          i.name.includes('steak') || i.name.includes('potato'));
        if (food) {
          bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
          logBot(botId, `[Auto-Eat] Eating: ${food.name}`);
        }
      }
    });
  }

  // 5. Follow Player
  if (mods.follow) {
    logBot(botId, '[Mod] Takip modu aktif. Birileri "gel" yazınca koşar.');
    bot._followInterval = null;
    bot.on('chat', (user, msg) => {
      if (user === bot.username) return;
      const cmd = msg.toLowerCase();
      if (['gel', 'follow', 'come'].includes(cmd)) {
        const pl = bot.players[user];
        if (pl?.entity) {
          bot.chat(`Tamam ${user}!`);
          if (bot._followInterval) clearInterval(bot._followInterval);
          bot._followInterval = setInterval(() => {
            if (!pl.entity) return;
            const dist = bot.entity.position.distanceTo(pl.entity.position);
            bot.lookAt(pl.entity.position.offset(0, pl.entity.height, 0));
            if (dist > 2.5) {
              bot.setControlState('forward', true);
              if (bot.entity.isCollidedHorizontally) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 200); }
            } else bot.setControlState('forward', false);
          }, 400);
        } else bot.chat(`${user}, seni göremiyorum!`);
      } else if (['dur', 'stop'].includes(cmd)) {
        if (bot._followInterval) { clearInterval(bot._followInterval); bot._followInterval = null; }
        bot.setControlState('forward', false);
        bot.chat('Durdum!');
      }
    });
  }

  // 6. Guard / Defense
  let guardInterval = null;
  if (mods.guard) {
    logBot(botId, '[Mod] Koruma modu aktif. Canavarlara saldırır.');
    const hostile = ['zombie','skeleton','creeper','spider','slime','enderman','witch','husk','drowned'];
    guardInterval = setInterval(() => {
      if (!bot.entity) return;
      const target = bot.nearestEntity(e => hostile.includes(e.name) && e.position.distanceTo(bot.entity.position) < 6);
      if (target) { bot.lookAt(target.position.offset(0, target.height / 2, 0)); bot.attack(target); logBot(botId, `[Guard] Attacked: ${target.name}`); }
    }, 800);
  }

  // 7. AI Assistant
  if (mods.aiAssistant) {
    logBot(botId, '[Mod] AI Asistan aktif. Chat\'te soru sorulabilir.');
    bot.on('chat', async (user, msg) => {
      if (user === bot.username) return;
      const lowerMsg = msg.toLowerCase();
      const botNameLower = bot.username.toLowerCase();
      if (lowerMsg.includes(botNameLower) || lowerMsg.startsWith('!')) {
        const question = msg.replace(new RegExp(bot.username, 'gi'), '').replace('!', '').trim();
        if (question.length > 1) {
          try {
            const reply = await getAIResponse(question, cfg.aiApiKey);
            if (reply) setTimeout(() => { try { bot.chat(reply.substring(0, 200)); } catch(e){} }, 1200 + Math.random() * 800);
          } catch(e){}
        }
      }
    });
  }

  // 8. Custom JS Script
  if (cfg.scriptPath && fs.existsSync(cfg.scriptPath)) {
    try {
      const code = fs.readFileSync(cfg.scriptPath, 'utf8');
      new Function('bot', 'console', 'logBot', code)(
        bot,
        { log: m => logBot(botId, `[Script] ${m}`), error: m => logBot(botId, `[Script Error] ${m}`) },
        m => logBot(botId, `[Script] ${m}`)
      );
      logBot(botId, `[Script] ${cfg.scriptName} yüklendi.`);
    } catch(e) { logBot(botId, `[Script] Hata: ${e.message}`); }
  }

  // Return cleanup function
  return () => {
    if (wbInterval)    clearInterval(wbInterval);
    if (afkInterval)   clearInterval(afkInterval);
    if (guardInterval) clearInterval(guardInterval);
    if (bot._followInterval) clearInterval(bot._followInterval);
  };
}

// ── Start Java Bot ─────────────────────────────────────────────────────────────
function startJavaBot(botId) {
  const cfg = botConfigs.get(botId);
  if (!cfg || activeBots.has(botId)) return;
  logBot(botId, `[Java] Bağlanılıyor: ${cfg.host}:${cfg.port} → "${cfg.username}"`);
  setBotStatus(botId, 'connecting');

  let bot;
  try {
    bot = mineflayer.createBot({
      host: cfg.host, port: parseInt(cfg.port) || 25565,
      username: cfg.username,
      version: cfg.version === 'auto' ? false : cfg.version,
      hideErrors: true,
    });
  } catch(e) { logBot(botId, `[Java] Hata: ${e.message}`); setBotStatus(botId, 'error', e.message); return; }

  activeBots.set(botId, bot);
  let cleanup = null;

  bot.on('spawn', () => {
    logBot(botId, '[Java] ✅ Sunucuya bağlandı!');
    setBotStatus(botId, 'online');
    cleanup = applyMods(bot, botId, cfg); // AUTO-LOAD ALL MODS
  });

  bot.on('chat', (user, msg) => { if (user !== bot.username) logBot(botId, `<${user}> ${msg}`); });
  bot.on('message', j => { const t = j.toString().trim(); if (t && !t.startsWith('<')) logBot(botId, `[Server] ${t}`); });
  bot.on('error', e  => { logBot(botId, `[Hata] ${e.message}`); setBotStatus(botId, 'error', e.message); });
  bot.on('kicked', r => logBot(botId, `[Kicked] ${typeof r === 'string' ? r : JSON.stringify(r)}`));

  bot.on('end', () => {
    logBot(botId, '[Java] Bağlantı kesildi.');
    setBotStatus(botId, 'offline');
    activeBots.delete(botId);
    if (cleanup) cleanup();
    if (cfg.autoReconnect && botConfigs.has(botId)) {
      logBot(botId, '[Java] 10 saniye sonra yeniden bağlanılıyor...');
      setTimeout(() => { if (botConfigs.has(botId) && !activeBots.has(botId)) startJavaBot(botId); }, 10000);
    }
  });
}

// ── Start Bedrock Bot ──────────────────────────────────────────────────────────
function startBedrockBot(botId) {
  const cfg = botConfigs.get(botId);
  if (!cfg || activeBots.has(botId)) return;
  let bp;
  try { bp = require('bedrock-protocol'); } catch {
    logBot(botId, '[Bedrock] bedrock-protocol kurulu değil. npm install bedrock-protocol');
    setBotStatus(botId, 'error', 'bedrock-protocol not installed'); return;
  }
  logBot(botId, `[Bedrock] Bağlanılıyor: ${cfg.host}:${cfg.port || 19132} → "${cfg.username}"`);
  setBotStatus(botId, 'connecting');

  let client;
  try {
    client = bp.createClient({ host: cfg.host, port: parseInt(cfg.port) || 19132, username: cfg.username, offline: true });
  } catch(e) { logBot(botId, `[Bedrock] Hata: ${e.message}`); setBotStatus(botId, 'error', e.message); return; }

  activeBots.set(botId, client);
  let afkInterval = null;

  client.on('spawn', () => {
    logBot(botId, '[Bedrock] ✅ Sunucuya bağlandı!');
    setBotStatus(botId, 'online');

    // Skin command (some Bedrock servers support slash commands)
    if (cfg.skin) setTimeout(() => { try { client.queue('command_request', { command: `/skin ${cfg.skin}`, origin: { type: 'player', uuid: '', request_id: '' }, internal: false }); } catch(e){} }, 3500);

    if (cfg.mods?.antiAfk !== false) {
      afkInterval = setInterval(() => {
        try { client.queue('player_action', { action: 'jump', position: { x: 0, y: 0, z: 0 }, face: 0, entity_id: client.entityId || 0 }); logBot(botId, '[Bedrock Anti-AFK] Zıplandı.'); } catch(e){}
      }, 30000);
      logBot(botId, '[Mod] Anti-AFK aktif edildi (Bedrock).');
    }

    if (cfg.mods?.aiAssistant) logBot(botId, '[Mod] AI Asistan aktif (Bedrock).');
  });

  client.on('text', packet => { const m = packet.message || ''; if (m) logBot(botId, `[Bedrock Chat] ${m}`); });
  client.on('error', e => { logBot(botId, `[Bedrock Hata] ${e.message}`); setBotStatus(botId, 'error', e.message); });
  client.on('disconnect', d => {
    logBot(botId, `[Bedrock] Bağlantı kesildi: ${d?.message || ''}`);
    setBotStatus(botId, 'offline');
    activeBots.delete(botId);
    if (afkInterval) clearInterval(afkInterval);
    if (cfg.autoReconnect && botConfigs.has(botId)) {
      logBot(botId, '[Bedrock] 10 saniye sonra yeniden bağlanılıyor...');
      setTimeout(() => { if (botConfigs.has(botId) && !activeBots.has(botId)) startBedrockBot(botId); }, 10000);
    }
  });
}

// ── Stop Bot ───────────────────────────────────────────────────────────────────
function stopBot(botId) {
  const bot = activeBots.get(botId);
  const cfg = botConfigs.get(botId);
  if (!bot) { logBot(botId, 'Bot çalışmıyor.'); return; }
  logBot(botId, 'Durduruluyor...');
  if (cfg) { const orig = cfg.autoReconnect; cfg.autoReconnect = false; setTimeout(() => { if (cfg) cfg.autoReconnect = orig; }, 3000); }
  try { if (bot.quit) bot.quit(); else if (bot.disconnect) bot.disconnect(); } catch(e){}
}

// ════════════════════════════════════════════════════════════
//  REST API — AUTH
// ════════════════════════════════════════════════════════════
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 4)
    return res.status(400).json({ success: false, message: 'Kullanıcı adı (min 3) ve şifre (min 4 karakter) gereklidir.' });
  const users = readJSON(USERS_FILE, {});
  if (users[username.toLowerCase()])
    return res.status(409).json({ success: false, message: 'Bu kullanıcı adı zaten alınmış.' });
  users[username.toLowerCase()] = { username, passwordHash: crypto.createHash('sha256').update(password).digest('hex'), createdAt: Date.now() };
  writeJSON(USERS_FILE, users);
  res.json({ success: true, username });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(USERS_FILE, {});
  const user  = users[username?.toLowerCase()];
  if (!user || user.passwordHash !== crypto.createHash('sha256').update(password || '').digest('hex'))
    return res.status(401).json({ success: false, message: 'Hatalı kullanıcı adı veya şifre.' });
  res.json({ success: true, username: user.username });
});

// ════════════════════════════════════════════════════════════
//  REST API — FILES
// ════════════════════════════════════════════════════════════
app.post('/api/bots/:id/upload-skin', upload.single('skinFile'), (req, res) => {
  const cfg = botConfigs.get(req.params.id);
  if (!cfg || !req.file) return res.status(400).json({ success: false });
  if (cfg.skinFilePath && fs.existsSync(cfg.skinFilePath)) try { fs.unlinkSync(cfg.skinFilePath); } catch(e){}
  cfg.skinFilePath = req.file.path; cfg.skinFileName = req.file.originalname;
  saveUserBots(cfg.owner);
  io.emit('bot-config-updated', { botId: cfg.id, config: { skinUrl: `/uploads/${path.basename(req.file.path)}`, capeUrl: cfg.capeFilePath ? `/uploads/${path.basename(cfg.capeFilePath)}` : null } });
  res.json({ success: true, url: `/uploads/${path.basename(req.file.path)}` });
});

app.post('/api/bots/:id/upload-cape', upload.single('capeFile'), (req, res) => {
  const cfg = botConfigs.get(req.params.id);
  if (!cfg || !req.file) return res.status(400).json({ success: false });
  if (cfg.capeFilePath && fs.existsSync(cfg.capeFilePath)) try { fs.unlinkSync(cfg.capeFilePath); } catch(e){}
  cfg.capeFilePath = req.file.path; cfg.capeFileName = req.file.originalname;
  saveUserBots(cfg.owner);
  io.emit('bot-config-updated', { botId: cfg.id, config: { skinUrl: cfg.skinFilePath ? `/uploads/${path.basename(cfg.skinFilePath)}` : null, capeUrl: `/uploads/${path.basename(req.file.path)}` } });
  res.json({ success: true, url: `/uploads/${path.basename(req.file.path)}` });
});

app.post('/api/bots/:id/upload-script', upload.single('scriptFile'), (req, res) => {
  const cfg = botConfigs.get(req.params.id);
  if (!cfg || !req.file) return res.status(400).json({ success: false });
  if (cfg.scriptPath && fs.existsSync(cfg.scriptPath)) try { fs.unlinkSync(cfg.scriptPath); } catch(e){}
  cfg.scriptPath = req.file.path; cfg.scriptName = req.file.originalname;
  saveUserBots(cfg.owner);
  res.json({ success: true, scriptName: req.file.originalname });
});

app.post('/api/bots/:id/toggle-mod', (req, res) => {
  const cfg = botConfigs.get(req.params.id);
  if (!cfg) return res.status(404).json({ success: false });
  if (!cfg.mods) cfg.mods = {};
  cfg.mods[req.body.modName] = !!req.body.enabled;
  saveUserBots(cfg.owner);
  io.emit('bot-config-updated', { botId: cfg.id, config: { mods: cfg.mods } });
  res.json({ success: true });
});

app.post('/api/bots/:id/set-ai-key', (req, res) => {
  const cfg = botConfigs.get(req.params.id);
  if (!cfg) return res.status(404).json({ success: false });
  cfg.aiApiKey = req.body.apiKey || '';
  saveUserBots(cfg.owner);
  res.json({ success: true });
});

app.post('/api/bots/:id/edit', (req, res) => {
  const cfg = botConfigs.get(req.params.id);
  if (!cfg) return res.status(404).json({ success: false, message: 'Bot bulunamadı' });
  
  const { username, host, port, version, protocol, autoReconnect } = req.body;
  
  if (username && username.trim() !== '' && username.toLowerCase() !== cfg.username.toLowerCase()) {
    if (isNickTaken(username)) {
      return res.status(409).json({ success: false, message: `"${username}" ismi başka bir hesap tarafından kullanılmaktadır.` });
    }
    releaseNick(cfg.username);
    registerNick(username, cfg.owner);
    cfg.username = username.trim();
  }
  
  if (host !== undefined) cfg.host = host;
  if (port !== undefined) cfg.port = parseInt(port) || 25565;
  if (version !== undefined) cfg.version = version;
  if (protocol !== undefined) cfg.protocol = protocol;
  if (autoReconnect !== undefined) cfg.autoReconnect = !!autoReconnect;

  saveUserBots(cfg.owner);
  
  io.emit('bot-config-updated', { botId: cfg.id, config: { 
    username: cfg.username, host: cfg.host, port: cfg.port, 
    version: cfg.version, protocol: cfg.protocol, autoReconnect: cfg.autoReconnect 
  }});
  
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════════════════════
io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  // Send only the requesting user's bots (after login event)
  socket.on('auth-session', (username) => {
    if (!username) return;
    socketUser.set(socket.id, username.toLowerCase());

    // Load user bots from file if not in memory (e.g. after server restart)
    const userBotFile = userBotsFile(username);
    if (fs.existsSync(userBotFile)) {
      const persisted = readJSON(userBotFile, []);
      persisted.forEach(cfg => {
        if (!botConfigs.has(cfg.id)) {
          botConfigs.set(cfg.id, { ...cfg, status: 'offline', statusDetails: '' });
          botLogs.set(cfg.id, []);
        }
      });
    }

    const userBots = [...botConfigs.values()]
      .filter(b => b.owner === username.toLowerCase())
      .map(b => ({
        ...b,
        isRunning: activeBots.has(b.id),
        skinUrl:  b.skinFilePath  ? `/uploads/${path.basename(b.skinFilePath)}`  : null,
        capeUrl:  b.capeFilePath  ? `/uploads/${path.basename(b.capeFilePath)}`  : null,
      }));
    socket.emit('init-bots', userBots);
  });

  socket.on('get-logs', botId => socket.emit('bot-logs-history', { botId, logs: botLogs.get(botId) || [] }));

  // ── Create Bot ─────────────────────────────────────────────
  socket.on('create-bot', (data) => {
    const ownerSocket = socketUser.get(socket.id);
    if (!ownerSocket) { socket.emit('create-bot-error', { message: 'Oturum açılmamış.' }); return; }

    const nick = (data.username || '').trim();
    if (!nick) { socket.emit('create-bot-error', { message: 'Bot ismi boş olamaz.' }); return; }

    // Check nick uniqueness
    if (isNickTaken(nick) && getNickOwner(nick) !== ownerSocket) {
      socket.emit('create-bot-error', { message: `"${nick}" ismi başka bir hesap tarafından kullanılmaktadır.` });
      return;
    }

    const botId = 'bot_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const cfg = {
      id: botId,
      owner: ownerSocket,
      username: nick,
      host: data.host || 'play.aternos.me',
      port: data.port || 25565,
      version: data.version || 'auto',
      protocol: data.protocol || 'java',
      skin: data.skin || '',
      autoReconnect: data.autoReconnect !== false,
      // Mods: all enabled by default based on plan, user can toggle later
      mods: {
        antiAfk:     true,
        worldBorder: true,
        autoEat:     false,
        follow:      false,
        guard:       false,
        aiAssistant: false,
        ...data.mods,
      },
      aiApiKey:     data.aiApiKey || '',
      status:       'offline',
      statusDetails:'',
      skinFilePath: null, skinFileName: null,
      capeFilePath: null, capeFileName: null,
      scriptPath:   null, scriptName:   null,
    };

    botConfigs.set(botId, cfg);
    botLogs.set(botId, []);
    registerNick(nick, ownerSocket); // Lock nick globally
    saveUserBots(ownerSocket);
    logBot(botId, `Bot "${nick}" oluşturuldu. (Sahip: ${ownerSocket})`);

    socket.emit('bot-created', { ...cfg, isRunning: false, skinUrl: null, capeUrl: null });
  });

  // ── Start / Stop / Delete ──────────────────────────────────
  socket.on('start-bot', botId => {
    const cfg = botConfigs.get(botId);
    if (!cfg) return;
    if (cfg.protocol === 'bedrock') startBedrockBot(botId);
    else startJavaBot(botId);
  });

  socket.on('stop-bot',   botId => stopBot(botId));

  socket.on('delete-bot', botId => {
    const ownerSocket = socketUser.get(socket.id);
    const cfg = botConfigs.get(botId);
    if (!cfg || cfg.owner !== ownerSocket) return; // Only owner can delete

    stopBot(botId);
    [cfg.skinFilePath, cfg.capeFilePath, cfg.scriptPath].forEach(p => {
      if (p && fs.existsSync(p)) try { fs.unlinkSync(p); } catch(e){}
    });
    releaseNick(cfg.username); // Free the nick
    botConfigs.delete(botId);
    botLogs.delete(botId);
    saveUserBots(ownerSocket);
    io.emit('bot-deleted', botId);
  });

  socket.on('send-command', ({ botId, command }) => {
    const bot = activeBots.get(botId);
    if (bot?.chat) { try { bot.chat(command); logBot(botId, `[Gönderildi] ${command}`); } catch(e){ logBot(botId, `[Hata] ${e.message}`); } }
    else logBot(botId, '[Çevrimdışı] Bot bağlı değil, komut gönderilemedi.');
  });

  socket.on('disconnect', () => {
    socketUser.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIp = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; }
    }
  }
  console.log(`\n🚀 SUNUCU BOT PANEL`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏠 Yerel:     http://localhost:${PORT}`);
  console.log(`🌐 Ağ içi:   http://${localIp}:${PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`💡 İnternet üzerinden erişim için:`);
  console.log(`   cmd.exe /c npx -y localtunnel --port ${PORT} --subdomain sunucubotpanel`);
  console.log(`   URL: https://sunucubotpanel.loca.lt`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});

