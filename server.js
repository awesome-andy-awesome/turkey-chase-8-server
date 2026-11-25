// =====================================================================
// Turkey Chase X — the multiplayer server (Turkey Chase 9 games can still join it). There's just ONE: everybody who presses 🌐 Play Server
// (website, Windows, Mac or Android) ends up here, in the same world, playing together.
//
// The server owns the turkeys, so when a good one spawns it goes to whoever catches it FIRST.
// It also runs the weather and passes chat around (with spam limits).
// Progress isn't kept here: each player's coins live in their own game. To keep your server progress, the game asks
// the server for a SERVER SAVE CODE (see 'server save codes' below), which only this server can read or make.
//
// Run it:  npm install   then   npm start        (it listens on PORT, or 8080)
// =====================================================================
const http = require('http');
const { WebSocketServer } = require('ws');
const { webcrypto } = require('crypto');
const nodeCrypto = require('crypto'), zlib = require('zlib');

// Admin actions (spawn a turkey, change the weather) are signed by the Admin app with this key's secret half;
// the server checks the signature with the public half below, so only the real Admin app can run them.
const ADMIN_PUB = { kty: 'EC', x: '297HgUw_DSd4bTl1mS2WUM5LoN8JuJLuQ5bkO8kOa6U', y: 'N3UI8PVT_54UhqE1EVARvTxNTvxLj3prxlNOGU4FFEs', crv: 'P-256' };
let adminPubKey = null; const adminSeen = new Set();
function b64uDec(s) { s = String(s || '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64'); }
async function verifyAdmin(payload, sig) {
  try { if (!sig) return false; if (!adminPubKey) adminPubKey = await webcrypto.subtle.importKey('jwk', ADMIN_PUB, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, adminPubKey, b64uDec(sig), Buffer.from(payload, 'utf8')); } catch (e) { return false; }
}

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 40;
const TICK = 50;                 // 20 updates a second
const SEND_EVERY = 3;            // positions go out ~7 times a second

// ---------- the turkeys (same 40 kinds, values and rarity as the game) ----------
const SPECIES = require('./species.json'); // [name, value, weight]
const TOTAL_W = SPECIES.reduce((s, x) => s + x[2], 0);
function rollSpecies() { let r = Math.random() * TOTAL_W; for (let i = 0; i < SPECIES.length; i++) { r -= SPECIES[i][2]; if (r <= 0) return i; } return 0; }
// luck, the same way the game does it: rarer turkeys get a bigger boost (used for "the farther out, the rarer")
const LUCK_TOP = Math.max(...SPECIES.map(x => Math.log2(Math.max(1, x[1] / 10))));
function rollSpeciesLuck(L) {
  if (!(L > 0)) return rollSpecies();
  const w = SPECIES.map(x => x[2] * Math.pow(1 + 0.04 * L, Math.log2(Math.max(1, x[1] / 10)) - LUCK_TOP)), tot = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * tot; for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; } return 0;
}

// the map, in game pixels (1 stud = 6.25 pixels)
const S = 0.16;
const FIELD = { x0: 20, x1: 1900 - 20, y0: 20, y1: 1200 - 20 };                  // the farm field
const FARM = { x0: -25, x1: 2685, y0: -25, y1: 1225 };                             // field + road + shops
const BORDER = { x0: -7900 / S + 30, x1: 8300 / S - 30, y0: -8000 / S + 30, y1: 8200 / S - 30 };   // (Turkey Chase X: the 3D world is twice as big) // the world border
const FARM_TURKEYS = 30, WILD_MAX = 700;
const SEE = 520 / S;
// Turkey Chase 9: the 3D world is a grid of square chunks (64 studs = 400 px across, starting at the field's corner).
// The Main Field is one chunk of its own (the farm turkeys never leave it); every chunk near a player gets CH_PER wild
// turkeys, each with a home chunk it can't wander more than CH_ROAM chunks from. Same numbers as the game.
const CH_PX = 64 / S, CH_LOAD = 2, CH_DROP = 3, CH_ROAM = 2, CH_PER = 5;
const chunkOf = (v) => Math.floor(v / CH_PX);
const chunkPop = new Set();

const turkeys = new Map(); let nextTurkey = 1;
function addTurkey(x, y, farm) {
  const t = { id: nextTurkey++, x, y, sp: rollSpecies(), dx: 0, dy: 0, wander: Math.random() * 40, flee: false, farm, admin: true, hx: chunkOf(x), hy: chunkOf(y) };
  turkeys.set(t.id, t); return t;
}
function farmSpot() { return [FIELD.x0 + Math.random() * (FIELD.x1 - FIELD.x0), FIELD.y0 + Math.random() * (FIELD.y1 - FIELD.y0)]; }
for (let i = 0; i < FARM_TURKEYS; i++) addTurkey(...farmSpot(), true);

// ---------- players ----------
const players = new Map(); let nextPlayer = 1;
// bad words: anywhere in a word, or (short ones) only at the start, so "peacock" and "grape" are fine
const BAD_ANY = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'retard', 'whore', 'pussy', 'porn', 'penis', 'vagina', 'killyourself'];
const BAD_START = ['sex', 'cock', 'dick', 'fag', 'rape', 'nazi', 'kys', 'slut', 'twat', 'wank'];
const squash = (s) => s.toLowerCase().replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!|]/g, 'i').replace(/0/g, 'o').replace(/[5$]/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '');
const isBad = (s) => { const q = squash(s); return BAD_ANY.some(w => q.includes(w)) || BAD_START.some(w => q.startsWith(w)); };
function cleanChat(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return chatFilter ? filterChat(s) : s;
}
// ---------- the chat filter (Turkey Chase 9) ----------
// Like Roblox: swear words and adult words turn into ####. (Phone numbers and emails are allowed.) It's on by default;
// an admin (the Admin app) can turn it off for the whole server from the cheat menu. It comes back on by itself
// once everyone has left the server.
let chatFilter = true;
const BAD_WORD = ['ass', 'asses', 'arse', 'asshole', 'dumbass', 'jackass', 'badass', 'bastard', 'damn', 'goddamn', 'hell', 'crap', 'piss', 'pissed', 'hoe', 'hoes',
  'tit', 'tits', 'titty', 'boob', 'boobs', 'cum', 'nude', 'nudes', 'naked', 'horny', 'sexy', 'stfu', 'wtf', 'omfg', 'fk', 'fck', 'fuk', 'fuq', 'sht', 'btch', 'biatch', 'bish',
  'dildo', 'thot', 'kms', 'bollocks', 'bugger', 'bloody', 'prick', 'douche', 'douchebag'];   // (swearing and adult words only: ordinary insults like stupid or dumb are fine)
const badWord = (w) => { const q = squash(w); if (!q) return false; const r = q.replace(/(.)\1+/g, '$1');   // (fuuuck -> fuck)
  return BAD_ANY.some(b => q.includes(b) || r.includes(b)) || BAD_START.some(b => q.startsWith(b) || r.startsWith(b)) || BAD_WORD.includes(q) || BAD_WORD.includes(r) || BAD_WORD.includes(q.replace(/s$/, '')); };
