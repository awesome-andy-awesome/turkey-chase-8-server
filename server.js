// =====================================================================
// Turkey Chase 8 — the multiplayer server. There's just ONE: everybody who presses 🌐 Play Server
// (website, Windows, Mac or Android) ends up here, in the same world, playing together.
//
// The server owns the turkeys, so when a good one spawns it goes to whoever catches it FIRST.
// It also runs the weather and passes chat around (with spam limits).
// Progress isn't kept here: each player's coins live in their own game for as long as they stay.
//
// Run it:  npm install   then   npm start        (it listens on PORT, or 8080)
// =====================================================================
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 40;
const TICK = 50;                 // 20 updates a second
const SEND_EVERY = 3;            // positions go out ~7 times a second

// ---------- the turkeys (same 40 kinds, values and rarity as the game) ----------
const SPECIES = require('./species.json'); // [name, value, weight]
const TOTAL_W = SPECIES.reduce((s, x) => s + x[2], 0);
function rollSpecies() { let r = Math.random() * TOTAL_W; for (let i = 0; i < SPECIES.length; i++) { r -= SPECIES[i][2]; if (r <= 0) return i; } return 0; }

// the map, in game pixels (1 stud = 6.25 pixels)
const S = 0.16;
const FIELD = { x0: 20, x1: 1900 - 20, y0: 20, y1: 1200 - 20 };                  // the farm field
const FARM = { x0: -25, x1: 2685, y0: -25, y1: 1225 };                             // field + road + shops
const BORDER = { x0: -3900 / S + 30, x1: 4300 / S - 30, y0: -4000 / S + 30, y1: 4200 / S - 30 }; // the world border
const FARM_TURKEYS = 30, WILD_PER_PLAYER = 22, WILD_MAX = 260;
const NEAR = 330 / S, SPAWN_MIN = 70 / S, SPAWN_MAX = 230 / S, SEE = 520 / S;

