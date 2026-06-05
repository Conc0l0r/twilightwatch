// ─────────────────────────────────────────────────────────────────────────────
//  TwilightSMP ModBot — dashboard/server.js
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const cors    = require('cors');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app  = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// ─── File paths ───────────────────────────────────────────────────────────────
const PUBLIC    = path.join(__dirname, 'public');
const LOG_FILE  = path.join(PUBLIC, 'logs.json');
const WARN_FILE = path.join(PUBLIC, 'warns.json');
const MCBAN_FILE = path.join(PUBLIC, 'mcbans.json');
const TICKET_FILE = path.join(PUBLIC, 'tickets.json');
const CONFIG_FILE = path.join(PUBLIC, 'config.json');

function readJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch {}
  return fallback;
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC));

// ─── Logs API ─────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const { action, limit = 50, page = 1, q } = req.query;
  let logs = readJSON(LOG_FILE, []);
  if (action && action !== 'ALL') logs = logs.filter(l => l.action === action);
  if (q) {
    const ql = q.toLowerCase();
    logs = logs.filter(l =>
      l.username?.toLowerCase().includes(ql) ||
      l.modName?.toLowerCase().includes(ql) ||
      l.reason?.toLowerCase().includes(ql)
    );
  }
  const total = logs.length;
  const start = (Number(page) - 1) * Number(limit);
  res.json({ logs: logs.slice(start, start + Number(limit)), total, page: Number(page), limit: Number(limit) });
});

// ─── Stats API ────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const logs   = readJSON(LOG_FILE, []);
  const warns  = readJSON(WARN_FILE, {});
  const mcbans = readJSON(MCBAN_FILE, []);
  const tickets = readJSON(TICKET_FILE, []);
  const counts = logs.reduce((a, l) => { a[l.action] = (a[l.action] || 0) + 1; return a; }, {});

  const now  = Date.now();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const s = now - i * 86400000;
    const e = s + 86400000;
    days.push({
      label: new Date(s).toLocaleDateString('en-US', { weekday: 'short' }),
      count: logs.filter(l => { const t = new Date(l.timestamp).getTime(); return t >= s && t < e; }).length
    });
  }
  const modCounts = {};
  logs.forEach(l => {
    if (l.modId) {
      if (!modCounts[l.modId]) modCounts[l.modId] = { name: l.modName, count: 0 };
      modCounts[l.modId].count++;
    }
  });
  res.json({
    counts,
    recentLogs: logs.slice(0, 10),
    activityByDay: days,
    topMods: Object.values(modCounts).sort((a, b) => b.count - a.count).slice(0, 5),
    totalWarns: Object.values(warns).reduce((s, w) => s + w.warnings.length, 0),
    totalLogs: logs.length,
    totalMcBans: mcbans.length,
    openTickets: tickets.filter(t => t.status === 'open').length,
    closedTickets: tickets.filter(t => t.status === 'closed').length,
  });
});

// ─── Warnings API ─────────────────────────────────────────────────────────────
app.get('/api/warns', (req, res) => {
  const warns = readJSON(WARN_FILE, {});
  const list  = Object.values(warns).filter(w => w.warnings.length > 0);
  list.sort((a, b) => b.warnings.length - a.warnings.length);
  res.json(list);
});

// ─── MC Bans API ──────────────────────────────────────────────────────────────
app.get('/api/mcbans', (req, res) => {
  const { q, limit = 50, page = 1 } = req.query;
  let bans = readJSON(MCBAN_FILE, []);
  if (q) {
    const ql = q.toLowerCase();
    bans = bans.filter(b =>
      b.bannedIgn?.toLowerCase().includes(ql) ||
      b.operator?.toLowerCase().includes(ql) ||
      b.reason?.toLowerCase().includes(ql)
    );
  }
  const total = bans.length;
  const start = (Number(page) - 1) * Number(limit);
  res.json({ bans: bans.slice(start, start + Number(limit)), total });
});

