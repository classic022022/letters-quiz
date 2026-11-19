/* مسابقة الحروف — واجهة الجوال والتلفاز */
"use strict";
const LETTERS = ["أ","ب","ت","ث","ج","ح","خ","د","ذ","ر","ز","س","ش","ص","ض","ط","ظ","ع","غ","ف","ق","ك","ل","م","ن","هـ","و","ي"];
const $ = s => document.querySelector(s);
const app = $("#app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
function toast(m, ms = 2200) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms); }

const params = new URLSearchParams(location.search);
const TV = params.get("tv") === "1";
const URL_ROOM = (params.get("room") || "").replace(/\D/g, "").slice(0, 4);
if (TV) document.body.classList.add("tv");

let sess = store.get("lq-session", null);           // {code, hostToken?, playerToken?}
let usage = store.get("lq-usage", {});              // سجل تدوير الأسئلة على جهاز المقدم
let soundOn = store.get("lq-sound", true);
let st = null, offset = 0, ui = "home", built = "", tickT = null, lastPicked = null, mySent = null;

/* ==================== أصوات ==================== */
let actx = null;
function beep(f, d = .12, type = "sine", v = .14) {
  if (!soundOn) return;
  try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = f; g.gain.value = v; o.connect(g); g.connect(actx.destination); o.start();
    g.gain.exponentialRampToValueAtTime(.001, actx.currentTime + d); o.stop(actx.currentTime + d); } catch {}
}

/* ==================== الاتصال ==================== */
const socket = io({ transports: ["websocket", "polling"] });

/* شريط حالة الاتصال: يظهر إذا تأخر الاتصال أكثر من ثانية ونصف (مثلاً الخادم يستيقظ) */
const net = document.createElement("div"); net.className = "net"; net.setAttribute("role", "status"); net.hidden = true; document.body.appendChild(net);
let netT = null, netTick = null, netSince = 0, wasConnected = false;
function netDown() {
  if (netT || netTick) return;
  netSince = Date.now();
  netT = setTimeout(() => {
    netT = null; net.hidden = false;
    const up = () => { const s = Math.round((Date.now() - netSince) / 1000);
      net.textContent = (wasConnected ? "⏳ انقطع الاتصال… جارٍ إعادة الاتصال" : "⏳ جارٍ الاتصال بالخادم…") + ` (${s} ث)`
        + (s >= 8 ? " — قد يستغرق حتى دقيقة إذا كانت اللعبة غير مستخدمة منذ مدة. لا تُغلق الصفحة، ونتائج الغرفة محفوظة." : ""); };
    up(); netTick = setInterval(up, 1000);
  }, 1500);
}
function netUp() {
  clearTimeout(netT); clearInterval(netTick); netT = netTick = null;
  if (!net.hidden) { net.hidden = true; if (wasConnected) toast("✅ عاد الاتصال"); }
  wasConnected = true;
}
netDown();
socket.on("connect_error", netDown);
const call = (ev, ...a) => new Promise(r => socket.emit(ev, ...a, r));
const hostCmd = (cmd, arg) => call("host", { cmd, arg }).then(r => { if (r && !r.ok && r.error) toast(r.error); return r; });

socket.on("connect", async () => {
  netUp();
  if (TV && URL_ROOM) { const r = await call("join", { code: URL_ROOM, tv: true }); if (!r.ok) { st = null; ui = "tvmissing"; render(); } return; }
  if (sess && sess.code && (!URL_ROOM || URL_ROOM === sess.code)) {
    const r = await call("join", { code: sess.code, hostToken: sess.hostToken, playerToken: sess.playerToken });
    if (!r.ok) { toast("انتهت الغرفة السابقة."); leave(true); }
  }
});
socket.on("disconnect", netDown);
socket.on("state", s => { offset = s.now - Date.now(); const prev = st; st = s; onChange(prev, s); render(); });
socket.on("used", id => { usage[id] = (usage[id] || 0) + 1; store.set("lq-usage", usage); });
socket.on("kicked", () => { toast("أخرجك المقدم من الغرفة."); leave(true); });

function onChange(prev, s) {
  if (!prev) return;
  const pq = prev.question, q = s.question;
  if (q && pq && q.index === pq.index && q.answers.length > pq.answers.length) {
    const a = q.answers[q.answers.length - 1]; beep(a.ok ? 880 : 240, .14, a.ok ? "triangle" : "sawtooth", .08);
  }
  if (s.phase === "reveal" && prev.phase !== "reveal") beep(q && q.winner ? 1175 : 330, .3, "triangle");
  if (s.phase === "final" && prev.phase !== "final") { beep(784, .2); setTimeout(() => beep(1047, .35), 200); }
}

function leave(silent) {
  if (!silent) socket.emit("leave");
  sess = null; store.del("lq-session"); st = null; built = ""; ui = "home";
  history.replaceState(null, "", location.pathname);
  render();
}
const joinURL = code => `${location.origin}/?room=${code}`;
const tvURL = code => `${location.origin}/?room=${code}&tv=1`;