const hash = (w) => w.replace(/[^\s]/g, '#');
function filterChat(s) {
  // word by word (keeping the spaces and punctuation round each word)
  const parts = s.split(/(\s+)/);
  for (let i = 0; i < parts.length; i++) if (parts[i].trim() && badWord(parts[i])) parts[i] = hash(parts[i]);
  // spaced-out letters ("f u c k", "s.h.i.t"): look at runs of 1-2 character words
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].trim() || squash(parts[i]).length > 2) continue;
    let j = i, joined = '';
    while (j < parts.length && (!parts[j].trim() || squash(parts[j]).length <= 2)) { joined += parts[j].trim() ? squash(parts[j]) : ''; j++; }
    if (joined.length >= 3 && badWord(joined)) for (let k = i; k < j; k++) if (parts[k].trim()) parts[k] = hash(parts[k]);
    i = j;
  }
  return parts.join('');   // (phone numbers and emails are allowed)
}
function cleanName(s, me) {
  s = String(s || '').replace(/[^A-Za-z0-9_ ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (s.length < 3 || isBad(s)) return null;
  let n = s, k = 2;
  while ([...players.values()].some(p => p !== me && p.name && p.name.toLowerCase() === n.toLowerCase())) n = s.slice(0, 13) + k++;
  return n;
}
function cleanLook(l) {
  if (!l || typeof l !== 'object' || JSON.stringify(l).length > 3000) return null;
  const pick = (o) => { const out = {}; if (o && typeof o === 'object') for (const k of Object.keys(o).slice(0, 40)) { const v = o[k]; if (typeof v === 'string' && v.length < 40) out[k] = v; else if (typeof v === 'number' && isFinite(v)) out[k] = v; else if (v === null) out[k] = null; } return out; };
  return { a: pick(l.a), c: pick(l.c) };
}
const PIC_KINDS = ['chest', 'face', 'full', 'pants', 'skirt'], PIC_MAX = 120000, TC9_SPECIES = 50, PIC_RE = /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+\/=]+$/;
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const everyone10 = (o, except) => { const s = JSON.stringify(o); for (const p of players.values()) if (p.ready && p.x10 && p !== except && p.ws.readyState === 1) p.ws.send(s); };
// ---------- 3D model avatars (Turkey Chase X) ----------
// The game packs your 3D model into a small .glb, squashes it, and sends it in pieces (60,000 characters each, at most
// 40). The server keeps it while you're on and passes each piece to the other players — and sends the whole thing to
// anybody who joins later, a few pieces at a time so it doesn't hog the connection.
const MDL_CHUNK = 64000, MDL_MAX = 40, MDL_RE = /^[A-Za-z0-9+\/=]+$/;
function mdlIn(p, m) {
  if (!p.x10) return;
  const h = typeof m.h === 'string' ? m.h.slice(0, 40) : '', n = m.n | 0;
  if (!h || n <= 0) { if (p.mdl) { p.mdl = null; everyone10({ t: 'mdl', id: p.id, h: '', n: 0 }, p); } return; }
  if (n > MDL_MAX) return;
  const i = m.i | 0, d = typeof m.d === 'string' ? m.d : '';
  if (i < 0 || i >= n || !d || d.length > MDL_CHUNK || !MDL_RE.test(d)) return;
  if (!p.mdl || p.mdl.h !== h) p.mdl = { h, n, z: m.z === 'g' ? 'g' : 'r', parts: [], turn: (m.turn | 0) & 3, tip: (m.tip | 0) & 3 };
  const M = p.mdl; if (M.n !== n) return;
  M.parts[i] = d;
  everyone10({ t: 'mdl', id: p.id, h, n, i, z: M.z, d, turn: M.turn, tip: M.tip }, p);
}
function mdlQueueAll(to, from) {
  const M = from.mdl; if (!M) return;
  to.outq = to.outq || [];
  for (let i = 0; i < M.n; i++) if (M.parts[i]) to.outq.push({ t: 'mdl', id: from.id, h: M.h, n: M.n, i, z: M.z, d: M.parts[i], turn: M.turn, tip: M.tip });
}
setInterval(() => {   // (the queued pieces for new players: up to 4 every 100 ms each, if their connection keeps up)
  for (const p of players.values()) if (p.outq && p.outq.length) for (let k = 0; k < 4 && p.outq.length && p.ws.bufferedAmount < 1000000; k++) { const o = p.outq.shift(); if (players.has(o.id)) send(p.ws, o); }
}, 100);
// ---------- logs (Turkey Chase X): placed like Minecraft blocks, gone 5 minutes after they're placed ----------
const BLK_LIFE = 5 * 60000, BLK_CAP = 3000, BLK_MINE = 400, CHOP_LIFE = 3 * 60000, CHOP_CAP = 5000;
const blocks = new Map(), chops = new Map();
const okInt = (v, lim) => Number.isInteger(v) && Math.abs(v) <= lim;
function blkIn(p, m) {
  if (!p.x10) return;
  const i = m.i, j = m.j, l = m.l; if (!okInt(i, 5000) || !okInt(j, 5000) || !okInt(l, 1000000)) return;
  const k = i + ',' + j + ',' + l;
  if (m.a === 'put') {
    if (blocks.has(k) || blocks.size >= BLK_CAP) return;
    let mine = 0; for (const b of blocks.values()) if (b.by === p.id) mine++;
    if (mine >= BLK_MINE) return;
    blocks.set(k, { i, j, l, by: p.id, exp: Date.now() + BLK_LIFE });
    everyone10({ t: 'blk', a: 'put', i, j, l, left: BLK_LIFE }, p);
  } else if (m.a === 'del') {
    if (!blocks.delete(k)) return;
    everyone10({ t: 'blk', a: 'del', i, j, l }, p);
  }
}
// trees chopped down with the axe (they grow back after 3 minutes)
function chopIn(p, m) {
  if (!p.x10 || !okInt(m.x, 1000000) || !okInt(m.z, 1000000)) return;
  const k = m.x + ',' + m.z; if (chops.has(k)) return;
  if (chops.size >= CHOP_CAP) chops.delete(chops.keys().next().value);
  chops.set(k, Date.now() + CHOP_LIFE);
  everyone10({ t: 'chop', x: m.x, z: m.z }, p);
}
// the baseball bat doesn't hurt: it flings the other player (when PvP is on)
function flingIn(p, m) {
  const now = Date.now(), v = players.get(m.to);
  if (!pvpOn || !p.x10 || !v || !v.ready || !v.x10 || v === p) return;
  if (now - (p.flingAt || 0) < 250) return;
  if (safeZone(p) || safeZone(v)) return;
  if (now < p.deadUntil || now < v.deadUntil || now < v.prot) return;
  if (Math.hypot(v.x - p.x, v.y - p.y) > 82 + 150) return;   // (the bat only reaches so far)
  p.flingAt = now; p.prot = 0;
  let dx = Number(m.dx) || 0, dy = Number(m.dy) || 0; const l = Math.hypot(dx, dy) || 1;
  send(v.ws, { t: 'flung', dx: Math.round(dx / l * 1000) / 1000, dy: Math.round(dy / l * 1000) / 1000, by: p.id, bn: p.name });
}
setInterval(() => { const now = Date.now(); for (const [k, b] of blocks) if (now >= b.exp) blocks.delete(k); for (const [k, t] of chops) if (now >= t) chops.delete(k); }, 5000);
// ---------- bags (Turkey Chase X): when you die, everything in your hotbar drops in a bag that anybody can pick up ----------
const BAG_LIFE = 5 * 60000, BAG_CAP = 300, BAG_TYPES = ['gun', 'food', 'weapon', 'trap', 'block', 'armor'], BAG_ID = /^[A-Za-z0-9_-]{1,32}$/;
const bags = new Map(); let bagN = 0;
const bagPub = (b, now) => ({ id: b.id, x: b.x, y: b.y, z: b.z, r: b.r, it: b.it, by: b.by, left: Math.max(0, b.exp - now) });
function bagIn(p, m) {
  const now = Date.now();
  if (!p.x10 || now - (p.bagAt || 0) < 2000) return;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;
  if (!fin(m.x) || !fin(m.y) || !(m.z === null || fin(m.z)) || !['', 'heaven', 'hell'].includes(m.r)) return;
  const it = [];
  for (const o of Array.isArray(m.it) ? m.it.slice(0, 40) : []) {
    if (!o || !BAG_TYPES.includes(o.t) || typeof o.id !== 'string' || !BAG_ID.test(o.id) || !Number.isInteger(o.n) || o.n < 1 || o.n > 1000000) continue;
    it.push({ t: o.t, id: o.id, n: o.n });
  }
  if (!it.length) return;
  p.bagAt = now;
  if (bags.size >= BAG_CAP) bags.delete(bags.keys().next().value);
  const b = { id: 'B' + (++bagN), x: Math.round(m.x), y: Math.round(m.y), z: m.z === null ? null : Math.round(m.z * 100) / 100, r: m.r, it, by: p.name, exp: now + BAG_LIFE };
  bags.set(b.id, b);
  everyone10({ t: 'bagadd', b: bagPub(b, now) });
}
function bagTake(p, m) {
  const b = bags.get(m.id);
  if (!p.x10 || !b) return;
  if (Number.isFinite(p.x) && Math.hypot(b.x - p.x, b.y - p.y) > 600) return;   // (you have to be there)
  bags.delete(b.id);
  send(p.ws, { t: 'bagyou', id: b.id, it: b.it });
  everyone10({ t: 'baggone', id: b.id }, p);
}
setInterval(() => { const now = Date.now(); for (const [k, b] of bags) if (now >= b.exp) bags.delete(k); }, 5000);
const everyone = (o, except) => { const s = JSON.stringify(o); for (const p of players.values()) if (p.ready && p !== except && p.ws.readyState === 1) p.ws.send(s); };

// ---------- weather (mostly sunny or normal) ----------
const WEATHER = [['sunny', 34], ['normal', 40], ['cloudy', 9], ['rain', 8], ['storm', 4], ['snow', 3], ['fog', 2]];
let weather = 'normal', weatherUntil = Date.now() + 180000;
function weatherTick() {
  if (Date.now() < weatherUntil) return;
  let r = Math.random() * 100, n = 'normal'; for (const [id, w] of WEATHER) { r -= w; if (r <= 0) { n = id; break; } }
  weatherUntil = Date.now() + ((n === 'sunny' || n === 'normal') ? 180 + Math.random() * 240 : 90 + Math.random() * 120) * 1000;
  if (n !== weather) { weather = n; everyone({ t: 'wx', id: weather }); }
}

// ---------- signed Admin-app actions (spawn a turkey, change the weather) — run for everyone ----------
async function handleAdmin(p, m) {
  const k = String(m.k || ''); if (!['spawn', 'wx', 'filter', 'pvp', 'reset', 'del', 'music'].includes(k)) return;
  const ts = Number(m.ts) || 0, nonce = String(m.nonce || '');
  if (!nonce || Math.abs(Date.now() - ts) > 60000) return;              // stale or missing
  const key = k + '|' + nonce; if (adminSeen.has(key)) return;          // no replays
  const d = (m.d && typeof m.d === 'object') ? m.d : {};
  const payload = 'admin|' + k + '|' + ts + '|' + nonce + '|' + JSON.stringify(d);
  if (!(await verifyAdmin(payload, m.sig))) return;                     // not from the Admin app: ignore
  adminSeen.add(key); if (adminSeen.size > 8000) adminSeen.clear();
  if (k === 'spawn') {
    const sp = Math.max(0, Math.min(SPECIES.length - 1, Math.floor(Number(d.sp)) || 0));
    let x = Number(d.x), y = Number(d.y); if (!isFinite(x) || !isFinite(y)) { x = p.x; y = p.y; }
    x = Math.max(BORDER.x0, Math.min(BORDER.x1, x)); y = Math.max(BORDER.y0, Math.min(BORDER.y1, y));
    const farm = inFarm(x, y);   // spawned in the Main Field: it stays in the field. Anywhere else: that chunk is its home
    if (farm) { x = Math.max(FIELD.x0, Math.min(FIELD.x1, x)); y = Math.max(FIELD.y0, Math.min(FIELD.y1, y)); }
    else if (farmDist(x, y) < 40) { const c = [[FARM.x0 - 45, y], [FARM.x1 + 45, y], [x, FARM.y0 - 45], [x, FARM.y1 + 45]].sort((a, b) => Math.hypot(a[0] - x, a[1] - y) - Math.hypot(b[0] - x, b[1] - y))[0]; x = c[0]; y = c[1]; }
    const t = { id: nextTurkey++, x, y, sp, dx: 0, dy: 0, wander: 20 + Math.random() * 20, flee: false, farm, admin: true, spawned: true, hx: chunkOf(x), hy: chunkOf(y) };   // (spawned: an admin can delete them, and they don't come back when caught)
    turkeys.set(t.id, t);   // it shows up in everyone's next state update and whoever gets there first catches it
  } else if (k === 'music') { adminMusic(p, d);
  } else if (k === 'del') { adminDel(p, d);
  } else if (k === 'reset') { adminReset(p);
  } else if (k === 'pvp') {
    setPvp(!!d.on);
    everyone({ t: 'sys', m: pvpOn ? '⚔️ An admin turned PvP ON — guns and traps hurt players again!' : '🕊️ An admin turned PvP OFF — nobody can hurt anybody now' });
  } else if (k === 'filter') {
    chatFilter = !!d.on;
    everyone({ t: 'filter', on: chatFilter });
    everyone({ t: 'sys', m: chatFilter ? '💬 An admin turned the chat filter ON' : '💬 An admin turned the chat filter OFF — be nice!' });
  } else if (k === 'wx') {
    const id = String(d.id || '');
    if (id === 'auto') { weatherUntil = Date.now(); }                   // let the weather pick itself again next tick
    else if (['sunny', 'normal', 'cloudy', 'rain', 'storm', 'snow', 'fog'].includes(id)) { weather = id; weatherUntil = Date.now() + 10 * 60000; everyone({ t: 'wx', id: weather }); }
  }
}

// ---------- admin: delete turkeys, and reset the whole server (Turkey Chase X) ----------
// A reset wipes the progress of everybody who's on the server right now. Server save codes still work afterwards:
// anybody who loads one (or joins with one) gets that progress back.
function farmRefill() { let n = 0; for (const t of turkeys.values()) if (t.farm && !t.spawned) n++; while (n++ < FARM_TURKEYS) addTurkey(...farmSpot(), true); }
function adminDel(p, d) {
  const n = d.n === 'all' ? Infinity : Math.floor(Number(d.n) || 0); if (!(n > 0)) return;
  const sp = Number.isInteger(d.sp) && d.sp >= 0 ? d.sp : -1, every = d.every === true;   // (every: the normal turkeys too — they come back by themselves)
  let list = [...turkeys.values()].filter(t => (every || t.spawned) && (sp < 0 || t.sp === sp));
  if (n < list.length) { list.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y)); list = list.slice(0, n); }
  for (const t of list) turkeys.delete(t.id);
  if (every) { farmRefill(); chunkPop.clear(); }
  send(p.ws, { t: 'deldone', n: list.length });
  if (list.length) everyone({ t: 'sys', m: '🗑️ An admin removed ' + list.length.toLocaleString('en-US') + (every ? '' : ' spawned') + ' turkey' + (list.length === 1 ? '' : 's') }, p);
}
function adminReset(p) {
  for (const [id, t] of turkeys) if (t.spawned || !t.farm) turkeys.delete(id);   // (the wild ones come back by themselves)
  farmRefill(); chunkPop.clear();
  blocks.clear(); chops.clear(); bags.clear();
  for (const t of [...traps.values()]) trapGone(t);
  for (const q of players.values()) { q.kills = 0; q.deaths = 0; q.caught = 0; q.hp = 100; q.armor = 0; q.armorId = ''; q.deadUntil = 0; q.stunUntil = 0; }
  weather = 'normal'; weatherUntil = Date.now() + 180000; everyone({ t: 'wx', id: weather });
  everyone({ t: 'srvreset', by: p.name });
}

