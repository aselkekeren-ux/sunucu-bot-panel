/* ──────────────────────────────────────────────────────────
   SUNUCU BOT PANEL — Frontend App Logic
   ────────────────────────────────────────────────────────── */

const socket = io();

// ── State ────────────────────────────────────────────────
let currentUser   = null;
let currentBotId  = null;
const botsMap     = new Map();

// ── 3D Skin Viewers ──────────────────────────────────────
let createViewer  = null; // Create-bot screen
let dashViewer    = null; // Dashboard screen
let pendingSkinBlob = null;
let pendingCapeBlob = null;

// Default Steve skin (base64 tiny placeholder — skinview3d loads steve by default)
const DEFAULT_SKIN_URL = 'https://texture.lobicraft.net/v2/skin/MHF_Steve';
const DEFAULT_CAPE_URL = null;

// ── Screens ──────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = 'block';
}

// ── Socket connection ─────────────────────────────────────
socket.on('connect', () => {
  document.getElementById('conn-text').textContent = 'Bağlı';
  document.querySelector('.conn-dot').classList.add('online');
  if (currentUser) {
    socket.emit('auth-session', currentUser);
  }
});
socket.on('disconnect', () => {
  document.getElementById('conn-text').textContent = 'Bağlantı Kesildi';
  document.querySelector('.conn-dot').classList.remove('online');
});

// ── Auth Tabs ─────────────────────────────────────────────
document.getElementById('tab-login-btn').addEventListener('click', () => {
  document.getElementById('tab-login-btn').classList.add('active');
  document.getElementById('tab-register-btn').classList.remove('active');
  document.getElementById('form-login').style.display = 'flex';
  document.getElementById('form-register').style.display = 'none';
});
document.getElementById('tab-register-btn').addEventListener('click', () => {
  document.getElementById('tab-register-btn').classList.add('active');
  document.getElementById('tab-login-btn').classList.remove('active');
  document.getElementById('form-register').style.display = 'flex';
  document.getElementById('form-login').style.display = 'none';
});

// ── Login ──────────────────────────────────────────────────
document.getElementById('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const res  = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await res.json();
    if (data.success) {
      currentUser = data.username;
      document.getElementById('user-display').textContent = currentUser;
      showScreen('screen-botlist');
      initBotList();
    } else {
      errEl.textContent = data.message || 'Giriş başarısız.';
    }
  } catch { errEl.textContent = 'Sunucuya bağlanılamadı.'; }
});

// ── Register ───────────────────────────────────────────────
document.getElementById('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl    = document.getElementById('reg-error');
  errEl.textContent = '';
  try {
    const res  = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await res.json();
    if (data.success) {
      currentUser = data.username;
      document.getElementById('user-display').textContent = currentUser;
      showScreen('screen-botlist');
      initBotList();
    } else {
      errEl.textContent = data.message || 'Kayıt başarısız.';
    }
  } catch { errEl.textContent = 'Sunucuya bağlanılamadı.'; }
});

// ── Logout ─────────────────────────────────────────────────
document.getElementById('btn-logout').addEventListener('click', () => {
  currentUser  = null;
  currentBotId = null;
  botsMap.clear();
  showScreen('screen-auth');
});

// ══════════════════════════════════════════════════════════
//  BOT LIST
// ══════════════════════════════════════════════════════════
function initBotList() {
  if (currentUser) {
    socket.emit('auth-session', currentUser);
  }
}

socket.on('init-bots', bots => {
  botsMap.clear();
  bots.forEach(b => botsMap.set(b.id, b));
  renderBotGrid();
});

socket.on('bot-created', bot => {
  botsMap.set(bot.id, bot);
  renderBotGrid();
});

socket.on('bot-deleted', id => {
  botsMap.delete(id);
  renderBotGrid();
  if (currentBotId === id) showScreen('screen-botlist');
});

socket.on('bot-status', ({ botId, status }) => {
  const bot = botsMap.get(botId);
  if (bot) { bot.status = status; updateBotCardStatus(botId, status); }
  if (currentBotId === botId) updateDashStatus(status);
});

