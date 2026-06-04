// ─────────────────────────────────────────────────────────────────────────────
//  TwilightSMP ModBot v2 — bot/index.js
//  Commands: kick, ban, unban, timeout, untimeout, warn, warnings, clear,
//            slowmode, lock, unlock, userinfo, modstats, mcban, ticket
//  All mod commands require a reason. mcban requires all fields.
// ─────────────────────────────────────────────────────────────────────────────

const {
  Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder,
  SlashCommandBuilder, REST, Routes, Collection,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, OverwriteType
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ─── Validate required env vars ───────────────────────────────────────────────
if (!process.env.BOT_TOKEN) {
  console.error('❌  BOT_TOKEN is missing from .env — bot cannot start.');
  process.exit(1);
}
if (!process.env.GUILD_ID) {
  console.error('❌  GUILD_ID is missing from .env — bot cannot start.');
  process.exit(1);
}

// ─── File paths ───────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, '../dashboard/public');
const LOG_FILE      = path.join(DATA_DIR, 'logs.json');
const WARNS_FILE    = path.join(DATA_DIR, 'warns.json');
const MCBAN_FILE    = path.join(DATA_DIR, 'mcbans.json');
const TICKETS_FILE  = path.join(DATA_DIR, 'tickets.json');
const CONFIG_FILE   = path.join(DATA_DIR, 'config.json');

// ─── JSON helpers ─────────────────────────────────────────────────────────────
function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[readJSON] ${file}:`, e.message);
  }
  return fallback;
}

function writeJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[writeJSON] ${file}:`, e.message);
  }
}

// ─── Config (channel IDs etc, editable from dashboard) ────────────────────────
function getConfig() {
  return readJSON(CONFIG_FILE, {
    logChannelId: process.env.LOG_CHANNEL_ID || '',
    mcbanChannelId: process.env.MCBAN_LOG_CHANNEL_ID || '',
    ticketCategoryId: process.env.TICKET_CATEGORY_ID || '',
    ticketOptions: [
      { id: 'support',   label: '🛠️ General Support',   description: 'I need help with something' },
      { id: 'report',    label: '🚨 Report a Player',    description: 'Report a rule-breaking player' },
      { id: 'appeal',    label: '⚖️ Ban / Mute Appeal',  description: 'Appeal a punishment' },
      { id: 'purchase',  label: '💎 Purchase Issue',     description: 'Problem with a rank/store item' }
    ]
  });
}

// ─── Logging helpers ──────────────────────────────────────────────────────────
function addLog(entry) {
  const logs = readJSON(LOG_FILE, []);
  logs.unshift({ ...entry, id: Date.now().toString(), timestamp: new Date().toISOString() });
  if (logs.length > 1000) logs.splice(1000);
  writeJSON(LOG_FILE, logs);
}

function addMcBan(entry) {
  const bans = readJSON(MCBAN_FILE, []);
  bans.unshift({ ...entry, id: Date.now().toString(), timestamp: new Date().toISOString() });
  writeJSON(MCBAN_FILE, bans);
}

function addWarn(guildId, userId, username, reason, modId, modName) {
  const warns = readJSON(WARNS_FILE, {});
  const key = `${guildId}_${userId}`;
  if (!warns[key]) warns[key] = { userId, username, guildId, warnings: [] };
  warns[key].warnings.push({
    reason, modId, modName,
    timestamp: new Date().toISOString(),
    id: Date.now().toString()
  });
  writeJSON(WARNS_FILE, warns);
  return warns[key].warnings.length;
}

function getWarns(guildId, userId) {
  const warns = readJSON(WARNS_FILE, {});
  return warns[`${guildId}_${userId}`]?.warnings || [];
}

// ─── Ticket store helpers ─────────────────────────────────────────────────────
function getTickets() { return readJSON(TICKETS_FILE, []); }

function saveTicket(ticket) {
  const tickets = getTickets();
  const idx = tickets.findIndex(t => t.id === ticket.id);
  if (idx >= 0) tickets[idx] = ticket;
  else tickets.unshift(ticket);
  writeJSON(TICKETS_FILE, tickets);
}

function getTicketByChannel(channelId) {
  return getTickets().find(t => t.channelId === channelId);
}