// ---------- server music (Turkey Chase X) ----------
// The admin picks a song in the Music settings: the Admin app signs a message saying which song it is (its SHA-256),
// then sends it in pieces. When every piece is here and it matches, everybody on the server gets it and hears it
// (players who join later get it too). The admin can turn it off again. It goes when the server is empty.
const MUS_CHUNK = 96000, MUS_MAX = 150, MUS_RE = /^[A-Za-z0-9+\/=]+$/;
let music = null, musUp = null;
function adminMusic(p, d) {
  if (d.off) { music = null; musUp = null; for (const q of players.values()) q.musq = null; everyone10({ t: 'musoff', by: p.name }); return; }
  const n = d.n | 0, h = String(d.h || ''), name = String(d.name || 'song').replace(/[\u0000-\u001f]/g, '').slice(0, 80), mime = String(d.mime || '');
  if (!p.x10 || n < 1 || n > MUS_MAX || !/^[0-9a-f]{64}$/.test(h) || !/^audio\/[a-z0-9.+-]{1,40}$/i.test(mime)) return;
  musUp = { by: p.id, h, n, name, mime, parts: new Array(n), got: 0, t: Date.now() };
  send(p.ws, { t: 'musgo', h });   // (go ahead: send the pieces)
}
function musIn(p, m) {
  const U = musUp; if (!U || U.by !== p.id || m.h !== U.h) return;
  const i = m.i | 0, d = typeof m.d === 'string' ? m.d : '';
  if (i < 0 || i >= U.n || !d || d.length > MUS_CHUNK || !MUS_RE.test(d)) return;
  if (!U.parts[i]) U.got++;
  U.parts[i] = d;
  if (U.got < U.n) return;
  musUp = null;
  if (nodeCrypto.createHash('sha256').update(U.parts.join('')).digest('hex') !== U.h) return;   // (not the song the admin signed for)
  music = { h: U.h, n: U.n, name: U.name, mime: U.mime, parts: U.parts, by: p.name };
  for (const q of players.values()) if (q.ready && q.x10 && q !== p) musQueue(q);
  everyone({ t: 'sys', m: '🎵 ' + p.name + ' (an admin) is playing "' + music.name + '" for everyone' });
}
function musQueue(q) {
  if (!music) return;
  q.musq = [{ t: 'musstart', h: music.h, n: music.n, name: music.name, mime: music.mime, by: music.by }];
  for (let i = 0; i < music.n; i++) q.musq.push({ t: 'mus', h: music.h, i, d: music.parts[i] });
}
setInterval(() => {   // (the song goes out a few pieces at a time, so it doesn't hog anybody's connection)
  for (const q of players.values()) if (q.musq && q.musq.length) for (let k = 0; k < 3 && q.musq.length && q.ws.bufferedAmount < 1000000; k++) send(q.ws, q.musq.shift());
  if (musUp && Date.now() - musUp.t > 120000) musUp = null;   // (an upload that never finished)
}, 100);