socket.on('bot-log', ({ botId, message }) => {
  if (currentBotId === botId) appendLog(message);
});

socket.on('bot-logs-history', ({ botId, logs }) => {
  if (currentBotId === botId) {
    const out = document.getElementById('console-output');
    out.innerHTML = '';
    logs.forEach(appendLog);
  }
});

socket.on('bot-config-updated', ({ botId, config }) => {
  botsMap.set(botId, { ...(botsMap.get(botId) || {}), ...config });
  if (currentBotId === botId && (config.skinUrl || config.capeUrl)) {
    refreshDashSkin(config.skinUrl, config.capeUrl);
  }
});

function renderBotGrid() {
  const grid = document.getElementById('bot-grid');
  grid.innerHTML = '';
  if (botsMap.size === 0) {
    grid.innerHTML = `<div class="empty-card glass" id="empty-card">
      <i class="fa-solid fa-ghost"></i><h3>Henüz bot yok</h3>
      <p>"Bot Oluştur" butonuna tıklayarak ilk botunu ekle.</p></div>`;
    return;
  }
  botsMap.forEach(bot => grid.appendChild(createBotCard(bot)));
}

function createBotCard(bot) {
  const card = document.createElement('div');
  card.className = 'bot-card';
  card.id = `card-${bot.id}`;
  const statusLabel = bot.status === 'online' ? 'Online' : bot.status === 'connecting' ? 'Bağlanıyor...' : bot.status === 'error' ? 'Hata' : 'Offline';
  const markOnline = bot.status === 'online';
  const skinSrc = bot.skinUrl || `https://mc-heads.net/avatar/${bot.username}/48`;
  card.innerHTML = `
    <div class="bot-card-top">
      <img src="${skinSrc}" alt="avatar" class="bot-card-avatar" id="card-avatar-${bot.id}" onerror="this.src='https://mc-heads.net/avatar/char/48'">
      <div class="bot-card-meta">
        <h4>${bot.username}</h4>
        <p>${bot.host}:${bot.port} <span style="opacity:.5">·</span> ${bot.protocol === 'bedrock' ? '📦 Bedrock' : '☕ Java'}</p>
      </div>
    </div>
    <div class="bot-card-status" id="card-status-${bot.id}">
      <span class="status-dot ${bot.status || 'offline'}"></span>
      <span>${statusLabel}</span>
      <span class="status-icon-mark ${markOnline ? 'online' : 'offline'}" style="margin-left:auto">${markOnline ? '✓' : '✗'}</span>
    </div>`;
  card.addEventListener('click', () => openDashboard(bot.id));
  return card;
}

function updateBotCardStatus(botId, status) {
  const el = document.getElementById(`card-status-${botId}`);
  if (!el) return;
  const label = status === 'online' ? 'Online' : status === 'connecting' ? 'Bağlanıyor...' : status === 'error' ? 'Hata' : 'Offline';
  el.innerHTML = `
    <span class="status-dot ${status}"></span>
    <span>${label}</span>
    <span class="status-icon-mark ${status === 'online' ? 'online' : 'offline'}" style="margin-left:auto">${status === 'online' ? '✓' : '✗'}</span>`;
}

// ── Create Bot Button ──────────────────────────────────────
document.getElementById('btn-create-bot').addEventListener('click', () => {
  pendingSkinBlob = null;
  pendingCapeBlob = null;
  document.getElementById('skin-file-name').textContent = 'Dosya seçilmedi';
  document.getElementById('cape-file-name').textContent = 'Dosya seçilmedi';
  showScreen('screen-create');
  initCreateViewer();
});

document.getElementById('btn-back-from-create').addEventListener('click', () => showScreen('screen-botlist'));

// ══════════════════════════════════════════════════════════
//  3D SKIN VIEWER — Create Screen
// ══════════════════════════════════════════════════════════
function initCreateViewer() {
  if (createViewer) { createViewer.dispose(); createViewer = null; }
  const canvas = document.getElementById('skin-canvas');
  createViewer = new skinview3d.SkinViewer({
    canvas,
    width: 260,
    height: 380,
    skin: DEFAULT_SKIN_URL,
  });
  const control = skinview3d.createOrbitControls(createViewer);
  control.enableRotate = true;
  control.enableZoom   = false;
  createViewer.animation = new skinview3d.WalkingAnimation();
  createViewer.animation.speed = 0.6;
}

