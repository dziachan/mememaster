'use strict';
/*
 * MEME-MASTER – Server
 * - Zuschauer reichen Memes ein (TikTok, YouTube Shorts, Instagram Reels)
 * - Streamer gibt frei, spielt ab und bewertet 1–10
 * - Twitch-Chat bewertet 1–10 (wird anonym mitgelesen, kein Bot-Account nötig)
 * - Gesamtwertung = 50 % Streamer + 50 % Chat-Durchschnitt
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEFAULT_CHANNEL = (process.env.TWITCH_CHANNEL || 'dschann_').toLowerCase().replace(/^#/, '');
const DISABLE_TWITCH = process.env.DISABLE_TWITCH === '1';

let ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) {
  ADMIN_KEY = crypto.randomBytes(6).toString('hex');
  console.log('\n[!] Kein ADMIN_KEY gesetzt. Zufälliges Admin-Passwort für diesen Start: ' + ADMIN_KEY + '\n');
}

// ───────────────────────────── Zustand ─────────────────────────────

function freshState() {
  return {
    settings: {
      channel: DEFAULT_CHANNEL,
      streamerName: process.env.STREAMER_NAME || 'Nico',
      voteSeconds: 60,
      anonymous: true,
      submissionsOpen: true,
      volume: 100, // Lautstärke der Videos in der Show (0–100)
      muted: false,
    },
    memes: [],
    phase: 'lobby', // lobby | playing | voting | voted | result | ranking | finale
    currentId: null,
    votes: {},
    voteEndsAt: 0,
    streamerScore: null,
    playStartedAt: 0,
    latestId: null,
    replay: false,
    counter: 0,
  };
}

let state = freshState();

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = sanitizeImported(raw);
    console.log(`[state] ${state.memes.length} Memes aus ${STATE_FILE} geladen`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.log('[state] Konnte Zustand nicht laden: ' + e.message);
  }
}

const PHASES = ['lobby', 'playing', 'voting', 'voted', 'result', 'ranking', 'finale'];
const STATUSES = ['pending', 'approved', 'rejected', 'live', 'played', 'skipped'];
const PLATFORMS = ['youtube', 'tiktok', 'instagram'];

function sanitizeImported(raw) {
  const base = freshState();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.memes)) throw new Error('Ungültiges Backup');
  const s = Object.assign(base, raw);
  s.settings = Object.assign(freshState().settings, raw.settings || {});
  s.settings.channel = cleanChannel(s.settings.channel) || DEFAULT_CHANNEL;
  s.settings.voteSeconds = clampInt(s.settings.voteSeconds, 10, 300, 60);
  s.settings.volume = clampInt(s.settings.volume, 0, 100, 100);
  s.settings.muted = !!s.settings.muted;
  s.settings.streamerName = String(s.settings.streamerName || 'Streamer').slice(0, 20);
  s.memes = raw.memes
    .filter((m) => m && PLATFORMS.includes(m.platform) && isValidVid(m.platform, m.vid) && STATUSES.includes(m.status))
    .map((m) => ({
      id: String(m.id || newId()),
      name: String(m.name || 'unbekannt').slice(0, 25),
      nameLower: String(m.name || 'unbekannt').slice(0, 25).toLowerCase(),
      url: safeHttpUrl(m.url),
      platform: m.platform,
      vid: String(m.vid),
      token: String(m.token || ''),
      status: m.status,
      order: Number(m.order) || 0,
      number: Number(m.number) || 0,
      createdAt: Number(m.createdAt) || Date.now(),
      result: m.result && typeof m.result === 'object' ? normalizeResult(m.result) : null,
    }));
  s.memes.forEach((m) => { if (m.status === 'played' && !m.result) m.status = 'approved'; });
  if (!PHASES.includes(s.phase)) s.phase = 'lobby';
  if (s.currentId && !s.memes.some((m) => m.id === s.currentId)) { s.currentId = null; s.phase = 'lobby'; }
  if (['playing', 'voting', 'voted'].includes(s.phase) && !s.currentId) s.phase = 'lobby';
  if (s.phase === 'playing') s.phase = 'voting'; // ältere Spielstände: Voting läuft jetzt ab dem Start
  s.voteEndsAt = 0;
  if (!s.votes || typeof s.votes !== 'object') s.votes = {};
  return s;
}

function normalizeResult(r) {
  const hist = Array.isArray(r.hist) && r.hist.length === 10 ? r.hist.map((n) => Number(n) || 0) : new Array(10).fill(0);
  return {
    streamer: clampInt(r.streamer, 1, 10, 5),
    chatAvg: r.chatAvg == null ? null : Number(r.chatAvg),
    votes: Number(r.votes) || 0,
    hist,
    total: Number(r.total) || 0,
    playedAt: Number(r.playedAt) || Date.now(),
  };
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.log('[state] Speichern fehlgeschlagen: ' + e.message);
    }
  }, 400);
}

// ───────────────────────────── Design ─────────────────────────────
// Schriften, Hintergrundbild und Logo. Liegt getrennt vom Spielstand, damit große Bilder
// nicht bei jeder Chat-Stimme mitgespeichert werden.

const { FONTS } = require('./public/design.js');
const FONT_NAMES = FONTS.map((f) => f.name);
const DESIGN_FILE = path.join(DATA_DIR, 'design.json');
const DESIGN_SEED = path.join(__dirname, 'design.json'); // optional: dauerhaftes Design aus dem Projektordner
const ASSET_RULES = {
  bg: { types: ['image/png', 'image/jpeg', 'image/webp'], max: 4 * 1024 * 1024, label: 'Das Hintergrundbild' },
  logo: { types: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'], max: 1.5 * 1024 * 1024, label: 'Das Logo' },
  font: { types: ['font/woff2', 'font/woff', 'font/ttf', 'font/otf'], max: 1.5 * 1024 * 1024, label: 'Die Schrift' },
};
const MAX_FONTS = 4;

// camSpace: so viel Prozent der Breite bleiben rechts frei für die Facecam
// accent: Hauptfarbe (Standard Neon-Gelbgrün), accent2: Zweitfarbe (Standard Pink)
const freshDesign = () => ({ fontDisplay: 'Anton', fontBody: 'Space Grotesk', displayScale: 100, bgDim: 60, camSpace: 30, accent: '#d4ff3f', accent2: '#ff4d8d', bg: null, logo: null, fonts: [] });
const hexColor = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : fallback);
let design = freshDesign();
let designSource = 'default'; // default | file (aus dem Projektordner) | saved (in der Regie eingestellt)
const assets = new Map(); // id → { mime, buf }

// Dateityp am Inhalt erkennen, nicht am Namen
function sniff(buf) {
  const s4 = buf.subarray(0, 4).toString('latin1');
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (s4 === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (s4 === 'wOF2') return 'font/woff2';
  if (s4 === 'wOFF') return 'font/woff';
  if (s4 === 'OTTO') return 'font/otf';
  if ((buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0) || s4 === 'true') return 'font/ttf';
  const head = buf.subarray(0, 800).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

function makeAsset(kind, name, base64) {
  const rule = ASSET_RULES[kind];
  if (!rule) throw userErr('Unbekannte Dateiart.');
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw userErr('Die Datei ist leer.');
  if (buf.length > rule.max) throw userErr(`${rule.label} ist zu groß (maximal ${Math.round(rule.max / 1024 / 1024 * 10) / 10} MB).`);
  const mime = sniff(buf);
  if (!rule.types.includes(mime)) {
    throw userErr(kind === 'font' ? 'Bitte eine Schriftdatei wählen (.woff2, .woff, .ttf oder .otf).' : 'Bitte ein Bild wählen (PNG, JPG oder WebP' + (kind === 'logo' ? ', beim Logo auch SVG' : '') + ').');
  }
  const clean = String(name || '').replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9ÄÖÜäöüß _-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return { id: crypto.randomBytes(8).toString('hex'), name: clean || (kind === 'font' ? 'Eigene Schrift' : 'Bild'), mime, buf };
}

const validFont = (v, d) => FONT_NAMES.includes(v) || (d.fonts || []).some((f) => 'custom:' + f.id === v);

function publicDesign() {
  return {
    fontDisplay: design.fontDisplay, fontBody: design.fontBody, displayScale: design.displayScale, bgDim: design.bgDim, camSpace: design.camSpace,
    accent: design.accent, accent2: design.accent2,
    bg: design.bg ? design.bg.id : null, logo: design.logo ? design.logo.id : null,
    fonts: design.fonts.map((f) => ({ id: f.id, name: f.name })),
  };
}

// Vollständiges Design inklusive Dateien (für Export, Speichern und Wiederherstellen)
function exportDesign() {
  const pack = (a) => (a ? { id: a.id, name: a.name, data: assets.get(a.id).buf.toString('base64') } : null);
  return {
    type: 'meme-master-design', fontDisplay: design.fontDisplay, fontBody: design.fontBody,
    displayScale: design.displayScale, bgDim: design.bgDim, camSpace: design.camSpace,
    accent: design.accent, accent2: design.accent2,
    bg: pack(design.bg), logo: pack(design.logo), fonts: design.fonts.map(pack),
  };
}

function importDesign(raw) {
  if (!raw || typeof raw !== 'object' || raw.type !== 'meme-master-design') throw userErr('Das ist keine Meme-Master-Design-Datei.');
  const next = freshDesign();
  const nextAssets = new Map();
  const take = (kind, a) => {
    if (!a || typeof a !== 'object') return null;
    const made = makeAsset(kind, a.name, a.data);
    if (/^[a-f0-9]{10,32}$/.test(String(a.id || ''))) made.id = a.id; // IDs behalten, damit die Schriftauswahl passt
    nextAssets.set(made.id, { mime: made.mime, buf: made.buf });
    return { id: made.id, name: made.name };
  };
  next.bg = take('bg', raw.bg);
  next.logo = take('logo', raw.logo);
  next.fonts = (Array.isArray(raw.fonts) ? raw.fonts : []).slice(0, MAX_FONTS).map((f) => take('font', f)).filter(Boolean);
  next.displayScale = clampInt(raw.displayScale, 50, 140, 100);
  next.bgDim = clampInt(raw.bgDim, 0, 95, 60);
  next.camSpace = clampInt(raw.camSpace, 0, 45, 30);
  next.accent = hexColor(raw.accent, next.accent);
  next.accent2 = hexColor(raw.accent2, next.accent2);
  if (validFont(raw.fontDisplay, next)) next.fontDisplay = raw.fontDisplay;
  if (validFont(raw.fontBody, next)) next.fontBody = raw.fontBody;
  design = next;
  assets.clear();
  for (const [k, v] of nextAssets) assets.set(k, v);
}

let designTimer = null;
function saveDesignSoon() {
  designSource = 'saved';
  clearTimeout(designTimer);
  designTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DESIGN_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(exportDesign()));
      fs.renameSync(tmp, DESIGN_FILE);
    } catch (e) { console.log('[design] Speichern fehlgeschlagen: ' + e.message); }
  }, 500);
}

function loadDesign() {
  for (const [file, source] of [[DESIGN_FILE, 'saved'], [DESIGN_SEED, 'file']]) {
    try {
      importDesign(JSON.parse(fs.readFileSync(file, 'utf8')));
      designSource = source;
      console.log('[design] geladen aus ' + file);
      return;
    } catch (e) {
      if (e.code !== 'ENOENT') console.log(`[design] ${file} konnte nicht gelesen werden: ${e.message}`);
    }
  }
}

function dropAsset(a) { if (a) assets.delete(a.id); }

// ───────────────────────────── Helfer ─────────────────────────────

const newId = () => crypto.randomBytes(5).toString('hex');
const round2 = (n) => Math.round(n * 100) / 100;
function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function cleanChannel(c) {
  const s = String(c || '').trim().toLowerCase().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//, '');
  return /^[a-z0-9_]{3,25}$/.test(s) ? s : '';
}
function safeHttpUrl(u) {
  try {
    const p = new URL(String(u));
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : '';
  } catch { return ''; }
}
function isValidVid(platform, vid) {
  const v = String(vid || '');
  if (platform === 'youtube') return /^[\w-]{11}$/.test(v);
  if (platform === 'tiktok') return /^\d{8,25}$/.test(v);
  if (platform === 'instagram') return /^[A-Za-z0-9_-]{5,40}$/.test(v);
  return false;
}
function userErr(msg, code = 400) { const e = new Error(msg); e.user = true; e.code = code; return e; }
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function embedUrl(m) {
  if (m.platform === 'youtube') return `https://www.youtube.com/embed/${m.vid}?autoplay=1&rel=0&playsinline=1&enablejsapi=1`;
  if (m.platform === 'tiktok') return `https://www.tiktok.com/player/v1/${m.vid}?autoplay=1&loop=1&rel=0&music_info=0&description=0`;
  return `https://www.instagram.com/reel/${m.vid}/embed/`;
}

// ───────────────────────── Link-Erkennung ─────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const isTikTokHost = (h) => h === 'tiktok.com' || h.endsWith('.tiktok.com');

// Kurzlinks (vm.tiktok.com/…, tiktok.com/t/…) auflösen. Folgt nur Weiterleitungen innerhalb von tiktok.com.
async function resolveTikTok(start) {
  let cur = start;
  for (let i = 0; i < 5; i++) {
    if (cur.protocol !== 'https:' || !isTikTokHost(cur.hostname.toLowerCase())) return null;
    if (/\/video\/\d{8,25}/.test(cur.pathname)) return cur;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(cur, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': UA } });
      const loc = r.headers.get('location');
      if (!loc) return null;
      cur = new URL(loc, cur);
    } catch { return null; } finally { clearTimeout(t); }
  }
  return isTikTokHost(cur.hostname.toLowerCase()) && /\/video\/\d{8,25}/.test(cur.pathname) ? cur : null;
}

async function parseMemeUrl(raw) {
  let u;
  let text = String(raw || '').trim();
  if (text && !/^https?:\/\//i.test(text)) text = 'https://' + text;
  try { u = new URL(text); } catch { throw userErr('Das ist kein gültiger Link.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw userErr('Das ist kein gültiger Link.');
  u.protocol = 'https:';
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');

  if (host === 'youtube.com') {
    const m = u.pathname.match(/^\/shorts\/([\w-]{11})(?:[/?]|$)/);
    if (!m) throw userErr('Bei YouTube sind nur Shorts erlaubt (youtube.com/shorts/…).');
    return { platform: 'youtube', vid: m[1], url: `https://www.youtube.com/shorts/${m[1]}` };
  }
  if (host === 'youtu.be') throw userErr('Bitte den Shorts-Link nutzen (youtube.com/shorts/…).');

  if (isTikTokHost(host)) {
    if (/\/photo\//.test(u.pathname)) throw userErr('TikTok-Fotos gehen nicht – nur Videos.');
    let m = u.pathname.match(/\/video\/(\d{8,25})/);
    if (!m) {
      const final = await resolveTikTok(u);
      m = final && final.pathname.match(/\/video\/(\d{8,25})/);
    }
    if (!m) throw userErr('TikTok-Link nicht erkannt. Nimm den vollen Link (tiktok.com/@name/video/…).');
    return { platform: 'tiktok', vid: m[1], url: /\/video\/\d/.test(u.pathname) ? u.origin + u.pathname : u.href };
  }

  if (host === 'instagram.com') {
    if (u.pathname.startsWith('/share/')) throw userErr('Bitte den direkten Reel-Link nutzen (instagram.com/reel/…), nicht den Teilen-Link.');
    const m = u.pathname.match(/\/(?:reel|reels)\/([A-Za-z0-9_-]{5,40})(?:\/|$)/);
    if (!m || m[1] === 'audio') throw userErr('Bei Instagram sind nur Reels erlaubt (instagram.com/reel/…).');
    return { platform: 'instagram', vid: m[1], url: `https://www.instagram.com/reel/${m[1]}/` };
  }

  throw userErr('Erlaubt sind nur TikTok, YouTube Shorts und Instagram Reels.');
}

// ───────────────────────── Auswertung ─────────────────────────

const current = () => state.memes.find((m) => m.id === state.currentId) || null;
const queue = () => state.memes.filter((m) => m.status === 'approved').sort((a, b) => a.order - b.order);

function voteStats() {
  const hist = new Array(10).fill(0);
  let sum = 0;
  let count = 0;
  for (const v of Object.values(state.votes)) { hist[v - 1]++; sum += v; count++; }
  return { hist, count, avg: count ? sum / count : 0 };
}

function ranking() {
  return state.memes
    .filter((m) => m.status === 'played' && m.result)
    .sort((a, b) =>
      b.result.total - a.result.total ||
      (b.result.chatAvg ?? 0) - (a.result.chatAvg ?? 0) ||
      b.result.votes - a.result.votes ||
      a.result.playedAt - b.result.playedAt)
    .map((m, i) => ({
      rank: i + 1, id: m.id, name: m.name, platform: m.platform,
      total: m.result.total, streamer: m.result.streamer, chatAvg: m.result.chatAvg, votes: m.result.votes,
    }));
}

function publicState() {
  const cur = current();
  const hideName = state.settings.anonymous && ['playing', 'voting', 'voted'].includes(state.phase) && !state.replay;
  const s = voteStats();
  const count = (st) => state.memes.filter((m) => m.status === st).length;
  return {
    now: Date.now(),
    phase: state.phase,
    replay: state.replay,
    settings: state.settings,
    counts: {
      pending: count('pending'), queued: count('approved'), played: count('played'),
      submitted: state.memes.filter((m) => m.status !== 'rejected').length,
    },
    current: cur ? {
      id: cur.id, number: cur.number, platform: cur.platform, embed: embedUrl(cur),
      name: hideName ? null : cur.name, result: cur.result || null,
    } : null,
    playStartedAt: state.playStartedAt,
    voteEndsAt: state.voteEndsAt,
    votes: ['voting', 'voted'].includes(state.phase) ? { count: s.count, avg: round2(s.avg), hist: s.hist } : null,
    streamerRated: state.streamerScore != null,
    ranking: ranking(),
    latestId: state.latestId,
    design: publicDesign(),
  };
}

function adminState() {
  return Object.assign(publicState(), {
    streamerScore: state.streamerScore,
    currentName: current() ? current().name : null,
    twitch: { connected: tw.connected, channel: state.settings.channel, disabled: DISABLE_TWITCH },
    designSource,
    designFiles: { bg: design.bg ? design.bg.name : null, logo: design.logo ? design.logo.name : null },
    memes: state.memes.map(({ token, nameLower, ...m }) => Object.assign(m, { embed: embedUrl(m) })),
  });
}

// ───────────────────────── Live-Verteilung ─────────────────────────

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let castTimer = null;
function broadcast() {
  if (castTimer) return;
  castTimer = setTimeout(() => {
    castTimer = null;
    const pub = JSON.stringify({ type: 'state', state: publicState() });
    let adm = null;
    for (const c of wss.clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      if (c.isAdmin) c.send(adm || (adm = JSON.stringify({ type: 'state', state: adminState() })));
      else c.send(pub);
    }
  }, 120);
}
function changed() { saveSoon(); broadcast(); }

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  ws.isAdmin = q.get('role') === 'admin' && safeEqual(q.get('key') || '', ADMIN_KEY);
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', () => { ws.alive = true; }); // Keepalive der Clients
  ws.on('error', () => {});
  ws.send(JSON.stringify({ type: 'state', state: ws.isAdmin ? adminState() : publicState() }));
});
setInterval(() => {
  for (const c of wss.clients) {
    if (!c.alive) { c.terminate(); continue; }
    c.alive = false;
    try { c.ping(); } catch {}
  }
}, 30000).unref();

// ───────────────────────── Twitch-Chat ─────────────────────────

const tw = { ws: null, connected: false, timer: null, lastData: 0 };

function connectTwitch() {
  if (DISABLE_TWITCH) return;
  clearTimeout(tw.timer);
  if (tw.ws) { try { tw.ws.removeAllListeners(); tw.ws.on('error', () => {}); tw.ws.close(); } catch {} }
  tw.connected = false;
  const channel = state.settings.channel;
  if (!channel) return;
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  tw.ws = ws;
  tw.lastData = Date.now();
  ws.on('open', () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('PASS SCHMOOPIIE');
    ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 80000));
    ws.send('JOIN #' + channel);
  });
  ws.on('message', (data) => {
    tw.lastData = Date.now();
    for (const line of data.toString('utf8').split('\r\n')) if (line) handleIrcLine(ws, line);
  });
  const retry = () => {
    if (tw.ws !== ws) return;
    if (tw.connected) { tw.connected = false; broadcast(); }
    clearTimeout(tw.timer);
    tw.timer = setTimeout(connectTwitch, 5000);
  };
  ws.on('close', retry);
  ws.on('error', () => {});
}

const IRC_PRIVMSG = /^(?:@(\S+) )?:([a-z0-9_]+)!\S+ PRIVMSG #[a-z0-9_]+ :(.*)$/;
function handleIrcLine(ws, line) {
  if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); return; }
  if (/^:\S+ RECONNECT/.test(line)) { try { ws.close(); } catch {} return; }
  if (/^:\S+ (366|ROOMSTATE) /.test(line) || /^@\S+ :\S+ ROOMSTATE /.test(line)) {
    if (!tw.connected) { tw.connected = true; console.log('[twitch] verbunden mit #' + state.settings.channel); broadcast(); }
    return;
  }
  const m = line.match(IRC_PRIVMSG);
  if (m) handleChat(m[2], m[3]);
}

// Chat-Nachricht → Stimme. Gezählt wird nur eine reine Zahl 1–10 (auch "7/10"). Letzte Stimme pro User zählt.
function handleChat(user, text) {
  if (state.phase !== 'voting' || (state.voteEndsAt && Date.now() > state.voteEndsAt)) return false;
  const clean = String(text).replace(/[\u{E0000}-\u{E007F}​-‍﻿]/gu, '').trim();
  const m = clean.match(/^(10|[1-9])(?:\s*\/\s*10)?$/);
  if (!m) return false;
  const cur = current();
  if (!cur) return false;
  user = String(user).toLowerCase();
  if (user === cur.nameLower || user === state.settings.channel) return false; // keine Eigenwertung
  state.votes[user] = Number(m[1]);
  changed();
  return true;
}

setInterval(() => {
  if (DISABLE_TWITCH || !tw.ws) return;
  if (Date.now() - tw.lastData > 7 * 60 * 1000) connectTwitch(); // Twitch pingt alle ~5 Min
}, 60000).unref();

// ───────────────────────── Voting-Timer ─────────────────────────

let voteTimer = null;
function armVoteTimer() {
  clearTimeout(voteTimer);
  if (state.phase !== 'voting' || !state.voteEndsAt) return; // ohne Endzeit läuft das Voting bis zur Auflösung
  voteTimer = setTimeout(() => {
    if (state.phase === 'voting') { state.phase = 'voted'; changed(); }
  }, Math.max(0, state.voteEndsAt - Date.now()));
}

// ───────────────────────── HTTP ─────────────────────────

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
const jsonSmall = express.json({ limit: '20kb' });
const jsonBig = express.json({ limit: '8mb' });

const pub = path.join(__dirname, 'public');
app.get('/', (req, res) => res.sendFile(path.join(pub, 'submit.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.get('/show', (req, res) => res.sendFile(path.join(pub, 'show.html')));
app.use(express.static(pub, { index: false }));

app.get('/api/ping', (req, res) => res.json({ ok: true }));
app.get('/api/state', (req, res) => res.json(publicState()));

// Einfaches Limit: max. 8 Einsende-Versuche pro Minute und IP
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 8;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k); }, 120000).unref();

async function addMeme({ name, url, token, byAdmin }) {
  name = String(name || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{3,25}$/.test(name)) throw userErr('Bitte deinen Twitch-Namen angeben (3–25 Zeichen: Buchstaben, Zahlen, _).');
  const lower = name.toLowerCase();
  const parsed = await parseMemeUrl(url);
  const active = state.memes.filter((m) => m.status !== 'rejected');
  if (active.some((m) => m.nameLower === lower || (!byAdmin && token && m.token === token))) {
    throw userErr(byAdmin ? 'Von diesem Namen gibt es schon ein Meme.' : 'Du hast schon ein Meme eingereicht – pro Person nur eins.', 409);
  }
  if (active.some((m) => m.platform === parsed.platform && m.vid === parsed.vid)) {
    throw userErr('Dieses Meme wurde schon eingereicht. Such dir ein anderes aus!', 409);
  }
  if (active.length >= 500) throw userErr('Die Liste ist voll.', 409);
  const meme = {
    id: newId(), name, nameLower: lower, url: parsed.url, platform: parsed.platform, vid: parsed.vid,
    token: byAdmin ? '' : token, status: byAdmin ? 'approved' : 'pending',
    order: nextOrder(), number: 0, createdAt: Date.now(), result: null,
  };
  state.memes.push(meme);
  changed();
  return meme;
}
const nextOrder = () => state.memes.reduce((mx, m) => Math.max(mx, m.order), 0) + 1;

app.post('/api/submit', jsonSmall, async (req, res) => {
  try {
    if (limited(req.ip)) throw userErr('Zu viele Versuche. Warte kurz.', 429);
    if (!state.settings.submissionsOpen) throw userErr('Die Einsendungen sind gerade geschlossen.', 403);
    const token = String((req.body && req.body.token) || '');
    if (!/^[a-f0-9]{16,64}$/.test(token)) throw userErr('Ungültige Anfrage. Lade die Seite neu.');
    const meme = await addMeme({ name: req.body.name, url: req.body.url, token });
    res.json({ ok: true, status: meme.status, name: meme.name, platform: meme.platform });
  } catch (e) {
    if (!e.user) console.log('[submit] ' + e.stack);
    res.status(e.user ? e.code : 500).json({ ok: false, error: e.user ? e.message : 'Serverfehler. Versuch es nochmal.' });
  }
});

app.get('/api/my', (req, res) => {
  const token = String(req.query.token || '');
  const open = state.settings.submissionsOpen;
  if (!/^[a-f0-9]{16,64}$/.test(token)) return res.json({ open, meme: null });
  const mine = state.memes.filter((m) => m.token === token);
  const m = mine.find((x) => x.status !== 'rejected') || mine[mine.length - 1] || null;
  if (!m) return res.json({ open, meme: null });
  const r = ranking();
  const pos = r.find((x) => x.id === m.id);
  res.json({
    open,
    meme: {
      status: m.status, name: m.name, platform: m.platform,
      total: m.result ? m.result.total : null, rank: pos ? pos.rank : null, of: r.length,
    },
  });
});

function requireAdmin(req, res, next) {
  if (!safeEqual(req.get('x-admin-key') || '', ADMIN_KEY)) return res.status(401).json({ ok: false, error: 'Falsches Admin-Passwort.' });
  next();
}

app.get('/api/admin/state', requireAdmin, (req, res) => res.json(adminState()));
app.get('/api/admin/export', requireAdmin, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="meme-master-backup.json"');
  res.json(state);
});
app.post('/api/admin/import', requireAdmin, jsonBig, (req, res) => {
  try {
    state = sanitizeImported(req.body);
    armVoteTimer();
    connectTwitch();
    changed();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Backup konnte nicht gelesen werden.' });
  }
});

// Hochgeladene Bilder und Schriften ausliefern. Die ID ändert sich bei jedem Upload, deshalb lange cachebar.
app.get('/api/asset/:id', (req, res) => {
  const a = assets.get(req.params.id);
  if (!a) return res.status(404).end();
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.end(a.buf);
});

app.post('/api/admin/asset', requireAdmin, jsonBig, (req, res) => {
  try {
    const { kind, name, data } = req.body || {};
    if (kind === 'font' && design.fonts.length >= MAX_FONTS) throw userErr(`Maximal ${MAX_FONTS} eigene Schriften. Lösch erst eine.`);
    const a = makeAsset(kind, name, data);
    assets.set(a.id, { mime: a.mime, buf: a.buf });
    const ref = { id: a.id, name: a.name };
    if (kind === 'font') design.fonts.push(ref);
    else { dropAsset(design[kind]); design[kind] = ref; }
    saveDesignSoon();
    broadcast();
    res.json({ ok: true, id: a.id, name: a.name });
  } catch (e) {
    if (!e.user) console.log('[asset] ' + e.stack);
    res.status(e.user ? e.code : 500).json({ ok: false, error: e.user ? e.message : 'Hochladen fehlgeschlagen.' });
  }
});

app.get('/api/admin/design/export', requireAdmin, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="design.json"');
  res.json(exportDesign());
});
app.post('/api/admin/design/import', requireAdmin, express.json({ limit: '24mb' }), (req, res) => {
  try {
    importDesign(req.body);
    saveDesignSoon();
    broadcast();
    res.json({ ok: true });
  } catch (e) {
    if (!e.user) console.log('[design] ' + e.stack);
    res.status(400).json({ ok: false, error: e.user ? e.message : 'Design-Datei konnte nicht gelesen werden.' });
  }
});

app.post('/api/admin/action', requireAdmin, jsonSmall, async (req, res) => {
  try {
    await doAction(req.body || {});
    changed();
    res.json({ ok: true });
  } catch (e) {
    if (!e.user) console.log('[admin] ' + e.stack);
    res.status(e.user ? e.code : 500).json({ ok: false, error: e.user ? e.message : 'Serverfehler.' });
  }
});

const BUSY = ['playing', 'voting', 'voted'];

async function doAction(a) {
  const find = () => {
    const m = state.memes.find((x) => x.id === a.id);
    if (!m) throw userErr('Meme nicht gefunden.', 404);
    return m;
  };
  switch (a.type) {
    case 'approve': {
      const m = find();
      if (!['pending', 'rejected', 'skipped'].includes(m.status)) throw userErr('Geht in diesem Status nicht.');
      m.status = 'approved'; m.order = nextOrder();
      return;
    }
    case 'reject': {
      const m = find();
      if (!['pending', 'approved', 'skipped'].includes(m.status)) throw userErr('Geht in diesem Status nicht.');
      m.status = 'rejected';
      return;
    }
    case 'remove': {
      const m = find();
      if (m.id === state.currentId && BUSY.includes(state.phase)) throw userErr('Das Meme läuft gerade.');
      state.memes = state.memes.filter((x) => x.id !== m.id);
      if (state.currentId === m.id) { state.currentId = null; if (state.phase !== 'finale') state.phase = 'lobby'; state.replay = false; }
      if (state.latestId === m.id) state.latestId = null;
      return;
    }
    case 'move': {
      const m = find();
      const q = queue();
      const i = q.findIndex((x) => x.id === m.id);
      if (i < 0) throw userErr('Nicht in der Warteschlange.');
      if (a.dir === 'top') { m.order = q[0].order - 1; return; }
      const j = a.dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= q.length) return;
      const t = q[j].order; q[j].order = m.order; m.order = t;
      return;
    }
    case 'shuffle': {
      const q = queue();
      const orders = q.map((m) => m.order);
      for (let i = q.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [q[i], q[j]] = [q[j], q[i]]; }
      q.forEach((m, i) => { m.order = orders[i]; });
      return;
    }
    case 'add':
      await addMeme({ name: a.name, url: a.url, byAdmin: true });
      return;
    case 'play': {
      if (BUSY.includes(state.phase)) throw userErr('Erst das laufende Meme auflösen oder überspringen.');
      const q = queue();
      const m = a.id ? q.find((x) => x.id === a.id) : q[0];
      if (!m) throw userErr('Keine freigegebenen Memes in der Warteschlange.');
      m.status = 'live'; m.number = ++state.counter;
      // Der Chat kann sofort abstimmen – solange, bis aufgelöst wird
      Object.assign(state, { phase: 'voting', currentId: m.id, votes: {}, voteEndsAt: 0, streamerScore: null, playStartedAt: Date.now(), replay: false });
      armVoteTimer();
      return;
    }
    case 'voteStart': {
      if (!['playing', 'voted'].includes(state.phase)) throw userErr('Voting kann jetzt nicht geöffnet werden.');
      state.phase = 'voting';
      state.voteEndsAt = 0; // offen bis zur Auflösung
      armVoteTimer();
      return;
    }
    case 'voteStop': {
      if (state.phase !== 'voting') throw userErr('Es läuft kein Voting.');
      state.phase = 'voted'; state.voteEndsAt = Date.now(); armVoteTimer();
      return;
    }
    case 'rate': {
      if (!BUSY.includes(state.phase)) throw userErr('Gerade läuft kein Meme.');
      const n = Number(a.score);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw userErr('Wertung muss 1–10 sein.');
      state.streamerScore = n;
      return;
    }
    case 'reveal': {
      if (!BUSY.includes(state.phase)) throw userErr('Gerade läuft kein Meme.');
      if (state.streamerScore == null) throw userErr('Erst deine eigene Wertung (1–10) abgeben.');
      const cur = current();
      const s = voteStats();
      cur.result = {
        streamer: state.streamerScore,
        chatAvg: s.count ? round2(s.avg) : null,
        votes: s.count,
        hist: s.hist,
        total: round2(s.count ? (state.streamerScore + s.avg) / 2 : state.streamerScore),
        playedAt: Date.now(),
      };
      cur.status = 'played';
      Object.assign(state, { phase: 'result', latestId: cur.id, votes: {}, voteEndsAt: 0 });
      armVoteTimer();
      return;
    }
    case 'skip': {
      if (!BUSY.includes(state.phase)) throw userErr('Gerade läuft kein Meme.');
      const cur = current();
      if (cur) { cur.status = a.requeue ? 'approved' : 'skipped'; cur.number = 0; if (a.requeue) cur.order = nextOrder(); }
      state.counter = Math.max(0, state.counter - 1);
      Object.assign(state, { phase: 'lobby', currentId: null, votes: {}, voteEndsAt: 0, streamerScore: null });
      armVoteTimer();
      return;
    }
    case 'ranking': {
      if (BUSY.includes(state.phase)) throw userErr('Erst das laufende Meme auflösen.');
      if (!ranking().length) throw userErr('Es gibt noch keine Wertungen.');
      state.phase = 'ranking'; state.replay = false;
      return;
    }
    case 'lobby': {
      if (BUSY.includes(state.phase)) throw userErr('Erst das laufende Meme auflösen oder überspringen.');
      Object.assign(state, { phase: 'lobby', currentId: null, replay: false });
      return;
    }
    case 'finale': {
      if (BUSY.includes(state.phase)) throw userErr('Erst das laufende Meme auflösen.');
      if (!ranking().length) throw userErr('Es gibt noch keine Wertungen.');
      Object.assign(state, { phase: 'finale', currentId: null, replay: false });
      return;
    }
    case 'replay': {
      if (state.phase !== 'finale') throw userErr('Nur im Finale möglich.');
      const r = ranking();
      if (a.on === false) { state.replay = false; state.currentId = null; return; }
      Object.assign(state, { replay: true, currentId: r[0].id, playStartedAt: Date.now() });
      return;
    }
    case 'settings': {
      const s = state.settings;
      if (a.voteSeconds != null) s.voteSeconds = clampInt(a.voteSeconds, 10, 300, 60);
      if (a.anonymous != null) s.anonymous = !!a.anonymous;
      if (a.submissionsOpen != null) s.submissionsOpen = !!a.submissionsOpen;
      if (a.volume != null) s.volume = clampInt(a.volume, 0, 100, 100);
      if (a.muted != null) s.muted = !!a.muted;
      if (a.streamerName != null) s.streamerName = String(a.streamerName).trim().slice(0, 20) || 'Streamer';
      if (a.channel != null) {
        const c = cleanChannel(a.channel);
        if (!c) throw userErr('Ungültiger Twitch-Kanalname.');
        if (c !== s.channel) { s.channel = c; connectTwitch(); }
      }
      return;
    }
    case 'design': {
      if (a.fontDisplay != null) { if (!validFont(a.fontDisplay, design)) throw userErr('Unbekannte Schrift.'); design.fontDisplay = a.fontDisplay; }
      if (a.fontBody != null) { if (!validFont(a.fontBody, design)) throw userErr('Unbekannte Schrift.'); design.fontBody = a.fontBody; }
      if (a.displayScale != null) design.displayScale = clampInt(a.displayScale, 50, 140, 100);
      if (a.bgDim != null) design.bgDim = clampInt(a.bgDim, 0, 95, 60);
      if (a.camSpace != null) design.camSpace = clampInt(a.camSpace, 0, 45, 30);
      if (a.accent != null) { if (!hexColor(a.accent, null)) throw userErr('Ungültige Farbe.'); design.accent = hexColor(a.accent); }
      if (a.accent2 != null) { if (!hexColor(a.accent2, null)) throw userErr('Ungültige Farbe.'); design.accent2 = hexColor(a.accent2); }
      saveDesignSoon();
      return;
    }
    case 'assetRemove': {
      if (a.kind === 'bg' || a.kind === 'logo') { dropAsset(design[a.kind]); design[a.kind] = null; }
      else if (a.kind === 'font') {
        const f = design.fonts.find((x) => x.id === a.id);
        if (!f) throw userErr('Schrift nicht gefunden.', 404);
        design.fonts = design.fonts.filter((x) => x !== f);
        dropAsset(f);
        if (design.fontDisplay === 'custom:' + f.id) design.fontDisplay = 'Anton';
        if (design.fontBody === 'custom:' + f.id) design.fontBody = 'Space Grotesk';
      } else throw userErr('Unbekannte Dateiart.');
      saveDesignSoon();
      return;
    }
    case 'designReset': {
      design = freshDesign();
      assets.clear();
      designSource = 'default';
      clearTimeout(designTimer);
      try { fs.unlinkSync(DESIGN_FILE); } catch {}
      return;
    }
    case 'testvotes': {
      if (state.phase !== 'voting') throw userErr('Testvotes gehen nur während eines laufenden Votings.');
      const n = clampInt(a.count, 1, 500, 25);
      const center = 3 + Math.random() * 6;
      for (let i = 0; i < n; i++) {
        const v = Math.round(center + (Math.random() + Math.random() + Math.random() - 1.5) * 3.2);
        handleChat('test_' + crypto.randomBytes(3).toString('hex'), String(Math.min(10, Math.max(1, v))));
      }
      return;
    }
    case 'reset': {
      clearTimeout(voteTimer);
      if (a.what === 'all') {
        const settings = state.settings;
        state = freshState();
        state.settings = settings;
      } else if (a.what === 'results') {
        state.memes.forEach((m) => {
          if (['played', 'live', 'skipped'].includes(m.status)) { m.status = 'approved'; m.result = null; m.number = 0; }
        });
        Object.assign(state, { phase: 'lobby', currentId: null, votes: {}, voteEndsAt: 0, streamerScore: null, latestId: null, replay: false, counter: 0 });
      } else throw userErr('Unbekannter Reset.');
      return;
    }
    default:
      throw userErr('Unbekannte Aktion.');
  }
}

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ ok: false, error: 'Anfrage konnte nicht verarbeitet werden.' });
});

// ───────────────────────── Start ─────────────────────────

if (require.main === module) {
  loadState();
  loadDesign();
  armVoteTimer();
  server.listen(PORT, () => {
    console.log(`Meme-Master läuft auf Port ${PORT}`);
    console.log(`  Einsenden:  /`);
    console.log(`  Show:       /show`);
    console.log(`  Admin:      /admin`);
    connectTwitch();
  });
}

module.exports = { parseMemeUrl, handleIrcLine, handleChat, _state: () => state };