// ---------- the game loop ----------
let tick = 0;
function nearestPlayer(x, y) { let best = null, bd = 1e18; for (const p of players.values()) { if (!p.ready) continue; const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; best = p; } } return [best, Math.sqrt(bd)]; }
function moveTurkeys() {
  for (const t of turkeys.values()) {
    const [p, d] = nearestPlayer(t.x, t.y);
    if (p && d < 110) { const a = Math.atan2(t.y - p.y, t.x - p.x); t.dx = Math.cos(a); t.dy = Math.sin(a); t.flee = true; }
    else {
      t.flee = false;
      if (--t.wander <= 0) { const a = Math.random() * Math.PI * 2; t.dx = Math.cos(a) * 0.6; t.dy = Math.sin(a) * 0.6; t.wander = 20 + Math.random() * 27; }
    }
    const spd = 1.5; // (per 1/20 s) turkeys walk away at a steady pace — they never sprint, so the player can always catch up (Turkey Chase 9)
    if (t.farm) {   // Main Field turkeys: bounce round inside the field, never leave it
      t.x += t.dx * spd; t.y += t.dy * spd;
      const box = FIELD;
      if (t.x < box.x0) { t.x = box.x0; t.dx = -t.dx; } if (t.x > box.x1) { t.x = box.x1; t.dx = -t.dx; }
      if (t.y < box.y0) { t.y = box.y0; t.dy = -t.dy; } if (t.y > box.y1) { t.y = box.y1; t.dy = -t.dy; }
      continue;
    }
    // wild turkeys: stay within CH_ROAM chunks of home (and out of the Main Field) — slide along the edge, or turn round
    if (t.hx === undefined || !zoneOK(t, t.x, t.y)) { t.hx = chunkOf(t.x); t.hy = chunkOf(t.y); }
    const nx = t.x + t.dx * spd, ny = t.y + t.dy * spd;
    if (zoneOK(t, nx, ny)) { t.x = nx; t.y = ny; }
    else if (Math.abs(t.dx) > 0.05 && zoneOK(t, nx, t.y)) t.x = nx;
    else if (Math.abs(t.dy) > 0.05 && zoneOK(t, t.x, ny)) t.y = ny;
    else {
      const hx = (t.hx + 0.5) * CH_PX, hy = (t.hy + 0.5) * CH_PX, a = Math.atan2(hy - t.y, hx - t.x) + (Math.random() - 0.5) * 0.9, m = t.flee ? 1 : 0.6;
      t.dx = Math.cos(a) * m; t.dy = Math.sin(a) * m; t.wander = 18;
    }
  }
}
function farmDist(x, y) { const dx = Math.max(FARM.x0 - x, 0, x - FARM.x1), dy = Math.max(FARM.y0 - y, 0, y - FARM.y1); return Math.hypot(dx, dy); }
function zoneOK(t, x, y) {
  return x >= BORDER.x0 && x <= BORDER.x1 && y >= BORDER.y0 && y <= BORDER.y1 && farmDist(x, y) >= 40 &&
    Math.abs(chunkOf(x) - t.hx) <= CH_ROAM && Math.abs(chunkOf(y) - t.hy) <= CH_ROAM;
}
// chunks that are all Main Field, or off the edge of the world, get no wild turkeys
function chunkIsField(cx, cy) { return cx * CH_PX >= FARM.x0 - 125 && (cx + 1) * CH_PX <= FARM.x1 + 125 && cy * CH_PX >= FARM.y0 - 125 && (cy + 1) * CH_PX <= FARM.y1 + 125; }
function chunkInWorld(cx, cy) { return (cx + 1) * CH_PX > BORDER.x0 && cx * CH_PX < BORDER.x1 && (cy + 1) * CH_PX > BORDER.y0 && cy * CH_PX < BORDER.y1; }
// a new wild turkey somewhere in chunk (cx, cy), or null
function chunkSpot(cx, cy) {
  if (chunkIsField(cx, cy) || !chunkInWorld(cx, cy)) return null;
  const ps = [...players.values()].filter(p => p.ready);
  for (let k = 0; k < 12; k++) {
    const x = (cx + Math.random()) * CH_PX, y = (cy + Math.random()) * CH_PX;
    if (x < BORDER.x0 || x > BORDER.x1 || y < BORDER.y0 || y > BORDER.y1 || farmDist(x, y) < 125) continue;
    if (ps.some(p => Math.hypot(p.x - x, p.y - y) < 94)) continue;   // not right on top of someone
    const t = addTurkey(x, y, false); t.hx = cx; t.hy = cy; const mu = mutRoll(x, y, true); if (mu) t.mu = mu;
    t.sp = rollSpeciesLuck(Math.floor(farmDist(x, y) * S / 300));   // (the farther from the Main Field, the rarer: +1 luck every 300 studs)
    return t;
  }
  return null;
}
// a wild turkey was caught: a new one appears in the same chunk or one of the 8 around it
function respawnNear(old) {
  const cx = chunkOf(old.x), cy = chunkOf(old.y), opts = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) opts.push([cx + dx, cy + dy]);
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
  for (const [x, y] of opts) if (chunkSpot(x, y)) return;
}
const inFarm = (x, y) => x > FARM.x0 && x < FARM.x1 && y > FARM.y0 && y < FARM.y1;
// ---------- turkey mutations (Turkey Chase 9) ----------
// While there's weather, wild turkeys in the plains, autumn woods, desert, snowy taiga or mountains can mutate (never in
// the Main Field, a lake or a forest) and are worth more coins. The biomes are worked out exactly like the game does
// (same seeded noise), so the server knows which biome a turkey is in.
const MUT_W = { cloudy: 'shady', rain: 'wet', snow: 'frozen', fog: 'ghostly', storm: 'shocked' };
const MUT_B = { 2: 'maple', 3: 'molten', 4: 'crystal', 5: 'golden' };
const MUT_OK = { 0: 1, 2: 1, 3: 1, 4: 1, 5: 1 };
const BIO = (function () {
  const BX0 = -3900, BX1 = 4300, BZ0 = -4000, BZ1 = 4200, MARGIN = 1000, WX0 = BX0 - MARGIN, WX1 = BX1 + MARGIN, WZ0 = BZ0 - MARGIN, WZ1 = BZ1 + MARGIN;
  const B_PLAINS = 0, B_FOREST = 1, B_AUTUMN = 2, B_DESERT = 3, B_SNOW = 4, B_MOUNTAIN = 5, B_LAKE = 6;
  const SITES = [
    [B_PLAINS, 215, 96], [B_PLAINS, 540, 330], [B_PLAINS, -120, 400], [B_PLAINS, 320, -190], [B_PLAINS, 560, -60],
    [B_LAKE, -310, 50], [B_LAKE, 790, 170],
    [B_FOREST, -540, -260], [B_FOREST, 60, -480], [B_FOREST, -560, 640], [B_FOREST, 420, 660], [B_FOREST, -260, -560],
    [B_AUTUMN, 1000, -80], [B_AUTUMN, 1220, 420], [B_AUTUMN, 840, 600],
    [B_DESERT, 300, 1020], [B_DESERT, 920, 1100], [B_DESERT, -260, 1120], [B_DESERT, 1280, 960],
    [B_SNOW, -780, -840], [B_SNOW, -880, -430],
    [B_MOUNTAIN, 320, -920], [B_MOUNTAIN, 960, -780], [B_MOUNTAIN, -840, 190], [B_MOUNTAIN, 1340, -380], [B_MOUNTAIN, -420, -980],
  ];
  function hash2(i, j) { let h = Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
  function vnoise(x, z) {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, z, oct) { let s = 0, a = 0.5, f = 1, n = 0; for (let k = 0; k < oct; k++) { s += a * vnoise(x * f + k * 17.3, z * f - k * 9.1); n += a; a *= 0.5; f *= 2.03; } return s / n; }
  const SG = 520, siteGrid = new Map(), ALL = [], sgKey = (a, b) => (a + 1000) * 4096 + (b + 1000);
  SITES.forEach(st => ALL.push(st));
  for (let gx = Math.floor(WX0 / SG) - 1; gx <= Math.floor(WX1 / SG) + 1; gx++) for (let gz = Math.floor(WZ0 / SG) - 1; gz <= Math.floor(WZ1 / SG) + 1; gz++) {
    const x = (gx + 0.2 + 0.6 * hash2(gx * 3 + 1, gz * 7 + 2)) * SG, z = (gz + 0.2 + 0.6 * hash2(gx * 5 + 3, gz * 11 + 4)) * SG;
    if (x > -1150 && x < 1650 && z > -1300 && z < 1500) continue;
    const temp = fbm(x / 2600 + 7, z / 2600 - 3, 2), r = hash2(gx * 13 + 5, gz * 17 + 9);
    const t = temp < 0.43 ? (r < 0.32 ? B_SNOW : r < 0.62 ? B_MOUNTAIN : r < 0.93 ? B_FOREST : B_LAKE)
      : temp < 0.57 ? (r < 0.28 ? B_FOREST : r < 0.48 ? B_PLAINS : r < 0.68 ? B_MOUNTAIN : r < 0.9 ? B_AUTUMN : B_LAKE)
      : (r < 0.45 ? B_DESERT : r < 0.65 ? B_PLAINS : r < 0.85 ? B_MOUNTAIN : B_AUTUMN);
    ALL.push([t, x, z]);
  }
  for (const st of ALL) { const k = sgKey(Math.floor(st[1] / SG), Math.floor(st[2] / SG)); let L = siteGrid.get(k); if (!L) siteGrid.set(k, L = []); L.push(st); }
  const W = new Float32Array(7);
  return function biomeAt(x, z) {   // (studs)
    const wx = x + (fbm(x / 260, z / 260, 3) - 0.5) * 230, wz = z + (fbm(x / 260 + 40, z / 260 - 30, 3) - 0.5) * 230;
    const gx = Math.floor(wx / SG), gz = Math.floor(wz / SG); const near = [];
    let dmin = 1e9;
    for (let a = gx - 2; a <= gx + 2; a++) for (let b = gz - 2; b <= gz + 2; b++) { const L = siteGrid.get(sgKey(a, b)); if (!L) continue; for (const st of L) { const d = Math.hypot(wx - st[1], wz - st[2]); near.push([st[0], d]); if (d < dmin) dmin = d; } }
    if (!near.length) return B_PLAINS;
    W.fill(0); for (const [t, d] of near) W[t] += Math.exp(-(d - dmin) / 38);
    let best = 0; for (let t = 1; t < 7; t++) if (W[t] > W[best]) best = t; return best;
  };
})();
function mutRoll(x, y, spawn) {   // (game pixels)
  const w = MUT_W[weather]; if (!w || farmDist(x, y) < 40) return null;
  const b = BIO(x * S, y * S); if (!MUT_OK[b]) return null;
  if (Math.random() > (spawn ? 0.25 : 0.03)) return null;
  return MUT_B[b] && Math.random() < 0.2 ? MUT_B[b] : w;
}
let mutTick = 0;
function wildTurkeys() {
  if (++mutTick % 5 === 0 && MUT_W[weather]) for (const t of turkeys.values()) if (!t.farm && !t.mu && !t.admin) { const m = mutRoll(t.x, t.y, false); if (m) t.mu = m; }
  const ps = [...players.values()].filter(p => p.ready).map(p => [chunkOf(p.x), chunkOf(p.y)]);
  const near = (cx, cy, r) => ps.some(([px, py]) => Math.max(Math.abs(cx - px), Math.abs(cy - py)) <= r);
  // let go of chunks (and their turkeys) that nobody is near any more
  for (const k of chunkPop) { const c = k.split(','); if (!near(+c[0], +c[1], CH_DROP)) chunkPop.delete(k); }
  let wild = 0;
  for (const t of turkeys.values()) { if (t.farm) continue; if (!near(t.hx, t.hy, CH_DROP)) turkeys.delete(t.id); else wild++; }
  // and fill the chunks round every player with their turkeys, nearest first
  let budget = 16;
  for (let r = 0; r <= CH_LOAD; r++) for (const [pcx, pcy] of ps) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const cx = pcx + dx, cy = pcy + dy, k = cx + ',' + cy;
      if (chunkPop.has(k)) continue;
      if (chunkIsField(cx, cy) || !chunkInWorld(cx, cy)) { chunkPop.add(k); continue; }
      if (budget <= 0 || wild + CH_PER > WILD_MAX) continue;
      chunkPop.add(k); budget--;
      for (let q = 0; q < CH_PER; q++) if (chunkSpot(cx, cy)) wild++;
    }
  }
  let farm = 0; for (const t of turkeys.values()) if (t.farm) farm++;
  while (farm++ < FARM_TURKEYS) addTurkey(...farmSpot(), true);
}
// ---------- PvP: guns, rockets, bombs and traps work on other players (Turkey Chase 9) ----------
// The games say who they hit; the server checks it's possible (in range, not too much damage at once, nobody dead or
// just respawned) and keeps everyone's health. 100 health; at 0 you're out for 3 seconds and respawn in the Main Field
// with 3 seconds of spawn protection.
const PVP_W = {   // [most damage one hit can do, how far away (px) it can reach]
  pistol: [25, 600], smg: [9, 520], shotgun: [70, 420], rifle: [14, 780], sniper: [100, 1950], minigun: [5, 620],
  rocket: [80, 1250], bomb: [70, 900], nuke: [100, 2800],
  // Turkey Chase X: melee weapons (up close)
  dagger: [18, 200], axe: [35, 220], sword: [30, 240], spear: [32, 320], mace: [45, 260], katana: [28, 240], scythe: [40, 280] };