// Skin file pick → preview on create viewer
document.getElementById('input-skin-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  pendingSkinBlob = file;
  document.getElementById('skin-file-name').textContent = file.name;
  if (createViewer) createViewer.loadSkin(URL.createObjectURL(file));
});

// Cape file pick → preview on create viewer
document.getElementById('input-cape-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  pendingCapeBlob = file;
  document.getElementById('cape-file-name').textContent = file.name;
  if (createViewer) createViewer.loadCape(URL.createObjectURL(file));
});

// Protocol toggle — Create screen
setupProtocolToggle('protocol-toggle', 'create-protocol');

// ── Create Bot Form ────────────────────────────────────────
document.getElementById('form-create-bot').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('create-username').value.trim();
  const host     = document.getElementById('create-host').value.trim();
  const port     = parseInt(document.getElementById('create-port').value) || 25565;
  const version  = document.getElementById('create-version').value;
  const protocol = document.getElementById('create-protocol').value;
  const reconnect = document.getElementById('create-reconnect').checked;

  socket.emit('create-bot', { username, host, port, version, protocol, autoReconnect: reconnect });

  // Wait briefly for bot-created event then upload pending files
  await new Promise(r => setTimeout(r, 600));
  const botArr = [...botsMap.values()];
  const newBot = botArr.find(b => b.username === username && b.host === host);
  if (newBot) {
    if (pendingSkinBlob) await uploadFile(`/api/bots/${newBot.id}/upload-skin`, 'skinFile', pendingSkinBlob);
    if (pendingCapeBlob) await uploadFile(`/api/bots/${newBot.id}/upload-cape`, 'capeFile', pendingCapeBlob);
    pendingSkinBlob = null; pendingCapeBlob = null;
    openDashboard(newBot.id);
  } else {
    showScreen('screen-botlist');
  }
});

async function uploadFile(url, fieldName, file) {
  const fd = new FormData();
  fd.append(fieldName, file);
  try { await fetch(url, { method: 'POST', body: fd }); } catch (e) { console.error(e); }
}

// ══════════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════════
function openDashboard(botId) {
  currentBotId = botId;
  const bot = botsMap.get(botId);
  if (!bot) return;

  // Header
  document.getElementById('dash-bot-name').textContent = bot.username;
  document.getElementById('dash-bot-addr').textContent = `${bot.host}:${bot.port}`;

  // Status
  updateDashStatus(bot.status || 'offline');

  // Server connect form pre-fill
  document.getElementById('conn-host').value    = bot.host;
  document.getElementById('conn-port').value    = bot.port;
  document.getElementById('conn-version').value = bot.version || 'auto';
  document.getElementById('conn-protocol').value = bot.protocol || 'java';
  highlightProtocol('conn-protocol-toggle', bot.protocol || 'java');

  // Mods
  syncModToggle('mod-antiAfk',    bot.mods?.antiAfk    ?? true);
  syncModToggle('mod-autoEat',    bot.mods?.autoEat    ?? false);
  syncModToggle('mod-follow',     bot.mods?.follow     ?? false);
  syncModToggle('mod-guard',      bot.mods?.guard      ?? false);
  syncModToggle('mod-aiAssistant',bot.mods?.aiAssistant ?? false);
  toggleAiKeySection(bot.mods?.aiAssistant ?? false);

  // Script badge
  const badge = document.getElementById('active-script-badge');
  if (bot.scriptName) { document.getElementById('active-script-name').textContent = bot.scriptName; badge.style.display = 'flex'; }
  else badge.style.display = 'none';

  // Mini header avatar
  initMiniAvatar(bot.skinUrl || null, bot.username);

  showScreen('screen-dashboard');
  // Skin viewer
  initDashViewer(bot.skinUrl, bot.capeUrl);

  // Logs
  document.getElementById('console-output').innerHTML = '';
  socket.emit('get-logs', botId);
}

