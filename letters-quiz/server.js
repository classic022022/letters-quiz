// مسابقة الحروف — خادم اللعب الجماعي
// غرف برمز من 4 أرقام · مقدم + لاعبون من جوالاتهم + شاشة تلفاز اختيارية
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

/* ==================== بنك الأسئلة ==================== */
const LETTERS = ["أ","ب","ت","ث","ج","ح","خ","د","ذ","ر","ز","س","ش","ص","ض","ط","ظ","ع","غ","ف","ق","ك","ل","م","ن","هـ","و","ي"];
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "questions.js"), "utf8"), sandbox);
const BANK = sandbox.window.HARF_BANK;
const BANK_COUNTS = Object.fromEntries(LETTERS.map(l => [l, (BANK[l] || []).length]));
const TEAM_COLORS = ["#0F8B8D", "#D9822B", "#7A4FD1", "#C23B5A"];

/* قواعد المطابقة: تجاهل «الـ» والهمزات والتشكيل والتنوين، وة/ه، وى/ي */
function normalize(s) {
  if (!s) return "";
  s = String(s).trim()
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[^ء-ي0-9a-zA-Z\s]/g, "")
    .replace(/\s+/g, " ").trim();
  s = s.replace(/^ال(?=.{2,})/, "");
  return s;
}
const letterKey = l => (l === "هـ" ? "ه" : normalize(l));
function isAccepted(text, q) {
  const n = normalize(text);
  if (!n) return false;
  return [q.a, ...(q.alt || [])].some(x => normalize(x) === n);
}