const TRAP_DEFS = {
  banana: { kind: 'stun', secs: 2, r: 26 }, slime: { kind: 'puddle', slow: 0.35, r: 70, life: 20 }, ball: { kind: 'throw', slow: 0.4, secs: 6 },
  bear: { kind: 'stun', secs: 4, r: 26 }, net: { kind: 'stun', secs: 7, r: 32 }, pool: { kind: 'puddle', slow: 0.25, r: 160, life: 30 }, cage: { kind: 'stun', secs: 12, r: 34 } };
const TRAP_LIFE = 5 * 60000, TRAP_MAX = 8;
const ARMOR = { leather: 25, chain: 50, iron: 75, diamond: 100 };   // armour soaks up damage before your health does
let pvpOn = true;   // the admin can turn PvP off for the whole server (it comes back on when everyone has left)
const traps = new Map(); let nextTrap = 1;
const trapOut = (t) => ({ tid: t.tid, id: t.id, owner: t.owner, x: Math.round(t.x), y: Math.round(t.y), left: Math.max(0, t.until - Date.now()) });
function trapGone(t) { traps.delete(t.tid); everyone({ t: 'trapgone', tid: t.tid }); }
function pvpStatus(p, now) { return now < p.deadUntil ? 'dead' : now < p.stunUntil ? p.stunId : ''; }
function pvpHit(p, m) {
  const now = Date.now(), v = players.get(m.to), w = String(m.w || ''), spec = PVP_W[w];
  if (!pvpOn || !v || !v.ready || v === p || !spec) return;
  if (safeZone(p) || safeZone(v)) return;
  if (now < p.deadUntil || now < v.deadUntil || now < v.prot) return;          // (dead players can't shoot or be shot; spawn protection)
  if (Math.hypot(v.x - p.x, v.y - p.y) > spec[1] + 150) return;                  // (too far away for that weapon)
  if (now - p.dmgT > 1000) { p.dmgT = now; p.dmgN = 0; }
  const d = Math.max(1, Math.min(spec[0], Math.round(Number(m.d) || 0)));
  if (p.dmgN + d > 900) return; p.dmgN += d;                                      // (no more than 900 damage a second)
  p.prot = 0;                                                                      // (shooting ends your own spawn protection)
  const soak = Math.min(v.armor, d); v.armor -= soak; v.hp -= d - soak;
  send(v.ws, { t: 'hurt', hp: Math.max(0, v.hp), armor: v.armor, d, by: p.id, bn: p.name, w });
  if (v.hp <= 0) {
    v.hp = 100; v.armor = 0; v.armorId = ''; v.deadUntil = now + 3000; v.prot = now + 6000; v.stunUntil = 0; v.deaths++; p.kills++;
    everyone({ t: 'kill', id: v.id, n: v.name, by: p.id, bn: p.name, w });
  }
}
function pvpTrap(p, m) {
  const now = Date.now(), def = TRAP_DEFS[m.id]; if (!def || !pvpOn) return;
  if (now < p.deadUntil) return;
  if (m.k === 'throw' && def.kind === 'throw') {
    const v = players.get(m.to); if (!v || !v.ready || v === p || now < v.deadUntil || now < v.prot || safeZone(v) || safeZone(p)) return;
    if (Math.hypot(v.x - p.x, v.y - p.y) > 1100) return;
    everyone({ t: 'slimed', id: v.id, n: v.name, by: p.id, bn: p.name, slow: def.slow, secs: def.secs });
  } else if (m.k === 'place' && def.kind !== 'throw') {
    const x = Number(m.x), y = Number(m.y); if (!isFinite(x) || !isFinite(y) || Math.hypot(x - p.x, y - p.y) > 400) return;   // (a bit of room for lag)
    if (inBox(SHOPS_ZONE, x, y)) return;   // (no traps in the Shops)
    const mine = [...traps.values()].filter(t => t.owner === p.id);
    while (mine.length >= TRAP_MAX) trapGone(mine.shift());
    const t = { tid: nextTrap++, id: m.id, owner: p.id, x, y, until: now + (def.life ? def.life * 1000 : TRAP_LIFE) };
    traps.set(t.tid, t);
    everyone({ t: 'trapadd', tr: [trapOut(t)] });
  }
}
function pvpTrip(p, m) {
  const now = Date.now(), t = traps.get(Number(m.tid)); if (!t) return;
  const def = TRAP_DEFS[t.id]; if (!pvpOn || !def || def.kind !== 'stun' || t.owner === p.id) return;
  if (now < p.deadUntil || now < p.prot || now < p.stunUntil || safeZone(p)) return;
  if (Math.hypot(t.x - p.x, t.y - p.y) > def.r + 90) return;
  trapGone(t);
  const o = players.get(t.owner);
  p.stunUntil = now + def.secs * 1000; p.stunId = t.id;
  everyone({ t: 'trapped', id: p.id, n: p.name, tr: t.id, secs: def.secs, by: t.owner, bn: o ? o.name : 'someone', x: Math.round(p.x), y: Math.round(p.y) });
}
setInterval(() => { const now = Date.now(); for (const t of traps.values()) if (now > t.until || !players.has(t.owner)) trapGone(t); }, 1000);
function pvpArmor(p, m) {
  const a = ARMOR[m.id]; if (!a || !pvpOn || Date.now() < p.deadUntil) return;
  if (a >= p.armor) p.armorId = m.id;   // (what it looks like: the best armour you've put on)
  p.armor = Math.max(p.armor, a);
}
// safe zones: the Shops are always safe; the Main Field is safe for players who still have under 5 speed or radius.
// Nobody in a safe zone can be hurt or trapped, and nobody can hurt anyone from inside one either.
const SHOPS_ZONE = { x0: 1900 + 120, x1: 1900 + 780, y0: 600 - 350, y1: 600 + 350 }, FIELD_ZONE = { x0: -10, x1: 1910, y0: -10, y1: 1210 };
const inBox = (b, x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
function safeZone(p) { return inBox(SHOPS_ZONE, p.x, p.y) ? 'shops' : inBox(FIELD_ZONE, p.x, p.y) && (p.sl < 5 || p.rl < 5) ? 'field' : ''; }
function setPvp(on) {
  pvpOn = !!on;
  if (!pvpOn) { for (const t of [...traps.values()]) trapGone(t); for (const p of players.values()) { p.hp = 100; p.stunUntil = 0; p.deadUntil = 0; } }
  everyone({ t: 'pvp', on: pvpOn });
}
// ---------- server save codes (Turkey Chase 9) ----------
// Your server progress is packed up, squashed and locked with AES-256-GCM using a secret key that only this server
// knows (the SAVE_KEY setting on Render — it's never in the game). Without that key nobody can read a code, and
// changing even one letter makes the lock fail, so the server just refuses it: a code can't be edited, by a person
// or an AI. (Keep SAVE_KEY the same forever — if it changes, old codes stop working.)
let SAVE_KEY = null;
{ const k = String(process.env.SAVE_KEY || '').trim(); if (k) { const b = Buffer.from(k, 'base64'); SAVE_KEY = b.length === 32 ? b : nodeCrypto.createHash('sha256').update(k).digest(); } }
if (!SAVE_KEY) console.warn('⚠️  SAVE_KEY is not set, so server save codes are switched off. Add SAVE_KEY in your Render settings (Environment).');
const SAVE_AAD = Buffer.from('TurkeyChase9|server-save|v1');
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sealSave(obj) {
  const iv = nodeCrypto.randomBytes(12), c = nodeCrypto.createCipheriv('aes-256-gcm', SAVE_KEY, iv);
  c.setAAD(SAVE_AAD);
  const body = Buffer.concat([c.update(zlib.deflateRawSync(Buffer.from(JSON.stringify(obj), 'utf8'))), c.final()]);
  return 'TC9S-' + b64u(Buffer.concat([iv, c.getAuthTag(), body]));
}
function openSave(code) {
  const m = String(code || '').replace(/\s+/g, '').match(/^TC9S-([A-Za-z0-9_-]{40,})$/); if (!m) return null;
  try {
    const raw = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', SAVE_KEY, raw.subarray(0, 12));
    d.setAAD(SAVE_AAD); d.setAuthTag(raw.subarray(12, 28));
    const out = JSON.parse(zlib.inflateRawSync(Buffer.concat([d.update(raw.subarray(28)), d.final()])).toString('utf8'));
    return out && out.v === 1 && out.d && typeof out.d === 'object' ? out : null;
  } catch (e) { return null; }   // (wrong key, edited, cut short...: not a real code)
}
// Each server save code only works on the internet connection (IP address) it was made on. The code carries a
// fingerprint of that IP (a keyed hash — the IP itself isn't in it), and the server compares it with the IP of whoever
// tries to load it: a code copied to somebody else's house just won't load. (For IPv6, the fingerprint is of the
// household part of the address, because the rest changes by itself every day or so.)
function ipOf(req) {
  const fwd = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  let ip = fwd || String((req && req.socket && req.socket.remoteAddress) || '');
  ip = ip.replace(/^::ffff:/i, '');
  if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':') + '::/64';   // (IPv6: the /64 network)
  return ip;
}
const ipPrint = (ip) => nodeCrypto.createHmac('sha256', SAVE_KEY || Buffer.alloc(32)).update('ip|' + ip).digest('base64').slice(0, 22);
function srvCodeFor(p, d) { const at = Date.now(); return { code: sealSave({ v: 1, d, k: p.kills, dt: p.deaths, c: p.caught, n: p.name, ip: ipPrint(p.ip), at }), at }; }
function srvSave(p, m) {
  if (!SAVE_KEY) { send(p.ws, { t: 'srvcode', off: true }); return; }
  const now = Date.now(); if (now - (p.saveAt || 0) < 3000) return; p.saveAt = now;
  if (!m.d || typeof m.d !== 'object' || Array.isArray(m.d)) return;
  const json = JSON.stringify(m.d); if (json.length > 60000) return;
  const c = srvCodeFor(p, m.d);
  send(p.ws, { t: 'srvcode', code: c.code, at: c.at });
}
function srvLoad(p, m) {
  if (!SAVE_KEY) { send(p.ws, { t: 'srvloaded', off: true }); return; }
  const o = openSave(m.code); if (!o) { send(p.ws, { t: 'srvloaded', bad: true }); return; }
  if (o.ip && o.ip !== ipPrint(p.ip)) { send(p.ws, { t: 'srvloaded', wrongip: true }); return; }   // (made on a different internet connection)
  p.kills = Math.max(0, o.k | 0); p.deaths = Math.max(0, o.dt | 0); p.caught = Math.max(0, o.c | 0);
  const c = srvCodeFor(p, o.d);
  send(p.ws, { t: 'srvloaded', d: o.d, at: o.at, code: c.code, codeAt: c.at });
}
// changing your name without leaving the server
function srvRename(p, m) {
  const now = Date.now(); if (now - (p.renameAt || 0) < 4000) { send(p.ws, { t: 'renamebad', why: 'slow' }); return; }
  const name = cleanName(m.name, p); if (!name) { send(p.ws, { t: 'renamebad', why: 'bad' }); return; }
  p.renameAt = now;
  if (name === p.name) { send(p.ws, { t: 'rename', id: p.id, name, old: p.name }); return; }
  const old = p.name; p.name = name;
  everyone({ t: 'rename', id: p.id, name, old });
}
function sendState() {
  const ps = [...players.values()].filter(p => p.ready);
  const now = Date.now();
  const pl = ps.map(p => [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.z * 10) / 10, Math.round(p.f * 100) / 100, p.m, p.j, p.e, p.ping, p.caught, Math.max(0, p.hp), p.kills, p.deaths, pvpStatus(p, now), now < p.prot ? 1 : 0, p.armor, p.armor > 0 && !p.armorHidden ? p.armorId : '', safeZone(p)]);   // (+ armour you can see, and safe zone)   // (+ ping and turkeys caught for the Tab list, and health / kills / deaths / trapped-or-dead / spawn protection for PvP)
  for (const p of ps) {
    const tk = [];
    for (const t of turkeys.values()) if (Math.abs(t.x - p.x) < SEE && Math.abs(t.y - p.y) < SEE && (p.x10 || t.sp < TC9_SPECIES)) tk.push(t.mu ? [t.id, Math.round(t.x), Math.round(t.y), t.sp, t.mu] : [t.id, Math.round(t.x), Math.round(t.y), t.sp]);
    send(p.ws, { t: 'st', pl, tk, n: ps.length });
  }
}
setInterval(() => {
  tick++;
  moveTurkeys();
  if (tick % 20 === 0) { wildTurkeys(); weatherTick(); }
  if (tick % SEND_EVERY === 0) sendState();
}, TICK);