function initMiniAvatar(skinUrl, username) {
  // Draw mc-heads avatar in header canvas
  const c = document.getElementById('dash-avatar-canvas');
  const ctx = c.getContext('2d');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { ctx.clearRect(0,0,40,40); ctx.drawImage(img,0,0,40,40); };
  img.src = skinUrl || `https://mc-heads.net/avatar/${username}/40`;
}

function initDashViewer(skinUrl, capeUrl) {
  if (dashViewer) { dashViewer.dispose(); dashViewer = null; }
  const canvas = document.getElementById('dash-skin-canvas');
  dashViewer = new skinview3d.SkinViewer({ canvas, width: 180, height: 280, skin: skinUrl || DEFAULT_SKIN_URL });
  const control = skinview3d.createOrbitControls(dashViewer);
  control.enableRotate = true;
  control.enableZoom   = false;
  dashViewer.animation = new skinview3d.WalkingAnimation();
  dashViewer.animation.speed = 0.5;
  if (capeUrl) dashViewer.loadCape(capeUrl);
}

function refreshDashSkin(skinUrl, capeUrl) {
  if (!dashViewer) return;
  if (skinUrl) dashViewer.loadSkin(skinUrl);
  if (capeUrl)  dashViewer.loadCape(capeUrl);
}

// Update status badge + buttons
function updateDashStatus(status) {
  const badge   = document.getElementById('dash-status-badge');
  const btnStart = document.getElementById('dash-btn-start');
  const btnStop  = document.getElementById('dash-btn-stop');
  badge.className = `status-pill ${status}`;
  const icon = status === 'online' ? '✓' : status === 'connecting' ? '…' : '✗';
  const label = status === 'online' ? 'Online' : status === 'connecting' ? 'Bağlanıyor' : status === 'error' ? 'Hata' : 'Offline';
  badge.innerHTML = `<span class="status-icon">${icon}</span><span class="status-text">${label}</span>`;
  btnStart.disabled = (status === 'online' || status === 'connecting');
  btnStop.disabled  = (status !== 'online' && status !== 'connecting');
}

// Back button
document.getElementById('btn-back-from-dash').addEventListener('click', () => {
  if (dashViewer) { dashViewer.dispose(); dashViewer = null; }
  currentBotId = null;
  showScreen('screen-botlist');
});

// Start / Stop / Delete
document.getElementById('dash-btn-start').addEventListener('click', () => { if (currentBotId) socket.emit('start-bot', currentBotId); });
document.getElementById('dash-btn-stop').addEventListener('click',  () => { if (currentBotId) socket.emit('stop-bot',  currentBotId); });
document.getElementById('dash-btn-delete').addEventListener('click', () => {
  if (currentBotId && confirm('Bu botu silmek istediğine emin misin?')) socket.emit('delete-bot', currentBotId);
});
// Edit Bot Modal
const editModal = document.getElementById('edit-modal');
document.getElementById('dash-btn-edit').addEventListener('click', () => {
  if (!currentBotId) return;
  const bot = botsMap.get(currentBotId);
  if (!bot) return;

  document.getElementById('edit-username').value = bot.username;
  document.getElementById('edit-host').value = bot.host;
  document.getElementById('edit-port').value = bot.port;
  document.getElementById('edit-version').value = bot.version;
  document.getElementById('edit-protocol').value = bot.protocol;
  document.getElementById('edit-reconnect').checked = bot.autoReconnect;
  document.getElementById('edit-error').textContent = '';

  editModal.style.display = 'flex';
});

document.getElementById('btn-close-edit').addEventListener('click', () => {
  editModal.style.display = 'none';
});

editModal.addEventListener('click', e => {
  if (e.target === editModal) editModal.style.display = 'none';
});

