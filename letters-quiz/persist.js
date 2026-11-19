// حفظ الغرف في Supabase حتى لا تضيع إذا أُعيد تشغيل الخادم (تحديث أو نوم)
// يحتاج جدول public.rooms (code text primary key, data jsonb, updated_at timestamptz)
// وبدون SUPABASE_URL/SUPABASE_KEY يعمل كأنه غير موجود.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_KEY || "";
const enabled = !!(SB_URL && SB_KEY);
const pending = new Map();          // code -> مؤقت الحفظ المؤجل
const MAX_AGE_MS = 6 * 3600 * 1000;

function headers(extra) {
  const h = { apikey: SB_KEY, "Content-Type": "application/json", ...extra };
  if (!SB_KEY.startsWith("sb_")) h.Authorization = "Bearer " + SB_KEY;
  return h;
}

function snapshot(room) {
  return {
    ...room,
    timers: undefined, hostSockets: undefined,
    players: [...room.players.values()].map(p => ({ ...p, sockets: undefined })),
    q: room.q ? { ...room.q, locked: [...room.q.locked] } : null,
    savedAt: Date.now(),
  };
}

function revive(data) {
  const room = { ...data };
  room.timers = new Set();
  room.hostSockets = new Set();
  room.players = new Map((data.players || []).map(p => [p.id, { ...p, sockets: new Set() }]));
  room.q = data.q ? { ...data.q, locked: new Set(data.q.locked || []) } : null;
  return room;
}

async function write(room) {
  pending.delete(room.code);
  try {
    const r = await fetch(SB_URL + "/rest/v1/rooms?on_conflict=code", {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ code: room.code, data: snapshot(room), updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) console.error("حفظ الغرفة فشل", room.code, r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.error("حفظ الغرفة:", e.message); }
}

// يُستدعى مع كل تغيير؛ يجمع التغييرات المتتالية في حفظ واحد كل ثانية
function save(room) {
  if (!enabled || pending.has(room.code)) return;
  pending.set(room.code, setTimeout(() => write(room), 1000));
}

async function remove(code) {
  if (!enabled) return;
  clearTimeout(pending.get(code)); pending.delete(code);
  try { await fetch(SB_URL + "/rest/v1/rooms?code=eq." + encodeURIComponent(code), { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(6000) }); }
  catch (e) { console.error("حذف الغرفة:", e.message); }
}

// حفظ فوري لكل الغرف المعلّقة (قبل إيقاف الخادم)
async function flush(rooms) {
  if (!enabled) return;
  const codes = [...pending.keys()];
  codes.forEach(c => clearTimeout(pending.get(c)));
  await Promise.all(codes.map(c => rooms.get(c) ? write(rooms.get(c)) : null));
}

async function loadAll() {
  if (!enabled) return [];
  try {
    const since = new Date(Date.now() - MAX_AGE_MS).toISOString();
    const r = await fetch(SB_URL + "/rest/v1/rooms?select=code,data&updated_at=gt." + encodeURIComponent(since), { headers: headers(), signal: AbortSignal.timeout(10000) });
    if (!r.ok) { console.error("تحميل الغرف فشل", r.status, (await r.text()).slice(0, 200)); return []; }
    return (await r.json()).map(row => revive(row.data));
  } catch (e) { console.error("تحميل الغرف:", e.message); return []; }
}

module.exports = { enabled, save, remove, flush, loadAll, snapshot, revive };