// ---------- connections ----------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('Turkey Chase X server is running. Players online: ' + [...players.values()].filter(p => p.ready).length + '\n');
});
const wss = new WebSocketServer({ server, maxPayload: 192 * 1024 });
wss.on('connection', (ws, req) => {
  if (players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
  const p = { id: nextPlayer++, ws, ready: false, name: '', x: 950, y: 600, z: 0, f: 0, m: 0, j: 0, e: '', look: null, alive: true, chatTokens: 3, chatAt: Date.now(), msgs: 0, lastCatch: 0, ip: ipOf(req), ping: -1, caught: 0, pics: {}, picAt: {}, hp: 100, armor: 0, armorId: '', armorHidden: false, sl: 1, rl: 1, kills: 0, deaths: 0, deadUntil: 0, prot: 0, stunUntil: 0, stunId: '', dmgT: 0, dmgN: 0 };
  players.set(p.id, p);
  ws.on('pong', () => { p.alive = true; });
  ws.on('message', (raw) => {
    if (++p.msgs > 80) return; // (spam guard; reset every second)
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello' && !p.ready) {
      const name = cleanName(m.name);
      if (!name) { send(ws, { t: 'badname' }); return; }
      p.name = name; p.look = cleanLook(m.look); p.ready = true; p.x10 = Number(m.ver) >= 10;   // (Turkey Chase X: new turkeys + 3D models)
      p.prot = Date.now() + 3000;
      send(ws, { t: 'welcome', x: 1, id: p.id, name, weather, filter: chatFilter, pvp: pvpOn, traps: [...traps.values()].map(trapOut), players: [...players.values()].filter(q => q.ready).map(q => ({ id: q.id, name: q.name, look: q.look })) });
      everyone({ t: 'join', id: p.id, name, look: p.look }, p);
      // everyone's avatar pictures (chest / face / whole avatar / pants), so the new player sees them too
      for (const q of players.values()) if (q.ready && q !== p) for (const k of PIC_KINDS) if (q.pics[k]) send(ws, { t: 'pic', id: q.id, k, d: q.pics[k] });
      if (p.x10) for (const q of players.values()) if (q.ready && q !== p) mdlQueueAll(p, q);
      if (p.x10) { const now = Date.now(); send(ws, { t: 'blks', l: [...blocks.values()].map(b => [b.i, b.j, b.l, Math.max(0, b.exp - now)]) }); send(ws, { t: 'chops', l: [...chops].map(([k, t]) => k.split(',').map(Number).concat(Math.max(0, t - now))) }); send(ws, { t: 'bags', l: [...bags.values()].map(b => bagPub(b, now)) }); if (music) musQueue(p); }
      return;
    }
    if (!p.ready) return;
    if (m.t === 'ping') {
      // the game measures its own ping: answer straight away, and remember the last one it measured so everyone's Tab list can show it
      send(ws, { t: 'pong', c: m.c });
      const pg = Number(m.p); if (isFinite(pg) && pg >= 0) p.ping = Math.min(9999, Math.round(pg));
      return;
    }
    if (m.t === 'srvsave') { srvSave(p, m); return; }
    if (m.t === 'srvload') { srvLoad(p, m); return; }
    if (m.t === 'rename') { srvRename(p, m); return; }
    if (m.t === 'hit') { pvpHit(p, m); return; }
    if (m.t === 'blk') { blkIn(p, m); return; }
    if (m.t === 'chop') { chopIn(p, m); return; }
    if (m.t === 'fling') { flingIn(p, m); return; }
    if (m.t === 'bag') { bagIn(p, m); return; }
    if (m.t === 'bagtake') { bagTake(p, m); return; }
    if (m.t === 'mus') { musIn(p, m); return; }
    if (m.t === 'trap') { pvpTrap(p, m); return; }
    if (m.t === 'trip') { pvpTrip(p, m); return; }
    if (m.t === 'armor') { pvpArmor(p, m); return; }
    if (m.t === 'armorhide') { p.armorHidden = !!m.on; return; }   // (Invisible Armour, bought in the shop)
    if (m.t === 'pic') {
      // a player's avatar picture (made small by the game before it's sent): keep it and pass it on to everyone else
      const k = String(m.k || ''); if (!PIC_KINDS.includes(k)) return;
      const d = typeof m.d === 'string' ? m.d : '';
      if (d && (d.length > PIC_MAX || !PIC_RE.test(d))) return;
      if (d) p.pics[k] = d; else delete p.pics[k];
      if (p.x10) send(ws, { t: 'picok', k });
      p.picTimer = p.picTimer || {};
      const now = Date.now(), wait = 1000 - (now - (p.picAt[k] || 0));
      if (wait <= 0) { p.picAt[k] = now; everyone({ t: 'pic', id: p.id, k, d }, p); }
      else if (!p.picTimer[k]) p.picTimer[k] = setTimeout(() => {   // (two in a row: the newest one goes out in a moment)
        p.picTimer[k] = 0; if (!players.has(p.id)) return;
        p.picAt[k] = Date.now(); everyone({ t: 'pic', id: p.id, k, d: p.pics[k] || '' }, p);
      }, wait);
      return;
    }
    if (m.t === 'mdl') { mdlIn(p, m); return; }
    if (m.t === 'mdlm') {   // ↻ Turn / ⤵ Tip over on a 3D model
      if (!p.mdl) return;
      p.mdl.turn = (m.turn | 0) & 3; p.mdl.tip = (m.tip | 0) & 3;
      everyone10({ t: 'mdlm', id: p.id, turn: p.mdl.turn, tip: p.mdl.tip }, p);
      return;
    }
    if (m.t === 'pos') {
      const n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
      p.x = Math.max(BORDER.x0 - 4000, Math.min(BORDER.x1 + 4000, n(m.x, p.x))); p.y = Math.max(BORDER.y0 - 4000, Math.min(BORDER.y1 + 4000, n(m.y, p.y)));
      p.z = n(m.z, 0); p.f = n(m.f, 0); p.m = m.m ? 1 : 0; p.j = m.j ? 1 : 0; p.e = typeof m.e === 'string' ? m.e.slice(0, 12) : '';
      if (typeof m.sl === 'number') p.sl = m.sl; if (typeof m.rl === 'number') p.rl = m.rl;   // (speed and radius levels: for the Field safe zone)
    } else if (m.t === 'look') {
      p.look = cleanLook(m.look); everyone({ t: 'look', id: p.id, look: p.look }, p);
    } else if (m.t === 'chat') {
      const now = Date.now(); p.chatTokens = Math.min(3, p.chatTokens + (now - p.chatAt) / 1500); p.chatAt = now;
      if (p.chatTokens < 1) { send(ws, { t: 'sys', m: 'Slow down a bit!' }); return; }
      const text = cleanChat(m.m); if (!text) return;
      p.chatTokens -= 1;
      everyone({ t: 'chat', id: p.id, n: p.name, m: text });
    } else if (m.t === 'catch') {
      // first one to reach it gets it
      const t = turkeys.get(m.id); if (!t || Date.now() < p.deadUntil) return;
      const reach = m.w ? 1700 : Math.min(3200, Math.max(0, Number(m.r) || 0)) + 70;
      if (Math.hypot(t.x - p.x, t.y - p.y) > reach) return;
      turkeys.delete(t.id); p.caught++;
      everyone({ t: 'caught', id: t.id, by: p.id, sp: t.sp, n: p.name, mu: t.mu || '' });
      if (t.spawned) {}                            // (Turkey Chase X: a spawned one doesn't come back)
      else if (t.farm) addTurkey(...farmSpot(), true);   // a new one straight away: in the field for a field turkey,
      else respawnNear(t);                          // or in the same chunk / one next to it for a wild one
    } else if (m.t === 'tp') {
      // relay a teleport message to one specific player. The clients work out what it means and who moves;
      // an admin "force" pull is signed by the Admin app, so the receiver checks the signature before obeying.
      const to = players.get(m.to); if (!to || !to.ready || to === p) return;
      const k = String(m.k || ''); if (!['ask', 'here', 'acc', 'deny', 'force'].includes(k)) return;
      const out = { t: 'tp', k, from: p.id, fromName: p.name };
      if (k === 'force') { out.sig = typeof m.sig === 'string' ? m.sig.slice(0, 240) : ''; out.ts = Number(m.ts) || 0; }
      send(to.ws, out);
    } else if (m.t === 'admin') {
      handleAdmin(p, m);   // a signed Admin-app action (runs for everyone)
    }
  });
  ws.on('close', () => { players.delete(p.id); for (const k in (p.picTimer || {})) clearTimeout(p.picTimer[k]); p.mdl = null; p.outq = null; if (p.ready) everyone({ t: 'leave', id: p.id, name: p.name }); if (![...players.values()].some(q => q.ready)) { chatFilter = true; pvpOn = true; music = null; musUp = null; } p.musq = null; });   // (empty server: filter back on)
  ws.on('error', () => {});
});
setInterval(() => { for (const p of players.values()) p.msgs = 0; }, 1000);
setInterval(() => { for (const p of players.values()) { if (!p.alive) { p.ws.terminate(); continue; } p.alive = false; try { p.ws.ping(); } catch (e) {} } }, 20000);
server.listen(PORT, () => console.log('Turkey Chase X server listening on port ' + PORT));