document.getElementById('form-edit-bot').addEventListener('submit', async e => {
  e.preventDefault();
  if (!currentBotId) return;
  
  const username = document.getElementById('edit-username').value.trim();
  const host     = document.getElementById('edit-host').value.trim();
  const port     = parseInt(document.getElementById('edit-port').value) || 25565;
  const version  = document.getElementById('edit-version').value;
  const protocol = document.getElementById('edit-protocol').value;
  const reconnect= document.getElementById('edit-reconnect').checked;
  const errEl    = document.getElementById('edit-error');

  errEl.textContent = '';
  
  try {
    const res = await fetch(`/api/bots/${currentBotId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, host, port, version, protocol, autoReconnect: reconnect })
    });
    const data = await res.json();
    if (data.success) {
      editModal.style.display = 'none';
      document.getElementById('dash-bot-name').textContent = username;
      document.getElementById('dash-bot-addr').textContent = `${host}:${port}`;
      // Also update the bot grid to reflect changes immediately
      const bot = botsMap.get(currentBotId);
      if (bot) {
        bot.username = username; bot.host = host; bot.port = port; bot.version = version; bot.protocol = protocol; bot.autoReconnect = reconnect;
        renderBotGrid();
      }
    } else {
      errEl.textContent = data.message || 'Güncelleme başarısız oldu.';
    }
  } catch(e) {
    errEl.textContent = 'Sunucuya ulaşılamıyor.';
  }
});


// ── Console ────────────────────────────────────────────────
function appendLog(message) {
  const out = document.getElementById('console-output');
  const div = document.createElement('div');
  div.textContent = message;
  if (message.includes('[Server]'))             div.className = 'log-server';
  else if (/error|hata|kicked|failed/i.test(message)) div.className = 'log-error';
  else if (/spawn|success|✅/i.test(message))   div.className = 'log-success';
  else if (/mod \[|anti-|bağlan|script/i.test(message)) div.className = 'log-warn';
  else if (/\[script\]/i.test(message))         div.className = 'log-script';
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

function sendConsole() {
  const input = document.getElementById('console-input');
  const cmd   = input.value.trim();
  if (cmd && currentBotId) { socket.emit('send-command', { botId: currentBotId, command: cmd }); input.value = ''; }
}
document.getElementById('btn-send').addEventListener('click', sendConsole);
document.getElementById('console-input').addEventListener('keypress', e => { if (e.key === 'Enter') sendConsole(); });

// ── Server Connect Form (in dashboard) ────────────────────
setupProtocolToggle('conn-protocol-toggle', 'conn-protocol');
document.getElementById('form-connect').addEventListener('submit', e => {
  e.preventDefault();
  if (!currentBotId) return;
  const bot = botsMap.get(currentBotId);
  if (!bot) return;
  bot.host     = document.getElementById('conn-host').value.trim();
  bot.port     = parseInt(document.getElementById('conn-port').value) || 25565;
  bot.version  = document.getElementById('conn-version').value;
  bot.protocol = document.getElementById('conn-protocol').value;
  document.getElementById('dash-bot-addr').textContent = `${bot.host}:${bot.port}`;
  socket.emit('start-bot', currentBotId);
  // Switch to console tab
  switchTab('tab-console');
});

// ── Mod Toggles ────────────────────────────────────────────
['mod-antiAfk','mod-autoEat','mod-follow','mod-guard','mod-aiAssistant'].forEach(id => {
  document.getElementById(id).addEventListener('change', async function() {
    if (!currentBotId) return;
    const modName = id.replace('mod-', '');
    await fetch(`/api/bots/${currentBotId}/toggle-mod`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modName, enabled: this.checked })
    });
    if (modName === 'aiAssistant') toggleAiKeySection(this.checked);
  });
});

function toggleAiKeySection(show) {
  document.getElementById('ai-key-section').style.display = show ? 'flex' : 'none';
}

document.getElementById('btn-save-ai-key').addEventListener('click', async () => {
  if (!currentBotId) return;
  const key = document.getElementById('ai-api-key').value.trim();
  await fetch(`/api/bots/${currentBotId}/set-ai-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key })
  });
  alert('API anahtarı kaydedildi!');
});