/* ==================== أدوات العرض ==================== */
const teamColor = i => (st && st.teamColors[i]) || "#888";
const teamName = i => (st && st.settings.teams[i] ? st.settings.teams[i].name : "");
function header(extra = "") {
  const me = st && st.me;
  return `<div class="top">
    <div class="brand"><div class="mark">ح</div>${st ? `<div class="room">غرفة ${st.code}<small class="hint">مسابقة الحروف</small></div>` : `<div><h1>مسابقة الحروف</h1><small>اختر حرفاً، اعرف الإجابة، وكن الأسرع</small></div>`}</div>
    <div class="row" style="gap:6px">${extra}
      ${me ? `<span class="chip">${me.team != null && st.settings.mode === "teams" ? `<span class="dot" style="background:${teamColor(me.team)}"></span>` : ""}<b>${esc(me.name)}</b> · ${me.score}</span>` : ""}
      <button class="btn small ghost" id="b-sound" aria-label="الصوت">${soundOn ? "🔊" : "🔇"}</button>
      ${st ? `<button class="btn small ghost" id="b-leave">خروج</button>` : ""}
    </div></div>`;
}
function wireHeader() {
  const s = $("#b-sound"); if (s) s.onclick = () => { soundOn = !soundOn; store.set("lq-sound", soundOn); s.textContent = soundOn ? "🔊" : "🔇"; };
  const l = $("#b-leave"); if (l) l.onclick = () => { if (confirm(st && st.isHost ? "الخروج يترك الغرفة بلا مقدم. متأكد؟" : "تغادر الغرفة؟")) leave(); };
}
function scoresHTML(list, opts = {}) {
  const top = list.length ? list[0].score : 0; let rank = 0, prev = null;
  return `<div class="scores">${list.map((s, i) => { if (s.score !== prev) { rank = i + 1; prev = s.score; }
    const mine = st.me && (s.key === st.me.id || (st.settings.mode === "teams" && s.key === "t" + st.me.team));
    return `<div class="sc${s.score === top && top > 0 ? " first" : ""}${mine ? " me" : ""}"><span class="rank">${rank}</span>
      ${s.color ? `<span class="dot" style="background:${s.color}"></span>` : ""}<span class="n">${esc(s.name)}${s.members && opts.members ? `<span class="hint" style="display:block;font-weight:400">${s.members.map(esc).join("، ") || "—"}</span>` : ""}</span>
      ${opts.delta && s.delta != null ? `<span class="d">+${s.delta}</span>` : ""}<span class="v">${s.score}</span></div>`; }).join("")}</div>`;
}
function feedHTML(q, hostAccept) {
  if (!q || !q.answers.length) return `<p class="hint" style="margin:0">لا إجابات بعد.</p>`;
  return `<div class="feed">${q.answers.slice().reverse().map(a => `<div class="fi ${a.ok ? "ok" : "no"}">
    <span class="mk">${a.ok ? "✔" : "✖"}</span><span class="who">${st.settings.mode === "teams" && a.team != null ? `<span class="dot" style="background:${teamColor(a.team)}"></span> ` : ""}${esc(a.name)}:</span>
    <span class="txt">${esc(a.text)}</span><span class="ms">${(a.ms / 1000).toFixed(1)}ث</span>
    ${hostAccept && !a.ok && !q.winner ? `<button class="btn small good" data-accept="${a.pid}">قبول</button>` : ""}</div>`).join("")}</div>`;
}
function wireAccept() { app.querySelectorAll("[data-accept]").forEach(b => b.onclick = () => hostCmd("accept", b.dataset.accept)); }
function timerHTML(q) { return q && q.deadline ? `<div class="timer"><i id="t-bar"></i></div>` : ""; }
function tick() {
  clearInterval(tickT);
  const q = st && st.question; if (!q || !q.deadline || st.phase !== "question") return;
  const total = q.deadline - q.startedAt;
  const paint = () => {
    const left = Math.max(0, q.deadline - (Date.now() + offset));
    const bar = $("#t-bar"), num = $("#t-num");
    if (bar) { bar.style.width = (left / total * 100) + "%"; bar.className = left < 4000 ? "over" : left < 8000 ? "warn" : ""; }
    if (num) num.textContent = left > 0 ? Math.ceil(left / 1000) : "⏱";
    if (left <= 0) clearInterval(tickT);
  };
  paint(); tickT = setInterval(paint, 200);
}
function boardHTML(clickable) {
  return `<div class="board">${LETTERS.map(l => { const used = st.board.used.includes(l), none = !st.board.counts[l];
    const tag = clickable && !used && !none ? "button" : "div";
    return `<${tag} class="tile${used || none ? " used" : ""}" data-l="${l}">${l}</${tag}>`; }).join("")}</div>`;
}
function animatePick() {
  if (!st.board.picked || lastPicked === st.code + st.board.picked + st.board.used.length) return markPicked();
  lastPicked = st.code + st.board.picked + st.board.used.length;
  const tiles = [...app.querySelectorAll(".tile:not(.used)")]; if (tiles.length < 2) return markPicked();
  let i = 0; const steps = 14 + Math.floor(Math.random() * 6);
  const t = setInterval(() => { tiles.forEach(x => x.classList.remove("spin")); tiles[i++ % tiles.length].classList.add("spin"); beep(500 + i * 25, .04, "square", .05);
    if (i >= steps) { clearInterval(t); tiles.forEach(x => x.classList.remove("spin")); markPicked(); beep(988, .25, "triangle"); } }, 85);
}
function markPicked() { app.querySelectorAll(".tile").forEach(x => x.classList.toggle("picked", x.dataset.l === st.board.picked)); }

/* ==================== الشاشات خارج الغرفة ==================== */
function render() {
  if (TV) return renderTV();
  if (!st) return renderOutside();
  const key = [st.phase, st.role, st.letter, st.question && st.question.index, st.board.picked, st.tiebreak ? 1 : 0, st.settings.mode, st.settings.teams.length, st.settings.hostPlays].join("|");
  const view = pickView();
  if (key !== built || !view.update) { built = key; view.build(); wireHeader(); }
  else view.update();
}