const turkeys = new Map(); let nextTurkey = 1;
function addTurkey(x, y, farm) {
  const t = { id: nextTurkey++, x, y, sp: rollSpecies(), dx: 0, dy: 0, wander: Math.random() * 40, flee: false, farm };
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
  // (no word filter: messages go out just as they're typed, up to 120 characters)
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
}
function cleanName(s) {
  s = String(s || '').replace(/[^A-Za-z0-9_ ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (s.length < 3 || isBad(s)) return null;
  let n = s, k = 2;
  while ([...players.values()].some(p => p.name && p.name.toLowerCase() === n.toLowerCase())) n = s.slice(0, 13) + k++;
  return n;
}
function cleanLook(l) {
  if (!l || typeof l !== 'object' || JSON.stringify(l).length > 3000) return null;
  const pick = (o) => { const out = {}; if (o && typeof o === 'object') for (const k of Object.keys(o).slice(0, 40)) { const v = o[k]; if (typeof v === 'string' && v.length < 40) out[k] = v; else if (typeof v === 'number' && isFinite(v)) out[k] = v; else if (v === null) out[k] = null; } return out; };
  return { a: pick(l.a), c: pick(l.c) };
}
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
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
    const spd = (t.flee ? 2.8 : 1.1) * 3; // (per 1/20 s)
    t.x += t.dx * spd; t.y += t.dy * spd;
    const box = t.farm ? FIELD : BORDER;
    if (t.x < box.x0) { t.x = box.x0; t.dx = -t.dx; } if (t.x > box.x1) { t.x = box.x1; t.dx = -t.dx; }
    if (t.y < box.y0) { t.y = box.y0; t.dy = -t.dy; } if (t.y > box.y1) { t.y = box.y1; t.dy = -t.dy; }
  }
}
const inFarm = (x, y) => x > FARM.x0 && x < FARM.x1 && y > FARM.y0 && y < FARM.y1;
function wildTurkeys() {
  const ps = [...players.values()].filter(p => p.ready);
  // forget wild turkeys nobody is near
  for (const t of turkeys.values()) if (!t.farm && !ps.some(p => Math.hypot(p.x - t.x, p.y - t.y) < NEAR)) turkeys.delete(t.id);
  let wild = 0; for (const t of turkeys.values()) if (!t.farm) wild++;
  // and keep some round everyone who's out exploring
  for (const p of ps) {
    let near = 0; for (const t of turkeys.values()) if (!t.farm && Math.hypot(p.x - t.x, p.y - t.y) < NEAR) near++;
    for (let k = 0; near < WILD_PER_PLAYER && wild < WILD_MAX && k < 6; k++) {
      const a = Math.random() * Math.PI * 2, r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN), x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r;
      if (x < BORDER.x0 || x > BORDER.x1 || y < BORDER.y0 || y > BORDER.y1 || inFarm(x, y)) continue;
      addTurkey(x, y, false); near++; wild++;
    }
  }
  let farm = 0; for (const t of turkeys.values()) if (t.farm) farm++;
  while (farm++ < FARM_TURKEYS) addTurkey(...farmSpot(), true);
}
function sendState() {
  const ps = [...players.values()].filter(p => p.ready);
  const pl = ps.map(p => [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.z * 10) / 10, Math.round(p.f * 100) / 100, p.m, p.j, p.e]);
  for (const p of ps) {
    const tk = [];
    for (const t of turkeys.values()) if (Math.abs(t.x - p.x) < SEE && Math.abs(t.y - p.y) < SEE) tk.push([t.id, Math.round(t.x), Math.round(t.y), t.sp]);
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
  res.end('Turkey Chase 8 server is running. Players online: ' + [...players.values()].filter(p => p.ready).length + '\n');
});
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });
wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
  const p = { id: nextPlayer++, ws, ready: false, name: '', x: 950, y: 600, z: 0, f: 0, m: 0, j: 0, e: '', look: null, alive: true, chatTokens: 3, chatAt: Date.now(), msgs: 0, lastCatch: 0 };
  players.set(p.id, p);
  ws.on('pong', () => { p.alive = true; });
  ws.on('message', (raw) => {
    if (++p.msgs > 60) return; // (spam guard; reset every second)
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello' && !p.ready) {
      const name = cleanName(m.name);
      if (!name) { send(ws, { t: 'badname' }); return; }
      p.name = name; p.look = cleanLook(m.look); p.ready = true;
      send(ws, { t: 'welcome', id: p.id, name, weather, players: [...players.values()].filter(q => q.ready).map(q => ({ id: q.id, name: q.name, look: q.look })) });
      everyone({ t: 'join', id: p.id, name, look: p.look }, p);
      return;
    }
    if (!p.ready) return;
    if (m.t === 'pos') {
      const n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
      p.x = Math.max(BORDER.x0 - 4000, Math.min(BORDER.x1 + 4000, n(m.x, p.x))); p.y = Math.max(BORDER.y0 - 4000, Math.min(BORDER.y1 + 4000, n(m.y, p.y)));
      p.z = n(m.z, 0); p.f = n(m.f, 0); p.m = m.m ? 1 : 0; p.j = m.j ? 1 : 0; p.e = typeof m.e === 'string' ? m.e.slice(0, 12) : '';
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
      const t = turkeys.get(m.id); if (!t) return;
      const reach = m.w ? 1700 : Math.min(3200, Math.max(0, Number(m.r) || 0)) + 70;
      if (Math.hypot(t.x - p.x, t.y - p.y) > reach) return;
      turkeys.delete(t.id);
      everyone({ t: 'caught', id: t.id, by: p.id, sp: t.sp, n: p.name });
    }
  });
  ws.on('close', () => { players.delete(p.id); if (p.ready) everyone({ t: 'leave', id: p.id, name: p.name }); });
  ws.on('error', () => {});
});
setInterval(() => { for (const p of players.values()) p.msgs = 0; }, 1000);
setInterval(() => { for (const p of players.values()) { if (!p.alive) { p.ws.terminate(); continue; } p.alive = false; try { p.ws.ping(); } catch (e) {} } }, 20000);
server.listen(PORT, () => console.log('Turkey Chase 8 server listening on port ' + PORT));
