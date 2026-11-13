// سجل الدخول واللعب + صفحة الإدارة /admin
// الإعداد عبر متغيرات البيئة في Render:
//   ADMIN_PASSWORD  كلمة مرور صفحة /admin
//   SUPABASE_URL    رابط مشروع Supabase (يحفظ السجل بشكل دائم)
//   SUPABASE_KEY    المفتاح السري لمشروع Supabase
// بدون Supabase يُحفظ السجل في الذاكرة فقط (يُمسح عند إعادة تشغيل الخادم).

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_KEY || "";
const useDb = !!(SB_URL && SB_KEY);
const memory = [];
const geoCache = new Map();
const recentVisits = new Map();

function sbHeaders(extra) {
  const h = { apikey: SB_KEY, "Content-Type": "application/json", ...extra };
  if (!SB_KEY.startsWith("sb_")) h.Authorization = "Bearer " + SB_KEY;   // المفاتيح القديمة (JWT)
  return h;
}

function clientIp(socket) {
  const xf = socket.handshake.headers["x-forwarded-for"];
  const ip = (xf ? String(xf).split(",")[0] : socket.handshake.address || "").trim();
  return ip.replace(/^::ffff:/, "");
}

function parseUA(ua = "") {
  let device = "غير معروف", browser = "غير معروف";
  if (/iPhone/.test(ua)) device = "آيفون";
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) device = "آيباد";
  else if (/Android/.test(ua)) {
    const m = ua.match(/Android [\d.]+;\s*([^;)]+?)(?:\s+Build|\))/);
    const model = m && m[1] && !/^(K|wv)$/i.test(m[1].trim()) ? m[1].trim() : "";
    device = /Mobile/.test(ua) ? "جوال أندرويد" : "تابلت أندرويد";
    if (model) device += " (" + model + ")";
  }
  else if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|AndroidTV|CrKey/i.test(ua)) device = "تلفاز ذكي";
  else if (/Windows/.test(ua)) device = "كمبيوتر ويندوز";
  else if (/Macintosh/.test(ua)) device = "كمبيوتر ماك";
  else if (/Linux/.test(ua)) device = "كمبيوتر لينكس";
  if (/SamsungBrowser/.test(ua)) browser = "متصفح سامسونج";
  else if (/Edg\//.test(ua)) browser = "Edge";
  else if (/CriOS|Chrome\//.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return { device, browser };
}

async function geo(ip) {
  if (!ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/.test(ip)) return { city: "", region: "", country: "" };
  if (geoCache.has(ip)) return geoCache.get(ip);
  let g = { city: "", region: "", country: "" };
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city&lang=ar`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    if (j.status === "success") g = { city: j.city || "", region: j.regionName || "", country: j.country || "" };
  } catch {}
  geoCache.set(ip, g);
  if (geoCache.size > 5000) geoCache.delete(geoCache.keys().next().value);
  return g;
}

async function record(kind, socket, extra = {}) {
  try {
    const ip = socket ? clientIp(socket) : "";
    const ua = socket ? String(socket.handshake.headers["user-agent"] || "") : "";
    const { device, browser } = parseUA(ua);
    const g = await geo(ip);
    const row = {
      at: new Date().toISOString(), kind,
      name: extra.name || null, room: extra.room || null, role: extra.role || null,
      ip: ip || null, city: g.city || null, region: g.region || null, country: g.country || null,
      device, browser, user_agent: ua.slice(0, 400) || null,
      detail: extra.detail || null,
    };
    memory.unshift(row); if (memory.length > 3000) memory.pop();
    if (useDb) {
      const r = await fetch(SB_URL + "/rest/v1/events", { method: "POST", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify(row), signal: AbortSignal.timeout(6000) });
      if (!r.ok) console.error("سجل: فشل الحفظ في Supabase", r.status, (await r.text()).slice(0, 200));
    }
  } catch (e) { console.error("سجل:", e.message); }
}

async function readAll() {
  if (!useDb) return memory;
  const r = await fetch(SB_URL + "/rest/v1/events?select=*&order=at.desc&limit=5000", { headers: sbHeaders(), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("Supabase " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}

function auth(req, res, next) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return res.status(503).type("text/plain; charset=utf-8").send("صفحة السجل غير مفعّلة: أضف ADMIN_PASSWORD في إعدادات Render.");
  const h = req.headers.authorization || "";
  const given = h.startsWith("Basic ") ? Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
  if (given === pass) return next();
  res.set("WWW-Authenticate", 'Basic realm="letters-quiz-admin", charset="UTF-8"').status(401).type("text/plain; charset=utf-8").send("كلمة المرور مطلوبة.");
}

const KIND_AR = { visit: "زيارة الموقع", create: "إنشاء غرفة", join: "دخول لاعب", tv: "شاشة تلفاز", rejoin: "عودة بعد انقطاع", start: "بداية لعبة", final: "نهاية لعبة" };

function csv(rows) {
  const cols = [["at", "الوقت"], ["kind", "العملية"], ["name", "الاسم"], ["room", "الغرفة"], ["role", "الدور"], ["ip", "IP"], ["city", "المدينة"], ["region", "المنطقة"], ["country", "الدولة"], ["device", "الجهاز"], ["browser", "المتصفح"], ["detail", "تفاصيل"]];
  const esc = v => { v = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const fmt = (r, k) => k === "at" ? new Date(r.at).toLocaleString("en-GB", { timeZone: "Asia/Riyadh" }) : k === "kind" ? (KIND_AR[r.kind] || r.kind) : k === "role" ? ({ host: "مقدم", player: "لاعب", tv: "تلفاز" }[r.role] || r.role) : r[k];
  return "﻿" + [cols.map(c => c[1]).join(","), ...rows.map(r => cols.map(c => esc(fmt(r, c[0]))).join(","))].join("\r\n");
}

const ADMIN_HTML = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>سجل مسابقة الحروف</title>
<style>
:root{--bg:#F4F1EA;--card:#fff;--ink:#14202E;--mute:#5d6b7a;--line:#e3ddd0;--acc:#0F8B8D}
@media (prefers-color-scheme:dark){:root{--bg:#101820;--card:#1B2A3A;--ink:#EEF2F5;--mute:#9fb0c0;--line:#2b3d50;--acc:#3cc3c5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",Tahoma,sans-serif;padding:16px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 16px;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.st{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}.st b{display:block;font-size:26px;color:var(--acc)}.st span{color:var(--mute);font-size:13px}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
input,select,button,a.btn{font:inherit;padding:8px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button,a.btn{background:var(--acc);color:#fff;border:0;cursor:pointer;text-decoration:none}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:820px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap;font-size:13px}
th{position:sticky;top:0;background:var(--card);color:var(--mute);font-weight:600}
.k{display:inline-block;padding:2px 8px;border-radius:99px;background:color-mix(in srgb,var(--acc) 15%,transparent);color:var(--acc)}
h2{font-size:17px;margin:20px 0 8px}.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}
.list{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 12px}.list div{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed var(--line)}.list div:last-child{border:0}
</style></head><body>
<h1>سجل مسابقة الحروف</h1><p class="sub" id="sub">جارٍ التحميل…</p>
<div class="stats" id="stats"></div>
<div class="two"><div><h2>أكثر اللاعبين</h2><div class="list" id="topNames"></div></div><div><h2>المدن</h2><div class="list" id="topCities"></div></div><div><h2>الأجهزة</h2><div class="list" id="topDevices"></div></div></div>
<h2>كل العمليات</h2>
<div class="bar"><input id="q" placeholder="بحث: اسم، غرفة، IP، مدينة…"><select id="kind"><option value="">كل العمليات</option></select><button id="reload">تحديث</button><a class="btn" href="/admin/export.csv">تنزيل Excel</a></div>
<div class="wrap"><table><thead><tr><th>الوقت</th><th>العملية</th><th>الاسم</th><th>الغرفة</th><th>IP</th><th>المدينة</th><th>الدولة</th><th>الجهاز</th><th>المتصفح</th><th>تفاصيل</th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
const K=${JSON.stringify(KIND_AR)};let all=[];
const e=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const t=d=>new Date(d).toLocaleString("ar-SA-u-nu-latn",{timeZone:"Asia/Riyadh",dateStyle:"short",timeStyle:"short"});
const top=(arr,f,n=8)=>{const m={};arr.forEach(r=>{const k=f(r);if(k)m[k]=(m[k]||0)+1});return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,n)};
const list=(id,items)=>document.getElementById(id).innerHTML=items.length?items.map(([k,v])=>"<div><span>"+e(k)+"</span><b>"+v+"</b></div>").join(""):"<div><span>لا يوجد</span></div>";
const det=r=>{const d=r.detail;if(!d)return"";if(d.winner)return"الفائز: "+d.winner+(d.players?" — "+d.players+" لاعب":"");if(d.players)return d.players+" لاعب";if(d.mode)return d.mode;return""};
function draw(){const q=document.getElementById("q").value.trim().toLowerCase(),k=document.getElementById("kind").value;
 const rows=all.filter(r=>(!k||r.kind===k)&&(!q||[r.name,r.room,r.ip,r.city,r.country,r.device].join(" ").toLowerCase().includes(q)));
 document.getElementById("rows").innerHTML=rows.slice(0,1500).map(r=>"<tr><td>"+t(r.at)+"</td><td><span class=k>"+e(K[r.kind]||r.kind)+"</span></td><td>"+e(r.name)+"</td><td>"+e(r.room)+"</td><td>"+e(r.ip)+"</td><td>"+e(r.city)+"</td><td>"+e(r.country)+"</td><td>"+e(r.device)+"</td><td>"+e(r.browser)+"</td><td>"+e(det(r))+"</td></tr>").join("")||"<tr><td colspan=10>لا توجد عمليات</td></tr>"}
async function load(){const r=await fetch("/admin/data.json");const j=await r.json();all=j.rows||[];
 document.getElementById("sub").textContent=(j.persistent?"السجل محفوظ بشكل دائم":"تنبيه: السجل مؤقت (Supabase غير مربوط)")+" — آخر تحديث "+t(Date.now());
 const visitors=new Set(all.filter(r=>r.ip).map(r=>r.ip+"|"+r.device)).size;
 const names=new Set(all.filter(r=>r.kind==="join"||(r.kind==="create"&&r.name)).map(r=>r.name)).size;
 const s=[["زيارات",all.filter(r=>r.kind==="visit").length],["أجهزة مختلفة",visitors],["لاعبون مختلفون",names],["غرف أُنشئت",all.filter(r=>r.kind==="create").length],["ألعاب بدأت",all.filter(r=>r.kind==="start").length],["ألعاب اكتملت",all.filter(r=>r.kind==="final").length]];
 document.getElementById("stats").innerHTML=s.map(([a,b])=>"<div class=st><b>"+b+"</b><span>"+a+"</span></div>").join("");
 list("topNames",top(all.filter(r=>r.kind==="join"||r.kind==="create"),r=>r.name));
 list("topCities",top(all.filter(r=>r.kind==="visit"),r=>[r.city,r.country].filter(Boolean).join("، ")));
 list("topDevices",top(all.filter(r=>r.kind==="visit"),r=>r.device));
 draw()}
const sel=document.getElementById("kind");Object.entries(K).forEach(([k,v])=>sel.add(new Option(v,k)));
["q","kind"].forEach(id=>document.getElementById(id).addEventListener("input",draw));document.getElementById("reload").onclick=load;load();
</script></body></html>`;

module.exports = function attachLogger({ app, io, rooms }) {
  app.set("trust proxy", true);
  app.get("/admin", auth, (_, res) => res.type("html").send(ADMIN_HTML));
  app.get("/admin/data.json", auth, async (_, res) => {
    try { res.json({ persistent: useDb, rows: await readAll() }); }
    catch (e) { res.json({ persistent: false, error: e.message, rows: memory }); }
  });
  app.get("/admin/export.csv", auth, async (_, res) => {
    let rows; try { rows = await readAll(); } catch { rows = memory; }
    res.set("Content-Disposition", 'attachment; filename="letters-quiz-log.csv"').type("text/csv; charset=utf-8").send(csv(rows));
  });

  io.on("connection", socket => {
    const key = clientIp(socket) + "|" + (socket.handshake.headers["user-agent"] || "");
    const last = recentVisits.get(key) || 0;
    if (Date.now() - last > 30 * 60 * 1000) record("visit", socket);   // زيارة واحدة لكل جهاز كل 30 دقيقة
    recentVisits.set(key, Date.now());
    if (recentVisits.size > 5000) recentVisits.delete(recentVisits.keys().next().value);

    socket.onAny((event, payload) => {
      if (event !== "create" && event !== "join") return;
      const before = socket.data && socket.data.code;
      setImmediate(() => {
        const code = socket.data && socket.data.code;
        if (!code || (before && before === code && event === "join")) return;
        const room = rooms.get(code);
        const p = room && socket.data.pid ? room.players.get(socket.data.pid) : null;
        if (event === "create") {
          const s = room ? room.settings : {};
          return record("create", socket, { room: code, role: "host", name: p ? p.name : (payload && payload.hostName) || "المقدم",
            detail: { mode: (s.hostPlays ? "المقدم يلعب" : "مقدم فقط") + " — " + (s.mode === "teams" ? "فرق" : "فردي") } });
        }
        const pl = payload || {};
        if (pl.tv) return record("tv", socket, { room: code, role: "tv" });
        if (pl.hostToken || pl.playerToken) return record("rejoin", socket, { room: code, role: socket.data.role, name: p ? p.name : null });
        record("join", socket, { room: code, role: "player", name: p ? p.name : pl.name });
      });
    });
  });

  // متابعة بداية ونهاية كل لعبة
  setInterval(() => {
    for (const room of rooms.values()) {
      const ph = room.phase, prev = room._logPhase;
      room._logPhase = ph;
      if (prev === "lobby" && ph !== "lobby") record("start", null, { room: room.code, detail: { players: room.players.size } });
      if (ph === "final" && prev !== "final") {
        const st = (room.final && room.final.standings) || [];
        const top = st.length ? st[0].score : 0;
        const winners = st.filter(x => x.score === top).map(x => x.name).join(" و ");
        record("final", null, { room: room.code, detail: { winner: winners || "—", players: room.players.size, scores: st.map(x => x.name + ": " + x.score).join("، ") } });
      }
    }
  }, 2000).unref();
};