function renderOutside() {
  built = "";
  if (ui === "home" && URL_ROOM && !(sess && sess.code === URL_ROOM)) ui = "join";
  if (ui === "create") return renderCreate();
  if (ui === "join") return renderJoin();
  if (sess && sess.code) { app.innerHTML = `${header()}<div class="card stack" style="text-align:center"><p style="margin:0">جارٍ الاتصال بالغرفة <b>${esc(sess.code)}</b>…</p><button class="btn ghost" id="b-cancel">إلغاء</button></div>`;
    wireHeader(); $("#b-cancel").onclick = () => leave(true); return; }
  app.innerHTML = `${header()}
  <div class="hero"><div class="big">مسابقة الحروف</div><p>حرف عشوائي، وأسئلة إجاباتها تبدأ به. أسرع إجابة صحيحة تكسب النقطة — كلٌّ من جواله.</p></div>
  <div class="stack" style="margin-top:18px">
    <button class="btn primary block" id="b-create">🎙️ إنشاء غرفة جديدة</button>
    <div class="card stack">
      <label class="f" for="in-code">عندك رمز غرفة؟</label>
      <input id="in-code" class="code-in" type="tel" inputmode="numeric" maxlength="4" placeholder="0000" autocomplete="off">
      <button class="btn block" id="b-go">انضمام</button>
    </div>
    <p class="hint" style="text-align:center;margin:0">📩 وصلك رابط من صاحب الغرفة؟ افتحه مباشرة أو اكتب الرمز هنا — <b>شخص واحد فقط</b> ينشئ الغرفة والباقي ينضمون.</p>
  </div>`;
  wireHeader();
  $("#b-create").onclick = () => { ui = "create"; render(); };
  const go = () => { const c = $("#in-code").value.replace(/\D/g, ""); if (c.length !== 4) return toast("الرمز من 4 أرقام"); history.replaceState(null, "", "?room=" + c); ui = "join"; joinCode = c; render(); };
  $("#b-go").onclick = go; $("#in-code").onkeydown = e => { if (e.key === "Enter") go(); };
}

let joinCode = "";
function renderJoin() {
  const code = URL_ROOM || joinCode;
  app.innerHTML = `${header()}
  <div class="card stack">
    <div><div class="eyebrow">الانضمام إلى الغرفة</div><div class="code" style="font-size:38px;margin-top:4px">${esc(code)}</div></div>
    <div><label class="f" for="in-name">اسمك</label><input id="in-name" type="text" maxlength="20" placeholder="مثال: أبو عبدالرحمن" value="${esc(store.get("lq-name", ""))}" autocomplete="nickname"></div>
    <button class="btn primary block" id="b-join">دخول</button>
    <button class="btn ghost block" id="b-back">رجوع</button>
  </div>`;
  wireHeader();
  const join = async () => {
    const name = $("#in-name").value.trim(); if (!name) return toast("اكتب اسمك");
    $("#b-join").disabled = true;
    const r = await call("join", { code, name });
    $("#b-join").disabled = false;
    if (!r.ok) return toast(r.error || "تعذر الدخول");
    store.set("lq-name", name); sess = { code, playerToken: r.playerToken }; store.set("lq-session", sess);
  };
  $("#b-join").onclick = join; $("#in-name").onkeydown = e => { if (e.key === "Enter") join(); };
  $("#b-back").onclick = () => { history.replaceState(null, "", location.pathname); ui = "home"; joinCode = ""; render(); };
  setTimeout(() => $("#in-name").focus(), 50);
}

