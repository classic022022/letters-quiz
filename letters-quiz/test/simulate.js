// محاكاة ألعاب كاملة: مقدم + لاعبون عبر Socket.IO الحقيقي
const { server, rooms, normalize, isAccepted } = require("../server");
const { io: Client } = require("socket.io-client");
const assert = require("assert");
const wait = ms => new Promise(r => setTimeout(r, ms));
let URL, fails = 0;
const ok = (c, m) => { if (c) console.log("  ✔", m); else { fails++; console.log("  ✖", m); } };

function client() {
  const s = Client(URL, { transports: ["websocket"], forceNew: true });
  s.state = null; s.on("state", st => { s.state = st; });
  s.call = (ev, ...args) => new Promise(r => s.emit(ev, ...args, r));
  return s;
}
const until = async (s, pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (s.state && pred(s.state)) return s.state; await wait(30); } throw new Error("timeout waiting; phase=" + (s.state && s.state.phase)); };
const correctOf = room => room.q.data.a;
const wrongOf = room => room.letter === "هـ" ? "هدهدات" : room.letter + "زززز";

(async () => {
  await new Promise(r => server.listen(0, r)); URL = "http://localhost:" + server.address().port;

  console.log("١) قواعد المطابقة");
  ok(normalize("الرياض") === normalize("رياض") && normalize("إسطنبول") === normalize("اسطنبول") && normalize("كتابٌ") === "كتاب", "الـ والهمزات والتنوين");
  ok(isAccepted("القاهره", { a: "القاهرة", alt: [] }), "ة/ه");

  console.log("٢) لعبة لاعبين بمقدم");
  const H = client(); const r = await H.call("create", { settings: { mode: "players", rounds: 2, perLetter: 3, time: 2 }, usage: {} });
  ok(r.ok && /^\d{4}$/.test(r.code), "إنشاء غرفة برمز " + r.code);
  const room = rooms.get(r.code);
  const [A, B, C] = [client(), client(), client()];
  ok((await A.call("join", { code: r.code, name: "أحمد" })).ok, "انضمام أحمد");
  await B.call("join", { code: r.code, name: "سارة" });
  const cj = await C.call("join", { code: r.code, name: "خالد" });
  ok(!(await client().call("join", { code: r.code, name: "أحمد" })).ok, "رفض اسم مكرر");
  ok(!(await client().call("join", { code: "0000", name: "x" })).ok, "رفض رمز خاطئ");
  await until(H, s => s.players.length === 3);
  await H.call("host", { cmd: "start" });
  await until(H, s => s.phase === "board");
  await H.call("host", { cmd: "pick" });
  await until(A, s => s.phase === "question");
  ok(A.state.question.answer === null, "اللاعب لا يرى الإجابة أثناء السؤال");
  ok(H.state.question.answer === correctOf(room), "المقدم يرى الإجابة");
  const w = await A.call("answer", wrongOf(room));
  ok(w.ok && !w.correct, "إجابة خاطئة تُرفض");
  ok((await A.call("answer", correctOf(room))).ok === false, "صاحب الخطأ لا يجيب مرة ثانية على نفس السؤال");
  await until(B, s => s.question && s.question.answers.length === 1);
  ok(B.state.question.answers[0].ok === false && B.state.question.answers[0].text, "الإجابة الخاطئة تظهر للجميع ✖");
  const c = await B.call("answer", "  " + correctOf(room) + " ");
  ok(c.correct, "إجابة صحيحة تُقبل");
  await until(C, s => s.phase === "reveal");
  ok(C.state.question.winner.name === "سارة" && C.state.question.answer, "الكشف للجميع والفائز سارة");
  ok(B.state.me.score === 1, "نقطة لسارة");
  await H.call("host", { cmd: "next" });
  await until(H, s => s.phase === "question" && s.question.index === 2);
  // انتهاء الوقت مع وجود مقدم: السؤال يبقى مفتوحاً
  await wait(2500);
  ok(H.state.phase === "question" && H.state.question.timeUp, "انتهاء الوقت لا يغلق السؤال بوجود مقدم");
  ok((await C.call("answer", correctOf(room))).correct, "الإجابة مقبولة بعد انتهاء الوقت");
  await until(H, s => s.phase === "reveal"); await H.call("host", { cmd: "next" });
  await until(H, s => s.phase === "question" && s.question.index === 3);
  // اعتماد المقدم لإجابة رآها النظام خاطئة
  await A.call("answer", wrongOf(room));
  await until(H, s => s.question.answers.length === 1);
  await H.call("host", { cmd: "accept", arg: H.state.question.answers[0].pid });
  await until(H, s => s.phase === "reveal");
  await until(A, s => s.me.score === 1, 3000).catch(() => {});
  ok(H.state.question.winner.name === "أحمد" && A.state.me.score === 1, "المقدم يعتمد إجابة أحمد ← نقطة");
  await H.call("host", { cmd: "next" });
  await until(H, s => s.phase === "round");
  ok(H.state.roundScores.length === 3, "نتيجة الحرف");
  // إعادة الاتصال بنفس الهوية
  C.disconnect(); const C2 = client(); const rj = await C2.call("join", { code: r.code, playerToken: cj.playerToken });
  ok(rj.ok && (await until(C2, s => !!s.me)).me.name === "خالد" && C2.state.me.score === 1, "عودة خالد بعد انقطاع مع نقاطه");
  await H.call("host", { cmd: "next" }); await until(H, s => s.phase === "board"); await H.call("host", { cmd: "pick" });
  await until(H, s => s.phase === "question");
  ok(H.state.board.used.length === 2 && H.state.board.used[0] !== H.state.board.used[1], "حرف جديد غير مكرر");
  // كل من أجاب خطأ ← يُغلق السؤال
  await A.call("answer", wrongOf(room)); await B.call("answer", wrongOf(room)); await C2.call("answer", wrongOf(room));
  await until(H, s => s.phase === "reveal");
  ok(!H.state.question.winner, "خطأ الجميع يغلق السؤال بلا نقطة");
  for (let i = 0; i < 2; i++) { await H.call("host", { cmd: "next" }); await until(H, s => s.phase === "question"); await H.call("host", { cmd: "close" }); await until(H, s => s.phase === "reveal"); }
  await H.call("host", { cmd: "next" }); await until(H, s => s.phase === "round");
  await H.call("host", { cmd: "next" });
  // أحمد 1، سارة 1، خالد 1 ← تعادل ثلاثي
  await until(H, s => s.phase === "tie");
  ok(H.state.tiebreak.among.length === 3, "تعادل ← جولة كسر تعادل");
  await H.call("host", { cmd: "next" }); await until(H, s => s.phase === "board"); await H.call("host", { cmd: "pick" });
  await until(H, s => s.phase === "question");
  await A.call("answer", correctOf(room));
  await until(H, s => s.phase === "final", 8000);
  ok(H.state.final.standings[0].name === "أحمد" && !H.state.final.tie, "كسر التعادل يحسم: أحمد الفائز");
  ok(H.state.log.length >= 7, "سجل الأسئلة في النهاية");
  await H.call("host", { cmd: "lobby" }); await until(H, s => s.phase === "lobby");
  ok(H.state.players.every(p => p.score === 0) && H.state.players.length === 3, "لعب مرة أخرى بنفس اللاعبين");
  [H, A, B, C2].forEach(s => s.disconnect());

  console.log("٣) وضع الفرق مع توزيع عشوائي");
  const H2 = client(); const r2 = await H2.call("create", { settings: { mode: "teams", teamPick: "random", rounds: 1, perLetter: 2, time: 5 } });
  const room2 = rooms.get(r2.code); const ps = [];
  for (const n of ["ن1", "ن2", "ن3", "ن4"]) { const s = client(); await s.call("join", { code: r2.code, name: n }); ps.push(s); }
  await H2.call("host", { cmd: "start" }); await until(H2, s => s.phase === "board");
  const teams = H2.state.players.map(p => p.team);
  ok(teams.filter(t => t === 0).length === 2 && teams.filter(t => t === 1).length === 2, "توزيع عشوائي متوازن 2/2");
  await H2.call("host", { cmd: "pick" }); await until(H2, s => s.phase === "question");
  await ps[0].call("answer", correctOf(room2)); await until(H2, s => s.phase === "reveal");
  const t0 = H2.state.players[0].team;
  ok(H2.state.standings.find(s => s.key === "t" + t0).score === 1, "النقطة تُحسب لفريق اللاعب");
  [H2, ...ps].forEach(s => s.disconnect());

  console.log("٤) الوضع التلقائي (المقدم يلعب)");
  const H3 = client(); const r3 = await H3.call("create", { settings: { mode: "players", rounds: 1, perLetter: 2, time: 2, hostPlays: true }, hostName: "جبرين" });
  const room3 = rooms.get(r3.code);
  ok(room3.settings.time >= 10, "المؤقت إلزامي في الوضع التلقائي (" + room3.settings.time + " ث)");
  room3.settings.time = 2;                                   // لتسريع الاختبار
  const P = client(); await P.call("join", { code: r3.code, name: "ضيف" });
  await until(H3, s => s.players.length === 2);
  ok(H3.state.me && H3.state.me.name === "جبرين", "المقدم مسجل لاعباً");
  await H3.call("host", { cmd: "start" });
  await until(H3, s => s.phase === "question", 9000);
  ok(H3.state.question.answer === null, "المقدم المشارك لا يرى الإجابة");
  ok((await H3.call("answer", correctOf(room3))).correct, "المقدم يجيب كلاعب");
  await until(P, s => s.phase === "question" && s.question.index === 2, 9000);
  ok(true, "الانتقال تلقائياً للسؤال التالي");
  await until(P, s => s.phase === "reveal", 5000);
  ok(!P.state.question.winner && P.state.question.how === "time", "انتهاء الوقت يغلق السؤال تلقائياً");
  await until(P, s => s.phase === "final", 20000);
  ok(P.state.final.standings[0].name === "جبرين", "اللعبة تنتهي تلقائياً بالفائز");
  [H3, P].forEach(s => s.disconnect());

  console.log(fails ? `\n✖ فشل ${fails}` : "\n✔ نجحت كل الاختبارات");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("✖", e); process.exit(1); });