// ── Skin/Cape Upload (Dashboard) ───────────────────────────
document.getElementById('dash-input-skin').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || !currentBotId) return;
  const fd = new FormData(); fd.append('skinFile', file);
  const res = await fetch(`/api/bots/${currentBotId}/upload-skin`, { method: 'POST', body: fd });
  const data = await res.json();
  if (data.success && dashViewer) dashViewer.loadSkin(data.url);
});

document.getElementById('dash-input-cape').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || !currentBotId) return;
  const fd = new FormData(); fd.append('capeFile', file);
  const res = await fetch(`/api/bots/${currentBotId}/upload-cape`, { method: 'POST', body: fd });
  const data = await res.json();
  if (data.success && dashViewer) dashViewer.loadCape(data.url);
});

// ── Script Upload ──────────────────────────────────────────
document.getElementById('input-script-file').addEventListener('change', e => {
  const f = e.target.files[0];
  document.getElementById('script-file-name').textContent = f ? f.name : 'Seçilmedi';
});
document.getElementById('form-script').addEventListener('submit', async e => {
  e.preventDefault();
  if (!currentBotId) return;
  const file = document.getElementById('input-script-file').files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('scriptFile', file);
  const res  = await fetch(`/api/bots/${currentBotId}/upload-script`, { method: 'POST', body: fd });
  const data = await res.json();
  if (data.success) {
    document.getElementById('active-script-name').textContent = data.scriptName;
    document.getElementById('active-script-badge').style.display = 'flex';
    alert(`"${data.scriptName}" yüklendi!`);
  }
});

// ── Tabs ───────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-pane').forEach(p => { p.style.display = p.id === tabId ? (p.id === 'tab-console' ? 'flex' : 'block') : 'none'; });
}

// ── Helpers ────────────────────────────────────────────────
function syncModToggle(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = !!value;
}

function setupProtocolToggle(containerId, hiddenId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.proto-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.proto-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(hiddenId).value = btn.dataset.proto;
    });
  });
}

function highlightProtocol(containerId, proto) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.proto-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.proto === proto);
  });
}

// ── Theme Switcher ─────────────────────────────────────────
const themeModal = document.getElementById('theme-modal');
const themeBtns = [
  document.getElementById('btn-theme-botlist'),
  document.getElementById('btn-theme-create'),
  document.getElementById('btn-theme-dash')
];

themeBtns.forEach(btn => {
  if (btn) {
    btn.addEventListener('click', () => {
      themeModal.style.display = 'flex';
    });
  }
});

document.getElementById('btn-close-theme').addEventListener('click', () => {
  themeModal.style.display = 'none';
});

themeModal.addEventListener('click', e => {
  if (e.target === themeModal) themeModal.style.display = 'none';
});

function setTheme(themeName) {
  document.documentElement.setAttribute('data-theme', themeName);
  localStorage.setItem('aternosbot-theme', themeName);
  
  if (themeName !== 'custom') {
    document.documentElement.style.removeProperty('--primary');
    document.documentElement.style.removeProperty('--orb1');
  }
  
  document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === themeName);
  });
}

function setCustomTheme(hexColor) {
  document.documentElement.setAttribute('data-theme', 'custom');
  localStorage.setItem('aternosbot-theme', 'custom');
  localStorage.setItem('aternosbot-custom-color', hexColor);
  
  document.documentElement.style.setProperty('--primary', hexColor);
  document.documentElement.style.setProperty('--orb1', hexColor);
  
  document.querySelectorAll('.theme-opt').forEach(btn => btn.classList.remove('active'));
}

document.querySelectorAll('.theme-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    setTheme(btn.dataset.theme);
  });
});

const customColorInput = document.getElementById('custom-theme-color');
if (customColorInput) {
  customColorInput.addEventListener('input', (e) => {
    setCustomTheme(e.target.value);
  });
}

// Load saved theme on startup
const savedTheme = localStorage.getItem('aternosbot-theme') || 'dark';
if (savedTheme === 'custom') {
  const c = localStorage.getItem('aternosbot-custom-color') || '#8b5cf6';
  if (customColorInput) customColorInput.value = c;
  setCustomTheme(c);
} else {
  setTheme(savedTheme);
}