// ─── Embed helpers ────────────────────────────────────────────────────────────
const COLORS = {
  red:    0xF87171,
  green:  0x4ADE80,
  yellow: 0xFBBF24,
  purple: 0x8B5CF6,
  blue:   0x60A5FA,
  orange: 0xFB923C,
  pink:   0xE879F9,
};

function modEmbed(action, color, fields) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🔨 ${action}`)
    .addFields(fields)
    .setTimestamp();
}

function errorEmbed(msg) {
  return new EmbedBuilder().setColor(COLORS.red).setDescription(`❌ ${msg}`);
}

function successEmbed(msg) {
  return new EmbedBuilder().setColor(COLORS.green).setDescription(`✅ ${msg}`);
}

// ─── Send to log channel ──────────────────────────────────────────────────────
async function sendToLogChannel(guild, embed, isMcBan = false) {
  const cfg = getConfig();
  const channelId = isMcBan ? cfg.mcbanChannelId : cfg.logChannelId;
  if (!channelId) return;
  try {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
  } catch {}
}

// ─── Slash command definitions ────────────────────────────────────────────────
const commands = [
  // KICK
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from the server')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  // BAN
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .addIntegerOption(o => o.setName('days').setDescription('Delete messages from past N days (0-7)').setMinValue(0).setMaxValue(7).setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  // UNBAN
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user by ID')
    .addStringOption(o => o.setName('userid').setDescription('User ID to unban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  // TIMEOUT
  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout (mute) a member')
    .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes (1–40320)').setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // UNTIMEOUT
  new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Remove a timeout from a member')
    .addUserOption(o => o.setName('user').setDescription('User to un-timeout').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // WARN
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member')
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // WARNINGS
  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('View warnings for a user')
    .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // CLEAR
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete messages in this channel')
    .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to delete (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  // SLOWMODE
  new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Set channel slowmode')
    .addIntegerOption(o => o.setName('seconds').setDescription('Seconds between messages (0 to disable)').setMinValue(0).setMaxValue(21600).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // LOCK
  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Lock a channel (prevents @everyone from sending)')
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to lock (defaults to current)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // UNLOCK
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Unlock a channel')
    .addStringOption(o => o.setName('reason').setDescription('Reason (REQUIRED)').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to unlock (defaults to current)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // USERINFO
  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('View information about a user')
    .addUserOption(o => o.setName('user').setDescription('User to look up').setRequired(false)),

  // MODSTATS
  new SlashCommandBuilder()
    .setName('modstats')
    .setDescription('View moderation statistics for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // MCBAN — all fields required
  new SlashCommandBuilder()
    .setName('mcban')
    .setDescription('Log a Minecraft ban (posts to MC ban channel)')
    .addStringOption(o => o.setName('operator').setDescription('Staff member who issued the ban (REQUIRED)').setRequired(true))
    .addStringOption(o => o.setName('banned_ign').setDescription('Minecraft IGN of banned player (REQUIRED)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the ban (REQUIRED)').setRequired(true))
    .addAttachmentOption(o => o.setName('image').setDescription('Screenshot/evidence (REQUIRED)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // TICKET (open a support ticket)
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open a support ticket')
    .addStringOption(o => o.setName('topic').setDescription('Brief topic (optional)').setRequired(false)),

  // CLOSE TICKET
  new SlashCommandBuilder()
    .setName('closeticket')
    .setDescription('Close this support ticket')
    .addStringOption(o => o.setName('closed_by').setDescription('"Closed by" label (REQUIRED)').setRequired(true))
    .addStringOption(o => o.setName('final_word').setDescription('Final verdict / closing notes (REQUIRED)').setRequired(true)),

    // EMBED
  new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Send a custom embed to a channel')
    .addStringOption(o => o.setName('title').setDescription('Embed title').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Embed description').setRequired(true))
    .addStringOption(o => o.setName('color').setDescription('Color: red, green, yellow, purple, blue, orange, pink').setRequired(false))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to send to (defaults to current)').setRequired(false))
    .addStringOption(o => o.setName('footer').setDescription('Footer text').setRequired(false))
    .addStringOption(o => o.setName('image').setDescription('Image URL').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
];

// ─── Client setup ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
  ]
});

// ─── Register slash commands ──────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('✅  Slash commands registered.');
  } catch (e) {
    console.error('❌  Failed to register commands:', e.message);
  }
});

// ─── Member join/leave logging ────────────────────────────────────────────────
client.on('guildMemberAdd', member => {
  addLog({ action: 'JOIN', guildId: member.guild.id, userId: member.id, username: member.user.tag, modId: null, modName: null, reason: 'Joined server' });
});

client.on('guildMemberRemove', member => {
  addLog({ action: 'LEAVE', guildId: member.guild.id, userId: member.id, username: member.user.tag, modId: null, modName: null, reason: 'Left server' });
});

// ─── Message delete logging ───────────────────────────────────────────────────
client.on('messageDelete', message => {
  if (message.author?.bot) return;
  if (!message.author) return;
  addLog({
    action: 'MSG_DELETE',
    guildId: message.guild?.id,
    userId: message.author.id,
    username: message.author.tag,
    modId: null, modName: null,
    reason: `Deleted: ${message.content?.slice(0, 200) || '[no content]'}`
  });
});

// ─── Interaction handler ──────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {
    // ── Slash commands ──
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }
    // ── Button interactions ──
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }
    // ── Select menu ──
    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
      return;
    }
    // ── Modal submit ──
    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
      return;
    }
  } catch (e) {
    console.error('[interaction error]', e);
    const errMsg = { embeds: [errorEmbed('An unexpected error occurred.')], ephemeral: true };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errMsg);
      } else {
        await interaction.reply(errMsg);
      }
    } catch {}
  }
});

// ─── Slash command handler ─────────────────────────────────────────────────────
async function handleSlashCommand(interaction) {
  const { commandName, guild, member: mod } = interaction;

  // ── KICK ──
  if (commandName === 'kick') {
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason');
    if (!target) return interaction.reply({ embeds: [errorEmbed('User not found in this server.')], ephemeral: true });
    if (!target.kickable) return interaction.reply({ embeds: [errorEmbed('I cannot kick this user (insufficient permissions or higher role).')], ephemeral: true });

    await target.kick(reason);
    const embed = modEmbed('Member Kicked', COLORS.orange, [
      { name: 'User', value: `${target.user.tag} (${target.id})`, inline: true },
      { name: 'Moderator', value: `${mod.user.tag}`, inline: true },
      { name: 'Reason', value: reason },
    ]);
    addLog({ action: 'KICK', guildId: guild.id, userId: target.id, username: target.user.tag, modId: mod.id, modName: mod.user.tag, reason });
    await sendToLogChannel(guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── BAN ──
  if (commandName === 'ban') {
    const user   = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const days   = interaction.options.getInteger('days') ?? 0;
    if (!user) return interaction.reply({ embeds: [errorEmbed('User not found.')], ephemeral: true });

    try {
      await guild.members.ban(user.id, { reason, deleteMessageDays: days });
    } catch {
      return interaction.reply({ embeds: [errorEmbed('Failed to ban user. Check my permissions.')], ephemeral: true });
    }
    const embed = modEmbed('Member Banned', COLORS.red, [
      { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
      { name: 'Moderator', value: mod.user.tag, inline: true },
      { name: 'Reason', value: reason },
      { name: 'Message Deletion', value: `${days} day(s)`, inline: true },
    ]);
    addLog({ action: 'BAN', guildId: guild.id, userId: user.id, username: user.tag, modId: mod.id, modName: mod.user.tag, reason });
    await sendToLogChannel(guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── UNBAN ──
  if (commandName === 'unban') {
    const userId = interaction.options.getString('userid');
    const reason = interaction.options.getString('reason');
    try {
      await guild.members.unban(userId, reason);
    } catch {
      return interaction.reply({ embeds: [errorEmbed('Failed to unban. Is the user actually banned?')], ephemeral: true });
    }
    const embed = modEmbed('Member Unbanned', COLORS.green, [
      { name: 'User ID', value: userId, inline: true },
      { name: 'Moderator', value: mod.user.tag, inline: true },
      { name: 'Reason', value: reason },
    ]);
    addLog({ action: 'UNBAN', guildId: guild.id, userId, username: userId, modId: mod.id, modName: mod.user.tag, reason });
    await sendToLogChannel(guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── TIMEOUT ──
  if (commandName === 'timeout') {
    const target  = interaction.options.getMember('user');
    const minutes = interaction.options.getInteger('minutes');
    const reason  = interaction.options.getString('reason');
    if (!target) return interaction.reply({ embeds: [errorEmbed('User not found.')], ephemeral: true });
    if (!target.moderatable) return interaction.reply({ embeds: [errorEmbed('I cannot timeout this user.')], ephemeral: true });

    await target.timeout(minutes * 60 * 1000, reason);
    const embed = modEmbed('Member Timed Out', COLORS.yellow, [
      { name: 'User', value: `${target.user.tag} (${target.id})`, inline: true },
      { name: 'Moderator', value: mod.user.tag, inline: true },
      { name: 'Duration', value: `${minutes} minute(s)`, inline: true },
      { name: 'Reason', value: reason },
    ]);
    addLog({ action: 'TIMEOUT', guildId: guild.id, userId: target.id, username: target.user.tag, modId: mod.id, modName: mod.user.tag, reason, extra: { minutes } });
    await sendToLogChannel(guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── UNTIMEOUT ──
  if (commandName === 'untimeout') {
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason');
    if (!target) return interaction.reply({ embeds: [errorEmbed('User not found.')], ephemeral: true });

    await target.timeout(null, reason);
    const embed = modEmbed('Timeout Removed', COLORS.green, [
      { name: 'User', value: `${target.user.tag} (${target.id})`, inline: true },
      { name: 'Moderator', value: mod.user.tag, inline: true },
      { name: 'Reason', value: reason },
    ]);
    addLog({ action: 'UNTIMEOUT', guildId: guild.id, userId: target.id, username: target.user.tag, modId: mod.id, modName: mod.user.tag, reason });
    await sendToLogChannel(guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── WARN ──
  if (commandName === 'warn') {
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason');
    if (!target) return interaction.reply({ embeds: [errorEmbed('User not found.')], ephemeral: true });

    const count = addWarn(guild.id, target.id, target.user.tag, reason, mod.id, mod.user.tag);
    const embed = modEmbed('Member Warned', COLORS.yellow, [
      { name: 'User', value: `${target.user.tag} (${target.id})`, inline: true },
      { name: 'Moderator', value: mod.user.tag, inline: true },
      { name: 'Total Warnings', value: `${count}`, inline: true },
      { name: 'Reason', value: reason },
    ]);
    try {
      await target.send({ embeds: [new EmbedBuilder().setColor(COLORS.yellow).setTitle(`⚠️ You've been warned in TwilightSMP`).addFields([{ name: 'Reason', value: reason }, { name: 'Total Warnings', value: `${count}` }]).setTimestamp()] });
    } catch {}
    addLog({ action: 'WARN', guildId: guild.id, userId: target.id, username: target.user.tag, modId: mod.id, modName: mod.user.tag, reason });
    await sendToLogChannel(guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── WARNINGS ──
  if (commandName === 'warnings') {
    const target = interaction.options.getMember('user') || interaction.options.getUser('user');
    if (!target) return interaction.reply({ embeds: [errorEmbed('User not found.')], ephemeral: true });
    const userId  = target.id ?? target.user?.id;
    const userTag = target.user?.tag ?? target.tag ?? userId;
    const warns   = getWarns(guild.id, userId);
    if (warns.length === 0) return interaction.reply({ embeds: [successEmbed(`${userTag} has no warnings.`)] });

    const embed = new EmbedBuilder()
      .setColor(COLORS.yellow)
      .setTitle(`⚠️ Warnings — ${userTag}`)
      .setDescription(warns.map((w, i) => `**${i + 1}.** ${w.reason}\n_by ${w.modName} • <t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:R>_`).join('\n\n'))
      .setFooter({ text: `${warns.length} warning(s) total` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── CLEAR ──
  if (commandName === 'clear') {
    const amount   = interaction.options.getInteger('amount');
    const reason   = interaction.options.getString('reason');
    const filterUser = interaction.options.getUser('user');

    await interaction.deferReply({ ephemeral: true });
    let messages = await interaction.channel.messages.fetch({ limit: 100 });
    if (filterUser) messages = messages.filter(m => m.author.id === filterUser.id);
    const toDelete = [...messages.values()].slice(0, amount);

    const deleted = await interaction.channel.bulkDelete(toDelete, true).catch(() => null);
    const count   = deleted?.size ?? toDelete.length;

    const embed = modEmbed('Messages Cleared', COLORS.blue, [
      { name: 'Channel', value: `<#${interaction.channel.id}>`, inline: true },
      { name: 'Deleted', value: `${count}`, inline: true },
      { name: 'Moderator', value: mod.user.tag, inline: true },
      { name: 'Reason', value: reason },
    ]);
    addLog({ action: 'CLEAR', guildId: guild.id, userId: mod.id, username: mod.user.tag, modId: mod.id, modName: mod.user.tag, reason, extra: { count } });
    await sendToLogChannel(guild, embed);
    return interaction.editReply({ embeds: [successEmbed(`Deleted ${count} message(s).`)] });
  }

  // ── SLOWMODE ──
  if (commandName === 'slowmode') {
    const seconds = interaction.options.getInteger('seconds');
    const reason  = interaction.options.getString('reason');
    await interaction.channel.setRateLimitPerUser(seconds, reason);
    const embed = modEmbed('Slowmode Updated', COLORS.blue, [
      { name: 'Channel', value: `<#${interaction.channel.id}>`, inline: true },
      { name: 'Slowmode', value: seconds === 0 ? 'Disabled' : `${seconds}s`, inline: true },
      { name: 'Moderator', value: mod.user.tag, inline: true },
      { name: 'Reason', value: reason },
    ]);
    addLog({ action: 'SLOWMODE', guildId: guild.id, userId: mod.id, username: mod.user.tag, modId: mod.id, modName: mod.user.tag, reason, extra: { seconds } });
    await sendToLogChannel(guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── LOCK ──
  if (commandName === 'lock') {
    const reason  = interaction.options.getString('reason');
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason });
    const embed = modEmbed('Channel Locked 🔒', COLORS.red, [
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Moderator', value: mod.user.tag, inline: true },
      { name: 'Reason', value: reason },
    ]);
    addLog({ action: 'LOCK', guildId: guild.id, userId: mod.id, username: mod.user.tag, modId: mod.id, modName: mod.user.tag, reason, extra: { channelId: channel.id } });
    await sendToLogChannel(guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── UNLOCK ──
  if (commandName === 'unlock') {
    const reason  = interaction.options.getString('reason');
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }, { reason });
    const embed = modEmbed('Channel Unlocked 🔓', COLORS.green, [
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Moderator', value: mod.user.tag, inline: true },
      { name: 'Reason', value: reason },
    ]);
    addLog({ action: 'UNLOCK', guildId: guild.id, userId: mod.id, username: mod.user.tag, modId: mod.id, modName: mod.user.tag, reason });
    await sendToLogChannel(guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── USERINFO ──
  if (commandName === 'userinfo') {
    const target = interaction.options.getMember('user') ?? interaction.member;
    const user   = target.user;
    const warns  = getWarns(guild.id, user.id);
    const embed  = new EmbedBuilder()
      .setColor(COLORS.purple)
      .setTitle(`👤 ${user.tag}`)
      .setThumbnail(user.displayAvatarURL())
      .addFields([
        { name: 'ID', value: user.id, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Joined Server', value: target.joinedAt ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
        { name: 'Warnings', value: `${warns.length}`, inline: true },
        { name: 'Timed Out', value: target.isCommunicationDisabled() ? '🔇 Yes' : '✅ No', inline: true },
        { name: 'Roles', value: target.roles.cache.filter(r => r.id !== guild.id).map(r => `<@&${r.id}>`).join(' ') || 'None' },
      ])
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── MODSTATS ──
  if (commandName === 'modstats') {
    const logs  = readJSON(LOG_FILE, []).filter(l => l.guildId === guild.id);
    const warns = readJSON(WARNS_FILE, {});
    const counts = {};
    logs.forEach(l => { counts[l.action] = (counts[l.action] || 0) + 1; });
    const modCounts = {};
    logs.forEach(l => {
      if (l.modId) {
        if (!modCounts[l.modId]) modCounts[l.modId] = { name: l.modName, count: 0 };
        modCounts[l.modId].count++;
      }
    });
    const topMods = Object.values(modCounts).sort((a, b) => b.count - a.count).slice(0, 5);
    const embed = new EmbedBuilder()
      .setColor(COLORS.purple)
      .setTitle('📊 Moderation Statistics')
      .addFields([
        { name: '🔨 Bans', value: `${counts['BAN'] || 0}`, inline: true },
        { name: '👢 Kicks', value: `${counts['KICK'] || 0}`, inline: true },
        { name: '🔇 Timeouts', value: `${counts['TIMEOUT'] || 0}`, inline: true },
        { name: '⚠️ Warnings', value: `${counts['WARN'] || 0}`, inline: true },
        { name: '🗑️ Clears', value: `${counts['CLEAR'] || 0}`, inline: true },
        { name: '🎮 MC Bans', value: `${readJSON(MCBAN_FILE, []).filter(b => b.guildId === guild.id).length}`, inline: true },
        { name: '🏆 Top Moderators', value: topMods.length ? topMods.map((m, i) => `${i + 1}. **${m.name}** — ${m.count} actions`).join('\n') : 'No data yet' },
      ])
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── MCBAN ──
  if (commandName === 'mcban') {
    const operator  = interaction.options.getString('operator');
    const bannedIgn = interaction.options.getString('banned_ign');
    const reason    = interaction.options.getString('reason');
    const image     = interaction.options.getAttachment('image');

    const embed = new EmbedBuilder()
      .setColor(COLORS.red)
      .setTitle('🎮 Minecraft Ban Logged')
      .addFields([
        { name: '👮 Operator', value: operator, inline: true },
        { name: '🎮 Banned IGN', value: bannedIgn, inline: true },
        { name: '📋 Reason', value: reason },
        { name: '🖼️ Evidence', value: image.url },
      ])
      .setImage(image.url)
      .setFooter({ text: `Logged by ${mod.user.tag}` })
      .setTimestamp();

    const entry = {
      guildId: guild.id,
      operator,
      bannedIgn,
      reason,
      imageUrl: image.url,
      modId: mod.id,
      modName: mod.user.tag,
    };
    addMcBan(entry);
    addLog({ action: 'MCBAN', guildId: guild.id, userId: mod.id, username: mod.user.tag, modId: mod.id, modName: mod.user.tag, reason, extra: { operator, bannedIgn, imageUrl: image.url } });
    await sendToLogChannel(guild, embed, true);
    return interaction.reply({ embeds: [embed] });
  }

  // ── TICKET (open) ──
  if (commandName === 'ticket') {
    const cfg = getConfig();
    const options = cfg.ticketOptions || [];
    if (!options.length) {
      return interaction.reply({ embeds: [errorEmbed('No ticket categories are set up yet. Ask an admin to configure them in the dashboard.')], ephemeral: true });
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId('ticket_category_select')
      .setPlaceholder('What is your ticket about?')
      .addOptions(options.map(opt =>
        new StringSelectMenuOptionBuilder()
          .setLabel(opt.label)
          .setDescription(opt.description || opt.label)
          .setValue(opt.id)
      ));
    const row = new ActionRowBuilder().addComponents(select);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.purple).setTitle('🎫 Open a Ticket').setDescription('Please select the category that best describes your request.')],
      components: [row],
      ephemeral: true,
    });
  }

  // ── CLOSE TICKET ──
  if (commandName === 'closeticket') {
    const closedBy  = interaction.options.getString('closed_by');
    const finalWord = interaction.options.getString('final_word');
    const ticket    = getTicketByChannel(interaction.channel.id);

    if (!ticket) return interaction.reply({ embeds: [errorEmbed('This channel is not a ticket.')], ephemeral: true });
    if (ticket.status === 'closed') return interaction.reply({ embeds: [errorEmbed('This ticket is already closed.')], ephemeral: true });

    // Update ticket status
    ticket.status = 'closed';
    ticket.closedBy = closedBy;
    ticket.finalWord = finalWord;
    ticket.closedAt = new Date().toISOString();
    ticket.closedModId = mod.id;
    ticket.closedModName = mod.user.tag;
    saveTicket(ticket);

    const closeEmbed = new EmbedBuilder()
      .setColor(COLORS.red)
      .setTitle('🔒 Ticket Closed')
      .addFields([
        { name: '🎫 Ticket', value: `#${ticket.number} — ${ticket.category}`, inline: true },
        { name: '👤 Opened By', value: `<@${ticket.userId}>`, inline: true },
        { name: '🔒 Closed By', value: closedBy, inline: true },
        { name: '📋 Final Word', value: finalWord },
        { name: '⏱️ Opened', value: `<t:${Math.floor(new Date(ticket.createdAt).getTime() / 1000)}:R>`, inline: true },
        { name: '🕐 Closed', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
      ])
      .setTimestamp();

    addLog({ action: 'TICKET_CLOSE', guildId: guild.id, userId: ticket.userId, username: ticket.username, modId: mod.id, modName: mod.user.tag, reason: `${closedBy} — ${finalWord}`, extra: { ticketId: ticket.id, ticketNumber: ticket.number } });
    await sendToLogChannel(guild, closeEmbed);
    await interaction.reply({ embeds: [closeEmbed] });

    // Archive the channel after 5 seconds
    setTimeout(async () => {
      try {
        const ch = await guild.channels.fetch(interaction.channel.id).catch(() => null);
        if (ch) {
          await ch.setName(`closed-${ticket.number}`);
          await ch.permissionOverwrites.edit(ticket.userId, { SendMessages: false, ViewChannel: false });
        }
      } catch {}
    }, 5000);
  }


  // ── EMBED ──
  if (commandName === 'embed') {
    const title       = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const colorKey    = interaction.options.getString('color') ?? 'purple';
    const channel     = interaction.options.getChannel('channel') ?? interaction.channel;
    const footer      = interaction.options.getString('footer');
    const imageUrl    = interaction.options.getString('image');

    const color = COLORS[colorKey] ?? COLORS.purple;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description)
      .setTimestamp();

    if (footer)   embed.setFooter({ text: footer });
    if (imageUrl) embed.setImage(imageUrl);

    try {
      await channel.send({ embeds: [embed] });
      return interaction.reply({ embeds: [successEmbed(`Embed sent to <#${channel.id}>`)], ephemeral: true });
    } catch {
      return interaction.reply({ embeds: [errorEmbed('Failed to send embed. Do I have permission to post in that channel?')], ephemeral: true });
    }
  }
}

// ─── Button handler ────────────────────────────────────────────────────────────
async function handleButton(interaction) {
  const { customId, guild, member: mod } = interaction;

  if (customId === 'ticket_close_btn') {
    // Show modal for close details
    const modal = new ModalBuilder()
      .setCustomId('ticket_close_modal')
      .setTitle('Close Ticket');
    const closedByInput = new TextInputBuilder()
      .setCustomId('closed_by_input')
      .setLabel('Closed By (your name/role)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('e.g. Senior Moderator — xX_Admin_Xx');
    const finalWordInput = new TextInputBuilder()
      .setCustomId('final_word_input')
      .setLabel('Final Word (outcome / verdict)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder('e.g. Issue resolved. Player was warned.');
    modal.addComponents(
      new ActionRowBuilder().addComponents(closedByInput),
      new ActionRowBuilder().addComponents(finalWordInput)
    );
    return interaction.showModal(modal);
  }
}

// ─── Select menu handler ───────────────────────────────────────────────────────
async function handleSelectMenu(interaction) {
  const { customId, values, guild, member: opener } = interaction;

  if (customId === 'ticket_category_select') {
    const cfg = getConfig();
    const categoryId = values[0];
    const catOption  = (cfg.ticketOptions || []).find(o => o.id === categoryId);
    const catLabel   = catOption?.label || categoryId;

    await interaction.deferReply({ ephemeral: true });

    // Find or create the ticket category
    let ticketParent = null;
    if (cfg.ticketCategoryId) {
      ticketParent = await guild.channels.fetch(cfg.ticketCategoryId).catch(() => null);
    }

    // Prevent duplicate open tickets from same user
    const existing = getTickets().find(t => t.userId === opener.id && t.status === 'open' && t.guildId === guild.id);
    if (existing) {
      const existCh = await guild.channels.fetch(existing.channelId).catch(() => null);
      if (existCh) {
        return interaction.editReply({ embeds: [errorEmbed(`You already have an open ticket: <#${existing.channelId}>`)] });
      }
    }

    // Count tickets for numbering
    const allTickets = getTickets().filter(t => t.guildId === guild.id);
    const ticketNumber = allTickets.length + 1;
    const channelName  = `ticket-${ticketNumber}-${opener.user.username.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || 'user'}`;

    // Create channel
    const channelOptions = {
      name: channelName,
      type: ChannelType.GuildText,
      topic: `Ticket #${ticketNumber} | ${catLabel} | ${opener.user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: opener.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      ],
    };
    if (ticketParent) channelOptions.parent = ticketParent.id;

    let ticketChannel;
    try {
      ticketChannel = await guild.channels.create(channelOptions);
    } catch (e) {
      console.error('[ticket create error]', e);
      return interaction.editReply({ embeds: [errorEmbed('Failed to create ticket channel. Check my permissions.')] });
    }

    const ticket = {
      id: Date.now().toString(),
      number: ticketNumber,
      guildId: guild.id,
      channelId: ticketChannel.id,
      userId: opener.id,
      username: opener.user.tag,
      category: catLabel,
      categoryId,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    saveTicket(ticket);

    addLog({ action: 'TICKET_OPEN', guildId: guild.id, userId: opener.id, username: opener.user.tag, modId: null, modName: null, reason: `Ticket #${ticketNumber}: ${catLabel}`, extra: { ticketId: ticket.id } });

    // Send intro message in ticket channel
    const closeBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_close_btn').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger)
    );
    const openEmbed = new EmbedBuilder()
      .setColor(COLORS.purple)
      .setTitle(`🎫 Ticket #${ticketNumber} — ${catLabel}`)
      .setDescription(`Welcome, <@${opener.id}>! A staff member will assist you shortly.\n\nDescribe your issue below and please be as detailed as possible.`)
      .addFields([{ name: 'Category', value: catLabel, inline: true }, { name: 'Opened By', value: opener.user.tag, inline: true }])
      .setFooter({ text: 'Use the Close Ticket button when your issue is resolved.' })
      .setTimestamp();

    await ticketChannel.send({ content: `<@${opener.id}>`, embeds: [openEmbed], components: [closeBtn] });

    // Also ping any mod roles with Manage Guild permission
    try {
      const modRoles = guild.roles.cache.filter(r => r.permissions.has(PermissionFlagsBits.ModerateMembers) && !r.managed).first();
      if (modRoles) await ticketChannel.send({ content: `<@&${modRoles.id}>` });
    } catch {}

    return interaction.editReply({ embeds: [successEmbed(`Your ticket has been created: <#${ticketChannel.id}>`)] });
  }
}

// ─── Modal submit handler ──────────────────────────────────────────────────────
async function handleModalSubmit(interaction) {
  const { customId, guild, member: mod } = interaction;

  if (customId === 'ticket_close_modal') {
    const closedBy  = interaction.fields.getTextInputValue('closed_by_input');
    const finalWord = interaction.fields.getTextInputValue('final_word_input');
    const ticket    = getTicketByChannel(interaction.channel.id);

    if (!ticket) return interaction.reply({ embeds: [errorEmbed('This channel is not a ticket.')], ephemeral: true });
    if (ticket.status === 'closed') return interaction.reply({ embeds: [errorEmbed('Already closed.')], ephemeral: true });

    ticket.status      = 'closed';
    ticket.closedBy    = closedBy;
    ticket.finalWord   = finalWord;
    ticket.closedAt    = new Date().toISOString();
    ticket.closedModId = mod.id;
    ticket.closedModName = mod.user.tag;
    saveTicket(ticket);

    const closeEmbed = new EmbedBuilder()
      .setColor(COLORS.red)
      .setTitle('🔒 Ticket Closed')
      .addFields([
        { name: '🎫 Ticket', value: `#${ticket.number} — ${ticket.category}`, inline: true },
        { name: '👤 Opened By', value: `<@${ticket.userId}>`, inline: true },
        { name: '🔒 Closed By', value: closedBy, inline: true },
        { name: '📋 Final Word', value: finalWord },
        { name: '⏱️ Opened', value: `<t:${Math.floor(new Date(ticket.createdAt).getTime() / 1000)}:R>`, inline: true },
        { name: '🕐 Closed', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
      ])
      .setTimestamp();

    addLog({ action: 'TICKET_CLOSE', guildId: guild.id, userId: ticket.userId, username: ticket.username, modId: mod.id, modName: mod.user.tag, reason: `${closedBy} — ${finalWord}`, extra: { ticketId: ticket.id, ticketNumber: ticket.number } });
    await sendToLogChannel(guild, closeEmbed);
    await interaction.reply({ embeds: [closeEmbed] });

    setTimeout(async () => {
      try {
        const ch = await guild.channels.fetch(interaction.channel.id).catch(() => null);
        if (ch) {
          await ch.setName(`closed-${ticket.number}`);
          await ch.permissionOverwrites.edit(ticket.userId, { SendMessages: false, ViewChannel: false });
        }
      } catch {}
    }, 5000);
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.BOT_TOKEN).catch(e => {
  console.error('❌  Failed to login:', e.message);
  process.exit(1);
});