/* ==================== أدوات ==================== */
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const token = () => crypto.randomBytes(12).toString("hex");
const clean = (s, n = 24) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);
const clamp = (v, lo, hi, d) => { v = parseInt(v, 10); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

/* تدوير الأسئلة: الأقل استخداماً أولاً (السجل يحفظه جهاز المقدم ويرسله عند إنشاء الغرفة) */
function pickQuestions(room, l, n) {
  const uses = id => room.usage[id] || 0;
  const by = {};
  shuffle((BANK[l] || []).slice()).forEach(q => (by[uses(q.id)] ||= []).push(q));
  const tiers = Object.keys(by).map(Number).sort((a, b) => a - b).map(k => by[k]);
  const want = { easy: Math.round(n * .4), mid: Math.round(n * .4) }; want.hard = n - want.easy - want.mid;
  const out = [];
  for (const tier of tiers) {
    const need = n - out.length; if (need <= 0) break;
    if (tier.length <= need) { out.push(...tier); continue; }
    const have = { easy: 0, mid: 0, hard: 0 }; out.forEach(q => have[q.level]++);
    const quota = {}; for (const k in want) quota[k] = Math.max(0, want[k] - have[k]);
    const pick = [], rest = [];
    tier.forEach(q => { if (pick.length < need && quota[q.level] > 0) { pick.push(q); quota[q.level]--; } else rest.push(q); });
    while (pick.length < need && rest.length) pick.push(rest.shift());
    out.push(...pick);
  }
  return shuffle(out);
}

/* ==================== الغرف ==================== */
const rooms = new Map();
function newCode() { let c; do { c = String(crypto.randomInt(1000, 10000)); } while (rooms.has(c)); return c; }

function defaultSettings() {
  return { mode: "players", teams: [{ name: "الفريق الأول" }, { name: "الفريق الثاني" }], teamPick: "choose",
           rounds: 5, perLetter: 10, time: 25, hostPlays: false };
}
function sanitizeSettings(s, prev) {
  s = s || {}; const d = prev || defaultSettings();
  const teams = Array.isArray(s.teams) ? s.teams.slice(0, 4).map((t, i) => ({ name: clean(t && t.name, 20) || `فريق ${i + 1}` })) : d.teams;
  const hostPlays = s.hostPlays != null ? !!s.hostPlays : d.hostPlays;
  let time = clamp(s.time, 0, 120, d.time);
  if (hostPlays && time < 10) time = 20;                 // الوضع التلقائي يحتاج مؤقتاً لإغلاق السؤال
  return {
    mode: s.mode === "teams" ? "teams" : (s.mode === "players" ? "players" : d.mode),
    teams: teams.length >= 2 ? teams : d.teams,
    teamPick: s.teamPick === "random" ? "random" : (s.teamPick === "choose" ? "choose" : d.teamPick),
    rounds: clamp(s.rounds, 1, 28, d.rounds),
    perLetter: clamp(s.perLetter, 1, 35, d.perLetter),
    time, hostPlays,
  };
}

function createRoom(settings, usage) {
  const code = newCode();
  const room = {
    code, hostToken: token(), hostSockets: new Set(), lastActive: Date.now(),
    settings: sanitizeSettings(settings), usage: {},
    players: new Map(), order: [],
    phase: "lobby", usedLetters: [], round: 0, letter: null, picked: null,
    queue: [], qi: 0, q: null, roundStart: {}, tiebreak: null, final: null, log: [], timers: new Set(),
  };
  if (usage && typeof usage === "object") for (const [k, v] of Object.entries(usage)) { const n = parseInt(v, 10); if (n > 0) room.usage[k] = n; }
  rooms.set(code, room);
  return room;
}
function later(room, ms, fn) { const t = setTimeout(() => { room.timers.delete(t); fn(); }, ms); room.timers.add(t); return t; }
function clearTimers(room) { room.timers.forEach(clearTimeout); room.timers.clear(); }

/* المشاركون في الترتيب: لاعبون أو فرق */
function teamScores(room) {
  const s = room.settings.teams.map(() => 0);
  room.players.forEach(p => { if (p.team != null && s[p.team] != null) s[p.team] += p.score; });
  return s;
}
function standings(room) {
  if (room.settings.mode === "teams") {
    const s = teamScores(room);
    return room.settings.teams.map((t, i) => ({ key: "t" + i, name: t.name, score: s[i], color: TEAM_COLORS[i],
      members: [...room.players.values()].filter(p => p.team === i).map(p => p.name) })).sort((a, b) => b.score - a.score);
  }
  return [...room.players.values()].map(p => ({ key: p.id, name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
}
const keyOf = (room, p) => (room.settings.mode === "teams" ? "t" + p.team : p.id);
function canAnswer(room, p) {
  if (!p || !room.q || room.q.closed) return false;
  if (room.settings.mode === "teams" && p.team == null) return false;
  if (room.q.locked.has(p.id)) return false;
  if (room.tiebreak && !room.tiebreak.among.includes(keyOf(room, p))) return false;
  return true;
}

/* ==================== سير اللعبة ==================== */
function availableLetters(room) { return LETTERS.filter(l => !room.usedLetters.includes(l) && BANK_COUNTS[l] > 0); }

function startGame(room) {
  if (room.settings.mode === "teams") {
    const ps = [...room.players.values()];
    const nT = room.settings.teams.length;
    if (room.settings.teamPick === "random") shuffle(ps).forEach((p, i) => { p.team = i % nT; });
    else ps.filter(p => p.team == null).forEach(p => {                    // من لم يختر يُوزَّع على الفريق الأقل عدداً
      const c = room.settings.teams.map((_, i) => ps.filter(x => x.team === i).length);
      p.team = c.indexOf(Math.min(...c));
    });
  }
  room.players.forEach(p => { p.score = 0; });
  Object.assign(room, { usedLetters: [], round: 0, letter: null, queue: [], qi: 0, q: null, tiebreak: null, final: null, log: [] });
  toBoard(room);
}

function toBoard(room) {
  clearTimers(room);
  const avail = availableLetters(room);
  if (!room.tiebreak && (room.round >= room.settings.rounds || !avail.length)) return finish(room);
  if (room.tiebreak && !avail.length) return finish(room, true);
  room.phase = "board"; room.picked = null; room.q = null;
  broadcast(room);
  if (room.settings.hostPlays) later(room, 2500, () => pickLetter(room));
}

function pickLetter(room, chosen) {
  if (room.phase !== "board" || room.picked) return;
  const avail = availableLetters(room);
  if (!avail.length) return finish(room);
  const l = chosen && avail.includes(chosen) ? chosen : avail[crypto.randomInt(avail.length)];
  room.picked = l; broadcast(room);
  later(room, 2600, () => startLetter(room, l));                         // وقت لحركة الدوران على الشاشات
}

function startLetter(room, l) {
  room.letter = l; room.usedLetters.push(l);
  if (!room.tiebreak) room.round++;
  room.queue = room.tiebreak ? shuffle((BANK[l] || []).slice()).sort((a, b) => (room.usage[a.id] || 0) - (room.usage[b.id] || 0))
                             : pickQuestions(room, l, room.settings.perLetter);
  room.qi = 0;
  room.roundStart = Object.fromEntries(standings(room).map(s => [s.key, s.score]));
  showQuestion(room);
}

function showQuestion(room) {
  clearTimers(room);
  const q = room.queue[room.qi];
  if (!q) return endLetter(room);
  const now = Date.now(), t = room.settings.time;
  room.q = { id: q.id, data: q, startedAt: now, deadline: t > 0 ? now + t * 1000 : null, closed: false, timeUp: false,
             winner: null, answers: [], locked: new Set(), how: null };
  room.phase = "question";
  room.usage[q.id] = (room.usage[q.id] || 0) + 1;
  room.hostSockets.forEach(id => io.to(id).emit("used", q.id));            // جهاز المقدم يحفظ سجل التدوير
  if (t > 0) later(room, t * 1000 + 150, () => timeUp(room));
  broadcast(room);
}

function timeUp(room) {
  if (room.phase !== "question" || !room.q || room.q.closed) return;
  room.q.timeUp = true;
  if (room.settings.hostPlays) return closeQuestion(room, "time");      // التلقائي: الوقت يغلق السؤال
  broadcast(room);                                                       // بوجود مقدم: السؤال يبقى مفتوحاً حتى يقرر
}

function submitAnswer(room, p, text) {
  if (room.phase !== "question" || !canAnswer(room, p)) return { ok: false, reason: "closed" };
  text = clean(text, 30);
  if (!text) return { ok: false, reason: "empty" };
  const q = room.q, ms = Date.now() - q.startedAt;
  const ok = isAccepted(text, q.data);
  const wrongLetter = !ok && normalize(text)[0] !== letterKey(room.letter);
  q.answers.push({ pid: p.id, name: p.name, team: p.team, text, ok, ms, wrongLetter });
  if (ok) { award(room, p, ms, "answer"); }
  else { q.locked.add(p.id); maybeAllLocked(room); broadcast(room); }
  return { ok: true, correct: ok, wrongLetter };
}

function award(room, p, ms, how) {
  const q = room.q; if (!q || q.winner) return;
  p.score++;
  q.winner = { pid: p.id, name: p.name, team: p.team, ms };
  room.log.push({ letter: room.letter, q: q.data.q, a: q.data.a, winner: p.name, ms });
  closeQuestion(room, how);
}

function maybeAllLocked(room) {
  const eligible = [...room.players.values()].filter(p => (room.settings.mode !== "teams" || p.team != null)
    && (!room.tiebreak || room.tiebreak.among.includes(keyOf(room, p))));
  if (eligible.length && eligible.every(p => room.q.locked.has(p.id))) closeQuestion(room, "all-wrong");
}

function closeQuestion(room, how) {
  const q = room.q; if (!q || q.closed) return;
  q.closed = true; q.how = how;
  if (!q.winner) room.log.push({ letter: room.letter, q: q.data.q, a: q.data.a, winner: null });
  clearTimers(room);
  room.phase = "reveal";
  broadcast(room);
  if (room.tiebreak && q.winner) return later(room, 3500, () => finish(room, true));
  if (room.settings.hostPlays) later(room, 5000, () => nextQuestion(room));
}

function nextQuestion(room) {
  if (room.phase !== "reveal") return;
  if (room.tiebreak) {                                                     // كسر التعادل: يستمر حتى أول إجابة صحيحة
    room.qi++;
    if (!room.queue[room.qi]) return toBoard(room);
    return showQuestion(room);
  }
  room.qi++;
  showQuestion(room);
}

function endLetter(room) {
  clearTimers(room);
  room.phase = "round"; room.q = null;
  broadcast(room);
  if (room.settings.hostPlays) later(room, 6000, () => toBoard(room));
}

function finish(room, afterTie) {
  clearTimers(room);
  const st = standings(room);
  const top = st.length ? st[0].score : 0;
  const leaders = st.filter(s => s.score === top);
  if (!afterTie && leaders.length > 1 && availableLetters(room).length) {
    room.tiebreak = { among: leaders.map(s => s.key) };
    room.phase = "tie"; room.q = null;
    broadcast(room);
    if (room.settings.hostPlays) later(room, 5000, () => toBoard(room));
    return;
  }
  room.phase = "final"; room.q = null;
  room.final = { standings: st, tie: leaders.length > 1 };
  broadcast(room);
}

function backToLobby(room) {
  clearTimers(room);
  room.players.forEach(p => { p.score = 0; });
  Object.assign(room, { phase: "lobby", usedLetters: [], round: 0, letter: null, picked: null, queue: [], qi: 0, q: null, tiebreak: null, final: null, log: [] });
  broadcast(room);
}

/* ==================== ما يراه كل طرف ==================== */
function view(room, who) {
  const isHost = who.role === "host";
  const me = who.pid ? room.players.get(who.pid) : null;
  const q = room.q;
  const showAnswer = isHost && !room.settings.hostPlays;                // المقدم غير المشارك يرى الإجابة
  const revealed = room.phase === "reveal" && q;
  return {
    code: room.code, phase: room.phase, now: Date.now(),
    role: who.role, isHost, hostPlays: room.settings.hostPlays,
    settings: room.settings, teamColors: TEAM_COLORS,
    players: room.order.map(id => room.players.get(id)).filter(Boolean)
      .map(p => ({ id: p.id, name: p.name, team: p.team, score: p.score, online: p.sockets.size > 0 })),
    standings: standings(room),
    me: me ? { id: me.id, name: me.name, team: me.team, score: me.score, canAnswer: canAnswer(room, me),
               locked: q ? q.locked.has(me.id) : false, isHostPlayer: !!me.isHostPlayer } : null,
    board: { used: room.usedLetters, picked: room.picked, counts: BANK_COUNTS },
    round: room.round, rounds: room.settings.rounds, letter: room.letter,
    tiebreak: room.tiebreak,
    question: q ? {
      index: room.qi + 1, total: room.queue.length, text: q.data.q,
      deadline: q.deadline, startedAt: q.startedAt, timeUp: q.timeUp, closed: q.closed,
      answers: q.answers.map(a => ({ name: a.name, team: a.team, text: a.text, ok: a.ok, ms: a.ms, wrongLetter: a.wrongLetter, pid: a.pid })),
      winner: q.winner, how: q.how,
      answer: (showAnswer || revealed) ? q.data.a : null,
      alt: (showAnswer || revealed) ? (q.data.alt || []) : null,
      note: revealed ? (q.data.note || "") : null,
      cat: showAnswer ? q.data.cat : null, level: showAnswer ? q.data.level : null,
    } : null,
    roundScores: room.phase === "round" ? standings(room).map(s => ({ ...s, delta: s.score - (room.roundStart[s.key] || 0) })) : null,
    final: room.final, log: room.phase === "final" ? room.log : null,
  };
}
function broadcast(room) {
  room.lastActive = Date.now();
  const sockets = io.sockets.adapter.rooms.get("r" + room.code);
  if (!sockets) return;
  for (const sid of sockets) { const s = io.sockets.sockets.get(sid); if (s && s.data.code === room.code) s.emit("state", view(room, s.data)); }
}

/* ==================== الخادم ==================== */
const app = express();
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get("/qr.svg", async (req, res) => {
  try {
    const svg = await QRCode.toString(String(req.query.t || "").slice(0, 300), { type: "svg", margin: 1, color: { dark: "#14202E", light: "#FFFFFF" } });
    res.type("image/svg+xml").send(svg);
  } catch { res.status(400).end(); }
});
app.get("/health", (_, res) => res.json({ ok: true, rooms: rooms.size, questions: Object.values(BANK_COUNTS).reduce((a, b) => a + b, 0) }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, pingInterval: 10000, pingTimeout: 20000 });

function attach(socket, room, data) {
  socket.data = { code: room.code, ...data };
  socket.join("r" + room.code);
}
function roomOf(socket) { return socket.data && rooms.get(socket.data.code); }

io.on("connection", socket => {
  socket.data = {};
  const reply = (cb, x) => typeof cb === "function" && cb(x);

  socket.on("create", ({ settings, usage, hostName } = {}, cb) => {
    const room = createRoom(settings, usage);
    room.hostSockets.add(socket.id);
    let pid = null, ptoken = null;
    if (room.settings.hostPlays) {                                         // المقدم يلعب: يُضاف لاعباً
      const p = { id: token().slice(0, 8), token: token(), name: clean(hostName) || "المقدم", team: null, score: 0, sockets: new Set([socket.id]), isHostPlayer: true };
      room.players.set(p.id, p); room.order.push(p.id); pid = p.id; ptoken = p.token;
    }
    attach(socket, room, { role: "host", pid });
    reply(cb, { ok: true, code: room.code, hostToken: room.hostToken, playerToken: ptoken });
    broadcast(room);
  });

  socket.on("join", ({ code, name, team, playerToken, hostToken, tv } = {}, cb) => {
    const room = rooms.get(String(code || "").trim());
    if (!room) return reply(cb, { ok: false, error: "الغرفة غير موجودة. تأكد من الرمز." });
    if (tv) { attach(socket, room, { role: "tv" }); reply(cb, { ok: true }); return broadcast(room); }
    if (hostToken && hostToken === room.hostToken) {                       // عودة المقدم بعد انقطاع
      room.hostSockets.add(socket.id);
      const hp = [...room.players.values()].find(p => p.isHostPlayer);
      if (hp) hp.sockets.add(socket.id);
      attach(socket, room, { role: "host", pid: hp ? hp.id : null });
      reply(cb, { ok: true, role: "host" }); return broadcast(room);
    }
    let p = playerToken && [...room.players.values()].find(x => x.token === playerToken);
    if (p) { p.sockets.add(socket.id); attach(socket, room, { role: "player", pid: p.id }); reply(cb, { ok: true, role: "player", playerToken: p.token }); return broadcast(room); }
    name = clean(name);
    if (!name) return reply(cb, { ok: false, error: "اكتب اسمك." });
    if (room.phase !== "lobby") return reply(cb, { ok: false, error: "بدأت اللعبة. اطلب من المقدم إعادة الجولة أو انتظر اللعبة القادمة." });
    if ([...room.players.values()].some(x => x.name === name)) return reply(cb, { ok: false, error: "هذا الاسم مستخدم في الغرفة. اختر اسماً آخر." });
    if (room.players.size >= 40) return reply(cb, { ok: false, error: "الغرفة ممتلئة." });
    const t = room.settings.mode === "teams" && room.settings.teamPick === "choose" && Number.isInteger(team) && room.settings.teams[team] ? team : null;
    p = { id: token().slice(0, 8), token: token(), name, team: t, score: 0, sockets: new Set([socket.id]) };
    room.players.set(p.id, p); room.order.push(p.id);
    attach(socket, room, { role: "player", pid: p.id });
    reply(cb, { ok: true, role: "player", playerToken: p.token });
    broadcast(room);
  });

  socket.on("chooseTeam", team => {
    const room = roomOf(socket); if (!room || room.phase !== "lobby") return;
    const p = room.players.get(socket.data.pid); if (!p || !room.settings.teams[team]) return;
    if (room.settings.teamPick !== "choose" && !room.hostSockets.has(socket.id)) return;
    p.team = team; broadcast(room);
  });

  socket.on("answer", (text, cb) => {
    const room = roomOf(socket); if (!room) return reply(cb, { ok: false });
    reply(cb, submitAnswer(room, room.players.get(socket.data.pid), text));
  });

  // أوامر المقدم
  socket.on("host", ({ cmd, arg } = {}, cb) => {
    const room = roomOf(socket);
    if (!room || !room.hostSockets.has(socket.id)) return reply(cb, { ok: false });
    switch (cmd) {
      case "settings": if (room.phase === "lobby") { room.settings = sanitizeSettings(arg, room.settings);
                         if (room.settings.mode !== "teams") room.players.forEach(p => { p.team = null; });
                         room.players.forEach(p => { if (p.team != null && !room.settings.teams[p.team]) p.team = null; }); } break;
      case "start": if (room.phase === "lobby" && room.players.size >= (room.settings.hostPlays ? 2 : 1)) startGame(room); else return reply(cb, { ok: false, error: "تحتاج لاعباً واحداً على الأقل." }); break;
      case "pick": pickLetter(room, arg); break;
      case "close": if (room.phase === "question") closeQuestion(room, "host"); break;
      case "accept": if (room.phase === "question" || (room.phase === "reveal" && room.q && !room.q.winner)) {   // اعتماد إجابة رآها النظام خاطئة
                       const a = room.q.answers.find(x => x.pid === arg && !x.ok); const p = a && room.players.get(a.pid);
                       if (p) { if (room.phase === "reveal") room.log.pop();        // يُستبدل سطر «بلا نقطة» في السجل
                                a.ok = true; a.accepted = true; room.q.closed = false; room.phase = "question"; award(room, p, a.ms, "host-accept"); } } break;
      case "next": if (room.phase === "reveal") nextQuestion(room); else if (room.phase === "round" || room.phase === "tie") toBoard(room); break;
      case "skipLetter": if (room.phase === "question" || room.phase === "reveal") endLetter(room); break;
      case "end": finish(room); break;
      case "lobby": backToLobby(room); break;
      case "kick": if (room.phase === "lobby" && room.players.has(arg) && !room.players.get(arg).isHostPlayer) {
                     const p = room.players.get(arg); p.sockets.forEach(sid => { const s = io.sockets.sockets.get(sid); if (s) { s.emit("kicked"); s.leave("r" + room.code); s.data = {}; } });
                     room.players.delete(arg); room.order = room.order.filter(x => x !== arg); } break;
      case "adjust": { const p = room.players.get(arg && arg.pid); if (p) p.score = Math.max(0, p.score + (arg.delta > 0 ? 1 : -1)); } break;
      default: return reply(cb, { ok: false });
    }
    reply(cb, { ok: true }); broadcast(room);
  });

  socket.on("leave", () => {
    const room = roomOf(socket); if (!room) return;
    const p = room.players.get(socket.data.pid);
    if (p && room.phase === "lobby" && !p.isHostPlayer) { room.players.delete(p.id); room.order = room.order.filter(x => x !== p.id); }
    socket.leave("r" + room.code); room.hostSockets.delete(socket.id); if (p) p.sockets.delete(socket.id); socket.data = {};
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = roomOf(socket); if (!room) return;
    room.hostSockets.delete(socket.id);
    const p = room.players.get(socket.data.pid); if (p) p.sockets.delete(socket.id);
    broadcast(room);
  });
});

// تنظيف الغرف الخاملة (6 ساعات)
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [code, r] of rooms) if (r.lastActive < cutoff) { clearTimers(r); rooms.delete(code); }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
if (require.main === module) server.listen(PORT, () => console.log(`مسابقة الحروف تعمل على المنفذ ${PORT} — ${Object.values(BANK_COUNTS).reduce((a, b) => a + b, 0)} سؤالاً`));
module.exports = { server, io, rooms, normalize, isAccepted, pickQuestions };