let draft = store.get("lq-settings", { mode: "players", teams: [{ name: "الفريق الأول" }, { name: "الفريق الثاني" }], teamPick: "choose", rounds: 5, perLetter: 10, time: 25, hostPlays: false, local: false });
function settingsForm(s, lobby) {
  return `<div class="stack">
    ${lobby ? "" : `<div><span class="f">طريقة اللعب</span><div class="choice">
      <label><input type="radio" name="lc" value="0" ${!s.local ? "checked" : ""}><span><b>📱 كل لاعب من جواله (عن بعد)</b><small>ترسل رابط الغرفة، وكل واحد يدخل ويجاوب من جواله. أسرع إجابة صحيحة تكسب.</small></span></label>
      <label><input type="radio" name="lc" value="1" ${s.local ? "checked" : ""}><span><b>🖥️ من جهازي فقط وأعرض لهم</b><small>أنت تعرض السؤال على شاشتك أو التلفاز، وهم يجاوبون بصوتهم، وأنت تضغط على اسم أول من أجاب صح.</small></span></label>
    </div></div>`}
    ${lobby || s.local ? "" : `<div><span class="f">دورك في اللعبة</span><div class="choice">
      <label><input type="radio" name="hp" value="0" ${!s.hostPlays ? "checked" : ""}><span><b>🎙️ أنا المقدم فقط</b><small>أرى الإجابات، أختار الحروف، وأستطيع اعتماد إجابة كتبها لاعب بصيغة مختلفة.</small></span></label>
      <label><input type="radio" name="hp" value="1" ${s.hostPlays ? "checked" : ""}><span><b>🙋 ألعب معهم</b><small>بدون مقدم: الحروف تُختار والأسئلة تتقدم تلقائياً، ولا أحد يرى الإجابة قبل وقتها.</small></span></label>
    </div></div>
    <div id="hp-name" ${s.hostPlays ? "" : "hidden"}><label class="f" for="s-hname">اسمك في اللعبة</label><input id="s-hname" type="text" maxlength="20" value="${esc(store.get("lq-name", ""))}"></div>`}
    <div><span class="f">المشاركون</span><div class="seg" id="s-mode"><button data-v="players" class="${s.mode === "players" ? "on" : ""}">كلٌّ لنفسه</button><button data-v="teams" class="${s.mode === "teams" ? "on" : ""}">فرق</button></div></div>
    <div id="s-teams" class="stack" ${s.mode === "teams" ? "" : "hidden"}>
      <div class="stack" id="s-tnames">${s.teams.map((t, i) => `<div class="row" style="flex-wrap:nowrap"><span class="dot" style="background:${["#0F8B8D","#D9822B","#7A4FD1","#C23B5A"][i]};width:14px;height:14px"></span><input type="text" data-tn="${i}" maxlength="20" value="${esc(t.name)}">${i >= 2 ? `<button class="btn small ghost" data-trm="${i}">✕</button>` : ""}</div>`).join("")}</div>
      ${s.teams.length < 4 ? `<button class="btn small ghost" id="s-tadd">+ فريق</button>` : ""}
      ${s.local ? `<span class="hint">الفرق تتنافس من جهازك — تضغط على اسم الفريق اللي جاوب أول.</span>` : `<div class="seg" id="s-pick"><button data-v="choose" class="${s.teamPick === "choose" ? "on" : ""}">اللاعب يختار فريقه</button><button data-v="random" class="${s.teamPick === "random" ? "on" : ""}">توزيع عشوائي</button></div>`}
    </div>
    <div class="grid2">
      <div><label class="f" for="s-rounds">عدد الحروف (الجولات)</label><select id="s-rounds">${[3, 5, 10, 15, 28].map(n => `<option value="${n}" ${+s.rounds === n ? "selected" : ""}>${n === 28 ? "كل الحروف" : n}</option>`).join("")}</select></div>
      <div><label class="f" for="s-per">أسئلة كل حرف</label><input id="s-per" type="number" min="1" max="35" value="${s.perLetter}"></div>
    </div>
    <div><label class="f" for="s-time">وقت السؤال (ثانية)</label><input id="s-time" type="number" min="0" max="120" value="${s.time}">
      <span class="hint" id="s-time-h">${s.hostPlays ? "في وضع «ألعب معهم» ينتهي السؤال تلقائياً بانتهاء الوقت." : "ضع 0 بلا مؤقت. انتهاء الوقت لا يغلق السؤال؛ أنت من يغلقه."}</span></div>
  </div>`;
}
function readForm(base) {
  const s = JSON.parse(JSON.stringify(base));
  const lc = app.querySelector('input[name="lc"]:checked'); if (lc) s.local = lc.value === "1";
  const hp = app.querySelector('input[name="hp"]:checked'); if (hp) s.hostPlays = hp.value === "1";
  if (s.local) s.hostPlays = false;
  app.querySelectorAll("[data-tn]").forEach(i => { s.teams[+i.dataset.tn].name = i.value.trim() || `فريق ${+i.dataset.tn + 1}`; });
  s.rounds = +$("#s-rounds").value; s.perLetter = +$("#s-per").value || 10; s.time = Math.max(0, +$("#s-time").value || 0);
  return s;
}
function wireForm(get, set, onChange) {
  const re = () => { set(readForm(get())); onChange(true); };
  app.querySelectorAll('input[name="hp"],input[name="lc"]').forEach(r => r.onchange = re);
  $("#s-mode").onclick = e => { const v = e.target.dataset.v; if (!v) return; const s = readForm(get()); s.mode = v; set(s); onChange(true); };
  const pk = $("#s-pick"); if (pk) pk.onclick = e => { const v = e.target.dataset.v; if (!v) return; const s = readForm(get()); s.teamPick = v; set(s); onChange(true); };
  const ad = $("#s-tadd"); if (ad) ad.onclick = () => { const s = readForm(get()); s.teams.push({ name: `فريق ${s.teams.length + 1}` }); set(s); onChange(true); };
  app.querySelectorAll("[data-trm]").forEach(b => b.onclick = () => { const s = readForm(get()); s.teams.splice(+b.dataset.trm, 1); set(s); onChange(true); });
  app.querySelectorAll("#s-rounds,#s-per,#s-time,[data-tn]").forEach(i => i.onchange = () => { set(readForm(get())); onChange(false); });
}
function renderCreate() {
  app.innerHTML = `${header()}<div class="card stack"><div><div class="eyebrow">غرفة جديدة</div><h2 style="font-size:22px">إعداد اللعبة</h2></div>
    <div id="form">${settingsForm(draft, false)}</div>
    <button class="btn primary block" id="b-make">إنشاء الغرفة ←</button><button class="btn ghost block" id="b-back">رجوع</button></div>`;
  wireHeader();
  wireForm(() => draft, s => { draft = s; store.set("lq-settings", draft); }, rebuild => { if (rebuild) renderCreate(); });
  $("#b-back").onclick = () => { ui = "home"; render(); };
  $("#b-make").onclick = async () => {
    draft = readForm(draft); store.set("lq-settings", draft);
    const hostName = $("#s-hname") ? $("#s-hname").value.trim() : "";
    if (draft.hostPlays && !hostName) return toast("اكتب اسمك في اللعبة");
    if (hostName) store.set("lq-name", hostName);
    $("#b-make").disabled = true;
    const r = await call("create", { settings: draft, usage, hostName });
    if (!r.ok) { $("#b-make").disabled = false; return toast("تعذر إنشاء الغرفة"); }
    sess = { code: r.code, hostToken: r.hostToken, playerToken: r.playerToken }; store.set("lq-session", sess);
    history.replaceState(null, "", "?room=" + r.code);
  };
}

/* ==================== داخل الغرفة ==================== */
const hostControls = () => st.isHost && !st.hostPlays;
function pickView() {
  switch (st.phase) {
    case "lobby": return lobbyView;
    case "board": return boardView;
    case "question": return questionView;
    case "reveal": return revealView;
    case "round": return roundView;
    case "tie": return tieView;
    case "final": return finalView;
  }
  return lobbyView;
}

function localCard() {
  const teams = st.settings.mode === "teams";
  return `<div class="card stack"><div><div class="eyebrow">🖥️ اللعب من جهازك</div><h3 style="margin:4px 0 0">${teams ? "الفرق جاهزة" : "أضف أسماء اللاعبين"}</h3>
    <div class="hint">${teams ? "عدّل أسماء الفرق وعددها من الإعدادات تحت." : "اكتب اسم كل لاعب واضغط إضافة. يحتاج لاعبين على الأقل."} اعرض شاشتك عليهم، وإذا جاوب أحد صح اضغط على اسمه.</div></div>
    ${teams ? "" : `<form class="ansbox" id="l-add" autocomplete="off"><input id="l-name" type="text" maxlength="20" placeholder="اسم اللاعب"><button class="btn primary">إضافة</button></form>`}
    <details><summary class="hint" style="cursor:pointer">📺 عرضها على شاشة ثانية أو التلفاز (اختياري)</summary><p class="hint" style="margin:6px 0">افتح هذا الرابط في التلفاز ليظهر السؤال والنتائج، وتبقى الإجابة عندك فقط:</p>
      <div class="row"><code style="direction:ltr;font-size:13px;word-break:break-all">${esc(tvURL(st.code))}</code><button class="btn small" id="b-tvl">نسخ</button></div></details></div>`;
}
const lobbyView = {
  build() {
    const host = st.isHost;
    app.innerHTML = `${header()}<div class="stack">
      ${host && st.settings.local ? localCard() : ""}
      ${host && !st.settings.local ? `<div class="card stack">
        <div class="codebox"><div><div class="eyebrow">رمز الغرفة</div><div class="code">${st.code}</div><div class="hint">شارك الرابط، ومن يفتحه يكتب اسمه فقط.</div></div>
          <img class="qr" src="/qr.svg?t=${encodeURIComponent(joinURL(st.code))}" alt="رمز QR للانضمام"></div>
        <div class="grid2"><a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`🔤 تعال العب «مسابقة الحروف»\nرمز الغرفة: ${st.code}\n${joinURL(st.code)}`)}">إرسال بالواتساب</a>
          <button class="btn" id="b-copy">نسخ الرابط</button></div>
        <details><summary class="hint" style="cursor:pointer">📺 عرضها على التلفاز</summary><p class="hint" style="margin:6px 0">افتح هذا الرابط في متصفح التلفاز أو أي جهاز متصل به — لا يحتاج تسجيل دخول:</p>
          <div class="row"><code style="direction:ltr;font-size:13px;word-break:break-all">${esc(tvURL(st.code))}</code><button class="btn small" id="b-tv">نسخ</button></div></details>
      </div>` : ""}
      ${host ? `<div class="card stack"><div class="row between"><h3>الإعدادات</h3><span class="hint">تُحفظ تلقائياً</span></div><div id="form">${settingsForm(st.settings, true)}</div></div>` : ""}
      <div class="card stack" id="who"></div>
      ${host ? `<button class="btn primary block" id="b-start">ابدأ اللعبة ←</button>` : ""}
    </div>`;
    if (host) {
      if ($("#l-add")) $("#l-add").onsubmit = async e => { e.preventDefault(); const i = $("#l-name"), v = i.value.trim(); if (!v) return;
        const r = await call("host", { cmd: "addLocal", arg: v }); if (r && r.ok) { i.value = ""; i.focus(); } else toast((r && r.error) || "تعذّرت الإضافة"); };
      if ($("#b-tvl")) $("#b-tvl").onclick = () => navigator.clipboard.writeText(tvURL(st.code)).then(() => toast("نُسخ رابط الشاشة"), () => toast(tvURL(st.code), 5000));
      if ($("#b-copy")) $("#b-copy").onclick = () => navigator.clipboard.writeText(joinURL(st.code)).then(() => toast("نُسخ الرابط"), () => toast(joinURL(st.code), 5000));
      if ($("#b-tv")) $("#b-tv").onclick = () => navigator.clipboard.writeText(tvURL(st.code)).then(() => toast("نُسخ رابط التلفاز"), () => {});
      let cur = st.settings;
      wireForm(() => cur, s => { cur = s; }, () => { store.set("lq-settings", { ...cur, hostPlays: st.settings.hostPlays }); hostCmd("settings", cur); });
      $("#b-start").onclick = () => hostCmd("start");
    }
    this.update();
  },
  update() {
    const box = $("#who"); if (!box) return;
    const ps = st.players, s = st.settings, me = st.me;
    let html = "";
    if (me && s.mode === "teams" && s.teamPick === "choose") {
      html += `<div><div class="eyebrow">اختر فريقك</div><div class="teampick" style="margin-top:8px">${s.teams.map((t, i) =>
        `<button data-team="${i}" class="${me.team === i ? "on" : ""}" style="${me.team === i ? `background:${teamColor(i)};border-color:${teamColor(i)}` : `border-color:${teamColor(i)}`}">${esc(t.name)}</button>`).join("")}</div></div>`;
    }
    if (!st.isHost) html += `<div class="status wait">✅ أنت في الغرفة. بانتظار المقدم ليبدأ…</div>`;
    html += `<div class="row between"><h3>اللاعبون (${ps.length})</h3>${s.mode === "teams" && s.teamPick === "random" ? `<span class="hint">التوزيع عشوائي عند البدء</span>` : ""}</div>`;
    if (s.mode === "teams" && s.teamPick === "choose") {
      html += `<div class="teams">${s.teams.map((t, i) => `<div class="teamcol" style="border-color:${teamColor(i)}"><h3><span class="dot" style="background:${teamColor(i)}"></span>${esc(t.name)}</h3>
        <div class="m">${ps.filter(p => p.team === i).map(p => esc(p.name)).join("، ") || "—"}</div></div>`).join("")}</div>`;
      const none = ps.filter(p => p.team == null); if (none.length) html += `<p class="hint" style="margin:0">لم يختاروا بعد: ${none.map(p => esc(p.name)).join("، ")}</p>`;
    } else {
      html += ps.length ? `<div class="plist">${ps.map(p => `<div class="pl${p.online || st.settings.local ? "" : " off"}"><span class="nm">${esc(p.name)}${me && p.id === me.id ? " (أنت)" : ""}</span>
        ${st.isHost && !(me && p.id === me.id) ? `<button class="btn small ghost" data-kick="${p.id}" aria-label="إخراج">✕</button>` : ""}</div>`).join("")}</div>`
        : `<p class="hint" style="margin:0">${st.settings.local ? "لم تُضف أحداً بعد." : "لم ينضم أحد بعد — أرسل الرابط."}</p>`;
    }
    box.innerHTML = html;
    box.querySelectorAll("[data-team]").forEach(b => b.onclick = () => socket.emit("chooseTeam", +b.dataset.team));
    box.querySelectorAll("[data-kick]").forEach(b => b.onclick = () => { if (confirm("إخراج هذا اللاعب؟")) hostCmd("kick", b.dataset.kick); });
    const sb = $("#b-start"); if (sb) { const need = Math.max(0, 2 - ps.length); sb.disabled = need > 0; const lc = st.settings.local; sb.textContent = need ? (lc ? `أضف ${need === 2 ? "لاعبَين" : "لاعباً آخر"} للبدء` : `بانتظار ${need === 2 ? "لاعبَين" : "لاعب آخر"} للبدء…`) : `ابدأ اللعبة (${ps.length} ${lc && s.mode === "teams" ? "فرق" : "لاعبين"}) ←`; }
  },
};

function qHead(sub) {
  const q = st.question;
  return `<div class="qhead"><div class="row"><div class="letter">${esc(st.letter)}</div><div><div class="eyebrow">${st.tiebreak ? `كسر التعادل — سؤال ${q.index}` : `الحرف ${st.round} من ${st.rounds} · السؤال ${q.index} من ${q.total}`}</div>
    <div class="hint">${sub || "الإجابة كلمة واحدة تبدأ بالحرف"}</div></div></div>${q.deadline && st.phase === "question" ? `<div class="tnum" id="t-num"></div>` : ""}</div>`;
}

const boardView = {
  build() {
    const can = hostControls();
    const title = st.tiebreak ? "كسر التعادل — حرف جديد" : `الحرف ${st.round + 1} من ${st.rounds}`;
    app.innerHTML = `${header()}<div class="card stack"><div class="row between"><div><div class="eyebrow">لوحة الحروف</div><h2 style="font-size:22px">${title}</h2></div>
      ${can && !st.board.picked ? `<button class="btn primary" id="b-spin">🎲 اختيار عشوائي</button>` : ""}</div>
      ${boardHTML(can && !st.board.picked)}
      <p class="hint" style="margin:0">${st.board.picked ? `حرف الجولة: <b>${esc(st.board.picked)}</b>` : can ? "أو اضغط على حرف لاختياره." : st.hostPlays ? "يُختار الحرف تلقائياً…" : "المقدم يختار الحرف…"}</p></div>
      <div class="card" style="margin-top:14px">${scoresHTML(st.standings)}</div>`;
    if (can) { const b = $("#b-spin"); if (b) b.onclick = () => hostCmd("pick"); app.querySelectorAll("button.tile").forEach(t => t.onclick = () => hostCmd("pick", t.dataset.l)); }
    animatePick();
  },
};

const questionView = {
  build() {
    const q = st.question, host = hostControls(), local = !!st.settings.local;
    app.innerHTML = `${header()}<div class="card stack">${qHead(local ? "اعرض السؤال عليهم — الإجابة كلمة تبدأ بالحرف" : "")}${timerHTML(q)}
      <p class="qtext">${esc(q.text)}</p>
      ${host && local ? `<div class="hostans"><div class="row between"><div class="hint">🔒 الإجابة مخفية</div><button class="btn small" id="b-show">👁 إظهار الإجابة</button></div>
        <div id="ans-box" hidden><div class="a">${esc(q.answer)}</div>${q.alt && q.alt.length ? `<div class="hint">مقبول أيضاً: ${q.alt.map(esc).join("، ")}</div>` : ""}</div></div>
        <div><b>من جاوب صح أول؟</b><div class="grid2" style="margin-top:8px">${st.players.filter(p => !st.tiebreak || st.tiebreak.among.includes(st.settings.mode === "teams" ? "t" + p.team : p.id)).map(p => `<button class="btn primary" data-give="${p.id}">✔ ${esc(p.name)}</button>`).join("")}</div></div>`
      : host ? `<div class="hostans"><div class="hint">🔒 الإجابة (لك فقط)</div><div class="a">${esc(q.answer)}</div>${q.alt && q.alt.length ? `<div class="hint">مقبول أيضاً: ${q.alt.map(esc).join("، ")}</div>` : ""}</div>` : ""}
      <div id="mine"></div>
      <div ${local ? "hidden" : ""}><div class="row between" style="margin-bottom:6px"><b>الإجابات</b><span class="hint" id="cnt"></span></div><div id="feed"></div></div>
    </div>
    <div class="card" style="margin-top:14px" id="sc"></div>
    ${host ? `<div class="hostbar"><button class="btn bad" id="b-close">${local ? "لا أحد جاوب ✖" : "إغلاق السؤال"}</button><button class="btn" id="b-skip">إنهاء الحرف</button></div>` : ""}`;
    if (host) {
      $("#b-close").onclick = () => hostCmd("close");
      if ($("#b-show")) $("#b-show").onclick = () => { const b = $("#ans-box"); b.hidden = !b.hidden; $("#b-show").textContent = b.hidden ? "👁 إظهار الإجابة" : "🙈 إخفاء الإجابة"; };
      app.querySelectorAll("[data-give]").forEach(b => b.onclick = () => { app.querySelectorAll("[data-give]").forEach(x => x.disabled = true); hostCmd("give", b.dataset.give); });
      $("#b-skip").onclick = () => { if (confirm("إنهاء أسئلة هذا الحرف والانتقال للنتيجة؟")) hostCmd("skipLetter"); };
    }
    mySent = null;
    this.mineBuilt = "";
    this.update(); tick();
  },
  update() {
    const q = st.question, me = st.me;
    $("#feed").innerHTML = feedHTML(q, hostControls()); wireAccept();
    $("#cnt").textContent = q.answers.length ? `${q.answers.length} محاولة` : "";
    $("#sc").innerHTML = scoresHTML(st.standings);
    const mine = $("#mine");
    let state = "none";
    if (me) state = me.canAnswer ? "input" : me.locked ? "locked" : st.tiebreak ? "watch" : "none";
    if (hostControls()) state = q.timeUp ? "hosttime" : "host";
    if (state === this.mineBuilt && state === "input") return;
    this.mineBuilt = state;
    if (state === "input") {
      mine.innerHTML = `<form class="ansbox" id="f-ans" autocomplete="off"><input id="in-ans" type="text" maxlength="30" placeholder="إجابتك تبدأ بحرف ${esc(st.letter)}…" enterkeyhint="send" autocapitalize="off"><button class="btn primary" id="b-send">إرسال</button></form>
        ${q.timeUp ? `<div class="status wait" style="margin-top:8px">انتهى الوقت — ما زال بإمكانك الإجابة حتى يغلقه المقدم</div>` : ""}`;
      const f = $("#f-ans"), inp = $("#in-ans");
      f.onsubmit = async e => {
        e.preventDefault(); const v = inp.value.trim(); if (!v) return;
        $("#b-send").disabled = true; mySent = v;
        const r = await call("answer", v);
        if (r && r.ok && !r.correct) toast(r.wrongLetter ? `«${v}» لا تبدأ بحرف ${st.letter}` : `«${v}» خاطئة`);
        if (r && !r.ok) { $("#b-send") && ($("#b-send").disabled = false); }
      };
      inp.focus();
    } else if (state === "locked") {
      const mineA = q.answers.filter(a => me && a.pid === me.id).pop();
      mine.innerHTML = `<div class="status bad">✖ ${mineA ? `«${esc(mineA.text)}» خاطئة` : "إجابتك خاطئة"} — انتظر السؤال التالي</div>`;
    } else if (state === "watch") {
      mine.innerHTML = `<div class="status wait">جولة كسر التعادل بين: ${st.standings.filter(s => st.tiebreak.among.includes(s.key)).map(s => esc(s.name)).join(" و ")}</div>`;
    } else if (state === "hosttime") {
      mine.innerHTML = `<div class="status wait">⏱ انتهى الوقت — السؤال مفتوح حتى تغلقه</div>`;
    } else mine.innerHTML = "";
  },
};

const revealView = {
  build() {
    const q = st.question, w = q.winner, host = hostControls();
    app.innerHTML = `${header()}<div class="card stack">${qHead("")}
      <p class="qtext" style="font-size:20px;color:var(--ink-2)">${esc(q.text)}</p>
      <div class="reveal ${w ? "" : "miss"} pop"><div class="a">${esc(q.answer)}</div>
        <div style="font-weight:700;margin-top:6px">${w ? `🏆 ${esc(w.name)}${st.settings.mode === "teams" && w.team != null ? ` (${esc(teamName(w.team))})` : ""} — ${(w.ms / 1000).toFixed(1)} ثانية` : q.how === "all-wrong" ? "أخطأ الجميع — لا نقطة" : q.how === "time" ? "⏱ انتهى الوقت — لا نقطة" : "لا نقطة"}</div>
        ${q.alt && q.alt.length ? `<div class="hint">مقبول أيضاً: ${q.alt.map(esc).join("، ")}</div>` : ""}${q.note ? `<div class="hint">${esc(q.note)}</div>` : ""}</div>
      ${q.answers.length ? `<div><b>الإجابات</b><div style="margin-top:6px">${feedHTML(q, host)}</div></div>` : ""}
    </div><div class="card" style="margin-top:14px">${scoresHTML(st.standings)}</div>
    ${host ? `<div class="hostbar"><button class="btn primary" id="b-next">${q.index < q.total || st.tiebreak ? "السؤال التالي ←" : "نتيجة الحرف ←"}</button></div>` : st.hostPlays ? `<p class="hint" style="text-align:center">ينتقل تلقائياً…</p>` : ""}`;
    wireAccept();
    if (host) $("#b-next").onclick = () => hostCmd("next");
  },
};

const roundView = {
  build() {
    app.innerHTML = `${header()}<div class="card stack"><div><div class="eyebrow">نهاية الحرف</div><h2 style="font-size:24px">نتائج حرف «${esc(st.letter)}»</h2></div>
      ${scoresHTML(st.roundScores, { delta: true, members: st.settings.mode === "teams" })}</div>
      ${hostControls() ? `<div class="hostbar"><button class="btn primary" id="b-next">${st.round >= st.rounds ? "النتيجة النهائية ←" : "الحرف التالي ←"}</button><button class="btn" id="b-end">إنهاء اللعبة</button></div>` : st.hostPlays ? `<p class="hint" style="text-align:center">الحرف التالي بعد لحظات…</p>` : ""}`;
    if (hostControls()) { $("#b-next").onclick = () => hostCmd("next"); $("#b-end").onclick = () => { if (confirm("إنهاء اللعبة الآن وإعلان النتيجة؟")) hostCmd("end"); }; }
  },
};

const tieView = {
  build() {
    const names = st.standings.filter(s => st.tiebreak.among.includes(s.key)).map(s => esc(s.name));
    app.innerHTML = `${header()}<div class="card stack winner"><div class="crown">⚖️</div><h2>تعادل!</h2>
      <p style="margin:0">بين ${names.join(" و ")}. جولة كسر تعادل بحرف جديد — أول إجابة صحيحة تحسم.</p></div>
      ${hostControls() ? `<div class="hostbar"><button class="btn primary" id="b-next">ابدأ كسر التعادل ←</button></div>` : ""}`;
    if (hostControls()) $("#b-next").onclick = () => hostCmd("next");
  },
};

const finalView = {
  build() {
    const f = st.final, top = f.standings[0];
    app.innerHTML = `${header()}<div class="card stack winner pop"><div class="crown">🏆</div>
      <h2>${f.tie ? "تعادل" : esc(top ? top.name : "")}</h2><p class="hint" style="margin:0">${f.tie ? "انتهت الحروف المتاحة والنتيجة متعادلة" : `الفائز بـ ${top ? top.score : 0} نقطة`}</p></div>
      <div class="card" style="margin-top:14px">${scoresHTML(f.standings, { members: st.settings.mode === "teams" })}</div>
      ${st.isHost ? `<div class="stack" style="margin-top:14px"><button class="btn primary block" id="b-again">لعبة جديدة بنفس اللاعبين</button>
        ${st.log ? `<details class="card"><summary style="cursor:pointer;font-weight:700">سجل الأسئلة (${st.log.length})</summary><div class="log">${st.log.map(l => `<div>[${esc(l.letter)}] ${esc(l.q)} ← <b>${esc(l.a)}</b> ${l.winner ? "— " + esc(l.winner) : "— بلا نقطة"}</div>`).join("")}</div></details>` : ""}</div>`
        : `<p class="hint" style="text-align:center;margin-top:14px">بانتظار المقدم لبدء لعبة جديدة…</p>`}`;
    if (st.isHost) $("#b-again").onclick = () => hostCmd("lobby");
  },
};

/* ==================== شاشة التلفاز ==================== */
function renderTV() {
  if (!URL_ROOM || ui === "tvmissing") {
    app.innerHTML = `<div class="tv-body"><div class="mark" style="width:12vh;height:12vh;font-size:7vh">ح</div><h2 style="font-size:5vh">مسابقة الحروف</h2>
      <p class="hint" style="font-size:2.6vh">${ui === "tvmissing" ? "الغرفة غير موجودة. افتح رابط التلفاز من شاشة المقدم." : "افتح رابط التلفاز من شاشة المقدم."}</p></div>`;
    return;
  }
  if (!st) { app.innerHTML = `<div class="tv-body"><p class="tv-sub">جارٍ الاتصال…</p></div>`; return; }
  const key = [st.phase, st.letter, st.question && st.question.index, st.board.picked].join("|");
  const q = st.question;
  const cards = (live) => `<div class="tv-scores">${st.standings.map((s, i) => `<div class="tv-card${i === 0 && s.score > 0 ? " lead" : ""}" style="${s.color ? `border-bottom:6px solid ${s.color}` : ""}"><span class="s">${s.score}</span><span class="n">${esc(s.name)}</span></div>`).join("")}</div>`;
  const top = (l, a, b) => `<div class="tv-top"><div class="row" style="gap:2vw"><div class="tv-letter">${esc(l)}</div><div><div class="tv-sub">${a}</div><div style="font-family:var(--display);font-weight:800;font-size:3.6vh">${b}</div></div></div><div class="tv-num" id="t-num"></div></div>`;
  const tvFeed = () => q && q.answers.length ? `<div class="tv-feed">${q.answers.slice(-12).map(a => `<div class="fi ${a.ok ? "ok" : "no"}"><span class="mk">${a.ok ? "✔" : "✖"}</span><b>${esc(a.name)}:</b> <span class="txt">${esc(a.text)}</span></div>`).join("")}</div>` : "";
  if (key === built && st.phase === "question") {                   // تحديث دون إعادة بناء (حتى لا يتقطع المؤقت)
    const f = $("#tv-feed"); if (f) f.innerHTML = tvFeed(); const c = $("#tv-cards"); if (c) c.innerHTML = cards(true); return;
  }
  built = key;
  let html = "";
  switch (st.phase) {
    case "lobby":
      html = `<div class="tv-body"><div class="tv-lobby"><img class="qr" src="/qr.svg?t=${encodeURIComponent(joinURL(st.code))}" alt="">
        <div style="text-align:start"><div class="tv-sub">امسح الرمز أو افتح الرابط، واكتب اسمك</div><div class="code">${st.code}</div><div class="tv-url">${esc(joinURL(st.code))}</div>
        <div class="tv-names">${st.players.map(p => `<span>${esc(p.name)}</span>`).join("") || `<span style="opacity:.6">بانتظار اللاعبين…</span>`}</div></div></div></div>`;
      break;
    case "board":
      html = top(st.board.picked || "؟", st.tiebreak ? "كسر التعادل" : "لوحة الحروف", st.board.picked ? `حرف الجولة: ${esc(st.board.picked)}` : "اختيار الحرف…") + `<div class="tv-body">${boardHTML(false)}</div>` + `<div id="tv-cards">${cards()}</div>`;
      break;
    case "question":
      html = top(st.letter, st.tiebreak ? `كسر التعادل — سؤال ${q.index}` : `الحرف ${st.round} من ${st.rounds} · السؤال ${q.index} من ${q.total}`, "الإجابة كلمة واحدة تبدأ بالحرف")
        + `<div class="tv-body"><p class="tv-q">${esc(q.text)}</p>${timerHTML(q)}<div id="tv-feed">${tvFeed()}</div></div><div id="tv-cards">${cards(true)}</div>`;
      break;
    case "reveal":
      html = top(st.letter, `السؤال ${q.index} من ${q.total}`, "") + `<div class="tv-body"><p class="tv-q" style="font-size:4vh;opacity:.75">${esc(q.text)}</p><p class="tv-a pop">${esc(q.answer)}</p>
        <div style="font-size:3.4vh;font-weight:700">${q.winner ? `🏆 ${esc(q.winner.name)} — ${(q.winner.ms / 1000).toFixed(1)} ث` : "لا نقطة"}</div></div><div id="tv-cards">${cards()}</div>`;
      break;
    case "round": case "final": case "tie": {
      const list = st.phase === "round" ? st.roundScores : st.phase === "final" ? st.final.standings : st.standings;
      const title = st.phase === "round" ? `نتائج حرف «${esc(st.letter)}»` : st.phase === "tie" ? "⚖️ تعادل — جولة كسر تعادل" : (st.final.tie ? "تعادل" : `🏆 ${esc(list[0].name)}`);
      html = `<div class="tv-body"><h2 style="font-size:6vh">${title}</h2><div style="width:min(900px,92%);font-size:3vh">${scoresHTML(list, { delta: st.phase === "round" })}</div></div>`;
      break;
    }
  }
  app.innerHTML = html;
  if (st.phase === "board") animatePick();
  tick();
}

render();