// ─── Tickets API ──────────────────────────────────────────────────────────────
app.get('/api/tickets', (req, res) => {
  const { status, limit = 50, page = 1 } = req.query;
  let tickets = readJSON(TICKET_FILE, []);
  if (status && status !== 'all') tickets = tickets.filter(t => t.status === status);
  const total = tickets.length;
  const start = (Number(page) - 1) * Number(limit);
  res.json({ tickets: tickets.slice(start, start + Number(limit)), total });
});

// ─── Config GET ───────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const defaults = {
    logChannelId: process.env.LOG_CHANNEL_ID || '',
    mcbanChannelId: process.env.MCBAN_LOG_CHANNEL_ID || '',
    ticketCategoryId: process.env.TICKET_CATEGORY_ID || '',
    ticketOptions: [
      { id: 'support',  label: '🛠️ General Support',   description: 'I need help with something' },
      { id: 'report',   label: '🚨 Report a Player',    description: 'Report a rule-breaking player' },
      { id: 'appeal',   label: '⚖️ Ban / Mute Appeal',  description: 'Appeal a punishment' },
      { id: 'purchase', label: '💎 Purchase Issue',     description: 'Problem with a rank/store item' },
    ]
  };
  res.json(readJSON(CONFIG_FILE, defaults));
});

// ─── Config SAVE ─────────────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  try {
    const cfg = req.body;
    // Basic validation
    if (cfg.ticketOptions && !Array.isArray(cfg.ticketOptions)) {
      return res.status(400).json({ error: 'ticketOptions must be an array' });
    }
    writeJSON(CONFIG_FILE, cfg);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Ticket options CRUD ─────────────────────────────────────────────────────
app.post('/api/config/ticket-option', (req, res) => {
  const { label, description } = req.body;
  if (!label) return res.status(400).json({ error: 'label is required' });
  const cfg = readJSON(CONFIG_FILE, { ticketOptions: [] });
  if (!cfg.ticketOptions) cfg.ticketOptions = [];
  const id = label.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 32) + '_' + Date.now();
  cfg.ticketOptions.push({ id, label, description: description || label });
  writeJSON(CONFIG_FILE, cfg);
  res.json({ ok: true, option: { id, label, description } });
});

app.delete('/api/config/ticket-option/:id', (req, res) => {
  const cfg = readJSON(CONFIG_FILE, { ticketOptions: [] });
  if (!cfg.ticketOptions) return res.json({ ok: true });
  cfg.ticketOptions = cfg.ticketOptions.filter(o => o.id !== req.params.id);
  writeJSON(CONFIG_FILE, cfg);
  res.json({ ok: true });
});
const EMBEDS_FILE = path.join(DATA_DIR, 'embeds.json');

// GET saved embeds
app.get('/api/embeds', (req, res) => {
  const embeds = readJSON(EMBEDS_FILE, []);
  res.json(embeds);
});

// POST send + save embed
app.post('/api/embeds/send', async (req, res) => {
  const { title, description, color, footer, image, thumbnail, fields, channelId, savedTitle } = req.body;
  if (!channelId) return res.status(400).json({ ok: false, error: 'No channelId' });

  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder();
  if (title)       embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (color)       embed.setColor(color);
  if (footer)      embed.setFooter({ text: footer });
  if (image)       embed.setImage(image);
  if (thumbnail)   embed.setThumbnail(thumbnail);
  if (fields?.length) embed.addFields(fields);
  embed.setTimestamp();

  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send({ embeds: [embed] });

    // Save it
    const embeds = readJSON(EMBEDS_FILE, []);
    embeds.unshift({
      id: Date.now().toString(),
      savedTitle: savedTitle || title || 'Untitled',
      title, description, color, footer, image, thumbnail, fields,
      channelId,
      sentAt: new Date().toISOString()
    });
    writeJSON(EMBEDS_FILE, embeds);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE saved embed
app.delete('/api/embeds/:id', (req, res) => {
  let embeds = readJSON(EMBEDS_FILE, []);
  embeds = embeds.filter(e => e.id !== req.params.id);
  writeJSON(EMBEDS_FILE, embeds);
  res.json({ ok: true });
});



app.listen(PORT, () => {
  console.log(`✅  Dashboard at http://localhost:${PORT}`);
});

