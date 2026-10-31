const express = require("express");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const MAX = 10; // pessoas por canal de voz
const MAXFILE = 20 * 1024 * 1024; // 20 MB por arquivo
const STATUS = ["online", "away", "dnd", "invisible"];
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.ALLOWED_ORIGIN || "*" } });

// CORS para o site (GitHub Pages) falar com este servidor
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "x-sid,x-filename,x-filetype,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static("public"));
app.get("/health", (_, res) => res.send("ok"));

// ---------- utilidades ----------
const rid = () => crypto.randomBytes(3).toString("hex");
const pidOf = (key) => crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 12); // id público; a chave nunca sai do servidor
const clean = (t, n) => String(t || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);
const okAvatar = (a) =>
  typeof a === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a) && a.length < 40000 ? a : null;
const hashPw = (pw, salt) => crypto.scryptSync(String(pw).slice(0, 64), salt, 32);
const checkPw = (room, pw) => crypto.timingSafeEqual(hashPw(pw, room.salt), room.hash);
const fails = new Map();
const blocked = (ip) => { const f = fails.get(ip); return !!f && Date.now() - f.t < 600000 && f.n >= 8; };
const addFail = (ip) => {
  const f = fails.get(ip);
  fails.set(ip, f && Date.now() - f.t < 600000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() });
};

// ---------- arquivos enviados no chat ----------
const UP = path.join(__dirname, "uploads");
fs.mkdirSync(UP, { recursive: true });
for (const f of fs.readdirSync(UP)) fs.unlinkSync(path.join(UP, f)); // começa limpo (o registro é em memória)
const files = new Map(); // id -> { name, type, size, room, pid, attached, t }
const IMG = /^image\/(png|jpeg|gif|webp)$/;
const dropFile = (id) => { files.delete(id); fs.unlink(path.join(UP, id), () => {}); };
const dropFiles = (list) => (list || []).forEach((m) => m.file && dropFile(m.file.id));
setInterval(() => {
  const now = Date.now();
  for (const [id, f] of files) if (now - f.t > 7 * 864e5 || (!f.attached && now - f.t > 36e5)) dropFile(id);
}, 36e5).unref();

app.post("/upload", express.raw({ type: () => true, limit: MAXFILE }), (req, res) => {
  const s = io.sockets.sockets.get(String(req.get("x-sid")));
  if (!s || !s.data.room) return res.status(403).json({ error: "Entre em uma sala primeiro." });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Arquivo vazio." });
  s.data.up = (s.data.up || []).filter((t) => Date.now() - t < 60000);
  if (s.data.up.length >= 10) return res.status(429).json({ error: "Muitos envios seguidos. Aguarde um minuto." });
  s.data.up.push(Date.now());
  let name = "arquivo";
  try { name = clean(decodeURIComponent(req.get("x-filename") || ""), 120) || "arquivo"; } catch {}
  const type = IMG.test(req.get("x-filetype") || "") ? req.get("x-filetype") : "application/octet-stream";
  const id = crypto.randomBytes(16).toString("hex");
  fs.writeFile(path.join(UP, id), req.body, (err) => {
    if (err) return res.status(500).json({ error: "Falha ao salvar o arquivo." });
    files.set(id, { name, type, size: req.body.length, room: s.data.room, pid: s.data.pid, attached: false, t: Date.now() });
    res.json({ id });
  });
});
app.get("/files/:id", (req, res) => {
  const f = files.get(req.params.id);
  if (!f) return res.sendStatus(404);
  res.set({
    "Content-Type": f.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
    "Content-Disposition": (IMG.test(f.type) ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(f.name),
    "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "private, max-age=3600",
  });
  res.sendFile(path.join(UP, req.params.id));
});

// ---------- salas ----------
// sala = { name, owner, channels[{id,type,name}], roles[], members: Map(pid -> {name, avatar, role}), msgs{canal: []} }
const rooms = new Map();
const newCode = () => { let c; do c = crypto.randomBytes(3).toString("hex").toUpperCase(); while (rooms.has(c)); return c; };
const newRoom = (name, owner) => ({
  name, owner, members: new Map(), msgs: { geral: [] },
  channels: [{ id: "geral", type: "text", name: "geral" }, { id: "voz", type: "voice", name: "Voz", limit: MAX }],
  roles: [{ id: "admin", name: "Admin", color: "#f23f43" }],
});
const info = (r) => ({ channels: r.channels, roles: r.roles, owner: r.owner });
const socketsIn = (code) => [...io.sockets.sockets.values()].filter((s) => s.data.room === code);
const can = (s, r) => s.data.pid && (s.data.pid === r.owner || (r.members.get(s.data.pid) || {}).role === "admin");
const firstText = (r) => r.channels.find((c) => c.type === "text");
const limitOf = (n) => Math.min(MAX, Math.max(2, parseInt(n, 10) || MAX)); // limite de pessoas: 2 a 10

const voiceOf = (code) => {
  const out = {};
  socketsIn(code).forEach((s) => {
    if (!s.data.voice) return;
    (out[s.data.voice] ??= []).push({
      id: s.id, pid: s.data.pid, name: s.data.name,
      muted: !!s.data.muted, deafened: !!s.data.deafened, screen: !!s.data.screen, cam: !!s.data.cam,
    });
  });
  return out;
};
const push = (code) => code && io.to("r:" + code).emit("voice-users", voiceOf(code));
const membersOf = (code) => {
  const r = rooms.get(code);
  if (!r) return [];
  const live = new Map(); // pid -> status (quem está invisível aparece offline)
  socketsIn(code).forEach((s) => { if (s.data.status !== "invisible" && !live.has(s.data.pid)) live.set(s.data.pid, s.data.status); });
  return [...r.members].map(([pid, m]) => ({
    pid, name: m.name, avatar: m.avatar || null, role: m.role || null, online: live.has(pid), status: live.get(pid) || "offline",
  }));
};
const pushMembers = (code) => code && io.to("r:" + code).emit("members", membersOf(code));
const pushInfo = (code) => { const r = rooms.get(code); r && io.to("r:" + code).emit("room", info(r)); };

function leaveRoom(s) {
  const r = s.data.room;
  if (!r) return;
  s.leave("r:" + r);
  Object.assign(s.data, { room: null, voice: false, muted: false, deafened: false, screen: false, cam: false });
  push(r);
  pushMembers(r);
}

io.on("connection", (s) => {
  s.data = { name: "Anônimo", avatar: null, pid: null, status: "online" };

  s.on("profile", ({ name, avatar, key, status }) => {
    if (typeof key === "string" && key.length >= 16 && key.length <= 80) s.data.pid = pidOf(key);
    s.data.name = clean(name, 20) || "Anônimo";
    s.data.avatar = okAvatar(avatar);
    s.data.status = STATUS.includes(status) ? status : "online";
    const r = rooms.get(s.data.room), m = r && r.members.get(s.data.pid);
    if (m) { m.name = s.data.name; m.avatar = s.data.avatar; }
    push(s.data.room);
    pushMembers(s.data.room);
  });

  s.on("create-room", ({ name, password }, ack) => {
    const code = newCode();
    const room = newRoom(clean(name, 30) || "Minha sala", s.data.pid);
    if (password) { room.salt = crypto.randomBytes(8).toString("hex"); room.hash = hashPw(password, room.salt); }
    rooms.set(code, room);
    ack({ code });
  });

  s.on("enter-room", ({ code, password }, ack) => {
    code = String(code || "").toUpperCase();
    if (!s.data.pid) return ack({ ok: false, error: "Defina seu perfil primeiro." });
    if (!/^[A-Z0-9]{3,12}$/.test(code)) return ack({ ok: false, error: "Código inválido." });
    const ip = (s.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim() || s.handshake.address;
    let room = rooms.get(code);
    if (room && room.hash) {
      if (blocked(ip)) return ack({ ok: false, error: "Muitas tentativas erradas. Aguarde alguns minutos." });
      if (!password) return ack({ ok: false, error: "Esta sala tem senha. Digite a senha." });
      if (!checkPw(room, password)) { addFail(ip); return ack({ ok: false, error: "Senha incorreta." }); }
    }
    leaveRoom(s);
    if (!room) { room = newRoom("Sala " + code, null); rooms.set(code, room); } // convites antigos continuam funcionando
    if (!room.owner) room.owner = s.data.pid; // quem entra primeiro numa sala sem dono vira o criador
    const m = room.members.get(s.data.pid) || { role: null };
    m.name = s.data.name; m.avatar = s.data.avatar;
    room.members.set(s.data.pid, m);
    s.data.room = code;
    s.join("r:" + code);
    ack({ ok: true, code, name: room.name, locked: !!room.hash, pid: s.data.pid, info: info(room), members: membersOf(code), ch: (firstText(room) || {}).id || null });
    push(code);
    pushMembers(code);
    pushInfo(code);
  });
  s.on("leave-room", () => leaveRoom(s));

  // ----- mensagens -----
  const textCh = (r, ch) => r && r.channels.some((c) => c.id === ch && c.type === "text");
  s.on("history", ({ ch }, ack) => { const r = rooms.get(s.data.room); ack(textCh(r, ch) ? r.msgs[ch] || [] : []); });
  s.on("msg", ({ ch, text, fileId }) => {
    const r = rooms.get(s.data.room);
    text = String(text || "").slice(0, 2000);
    const ref = fileId && files.get(fileId);
    const ok = ref && ref.pid === s.data.pid && ref.room === s.data.room && !ref.attached;
    if (!textCh(r, ch) || (!text.trim() && !ok)) return;
    const m = { id: crypto.randomBytes(6).toString("hex"), pid: s.data.pid, name: s.data.name, text, time: Date.now(), ch };
    if (ok) { ref.attached = true; m.file = { id: fileId, name: ref.name, size: ref.size, image: IMG.test(ref.type) }; }
    const list = (r.msgs[ch] ??= []);
    list.push(m);
    if (list.length > 50) list.shift();
    io.to("r:" + s.data.room).emit("msg", m);
  });
  s.on("edit-msg", ({ ch, id, text }) => {
    const r = rooms.get(s.data.room), list = r && r.msgs[ch];
    const m = list && list.find((x) => x.id === id);
    text = String(text || "").slice(0, 2000);
    if (!m || m.pid !== s.data.pid || (!text.trim() && !m.file)) return; // só o autor edita
    m.text = text; m.edited = true;
    io.to("r:" + s.data.room).emit("msg-edited", { ch, id, text });
  });
  s.on("delete-msg", ({ ch, id }) => {
    const r = rooms.get(s.data.room), list = r && r.msgs[ch];
    const i = list ? list.findIndex((m) => m.id === id) : -1;
    if (i < 0) return;
    const m = list[i];
    if (m.pid !== s.data.pid && !can(s, r)) return; // autor ou admin/criador
    list.splice(i, 1);
    dropFiles([m]);
    io.to("r:" + s.data.room).emit("msg-deleted", { ch, id });
  });

  // ----- canais (texto e voz) -----
  s.on("create-channel", ({ name, type, limit }, ack) => {
    const r = rooms.get(s.data.room);
    if (!r || !can(s, r)) return ack({ error: "Sem permissão." });
    name = clean(name, 30);
    if (!name) return ack({ error: "Nome inválido." });
    if (r.channels.length >= 30) return ack({ error: "Limite de canais atingido." });
    type = type === "voice" ? "voice" : "text";
    const id = rid();
    const c = { id, type, name };
    if (type === "voice") c.limit = limitOf(limit);
    r.channels.push(c);
    if (type === "text") r.msgs[id] = [];
    pushInfo(s.data.room); // antes do ack, para o cliente já conhecer o canal
    ack({ id });
  });
  s.on("edit-channel", ({ id, name, limit }, ack) => {
    const r = rooms.get(s.data.room), c = r && r.channels.find((x) => x.id === id);
    if (!c || !can(s, r)) return ack && ack({ error: "Sem permissão." });
    name = clean(name, 30);
    if (!name) return ack && ack({ error: "Nome inválido." });
    c.name = name;
    if (c.type === "voice") c.limit = limitOf(limit);
    pushInfo(s.data.room);
    ack && ack({ ok: true });
  });
  s.on("delete-channel", ({ id }) => {
    const r = rooms.get(s.data.room), c = r && r.channels.find((x) => x.id === id);
    if (!c || !can(s, r)) return;
    r.channels = r.channels.filter((x) => x.id !== id);
    dropFiles(r.msgs[id]); delete r.msgs[id];
    socketsIn(s.data.room).forEach((x) => { if (x.data.voice === id) x.data.voice = false; });
    pushInfo(s.data.room);
    push(s.data.room);
  });

  // ----- cargos -----
  s.on("create-role", ({ name, color }) => {
    const r = rooms.get(s.data.room);
    name = clean(name, 20);
    if (!r || !can(s, r) || !name || r.roles.length >= 16) return;
    r.roles.push({ id: rid(), name, color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#8b5cf6" });
    pushInfo(s.data.room);
  });
  s.on("delete-role", ({ id }) => {
    const r = rooms.get(s.data.room);
    if (!r || !can(s, r) || id === "admin") return;
    r.roles = r.roles.filter((x) => x.id !== id);
    r.members.forEach((m) => { if (m.role === id) m.role = null; });
    pushInfo(s.data.room);
    pushMembers(s.data.room);
  });
  s.on("set-role", ({ pid, role }) => {
    const r = rooms.get(s.data.room), t = r && r.members.get(pid);
    if (!r || !t || !can(s, r) || pid === r.owner) return;
    role = role || null;
    if (role && !r.roles.some((x) => x.id === role)) return;
    if ((role === "admin" || t.role === "admin") && s.data.pid !== r.owner) return; // só o criador mexe em Admin
    t.role = role;
    pushMembers(s.data.room);
  });

  // ----- voz -----
  s.on("voice-join", ({ channel }, ack) => {
    const r = rooms.get(s.data.room);
    if (!r) return ack({ error: "Entre em uma sala primeiro." });
    if (!r.channels.some((c) => c.id === channel && c.type === "voice")) return ack({ error: "Canal de voz não encontrado." });
    const vc = r.channels.find((c) => c.id === channel), cap = (vc && vc.limit) || MAX;
    if (s.data.voice !== channel && (voiceOf(s.data.room)[channel] || []).length >= cap)
      return ack({ error: `Canal cheio: máximo de ${cap} pessoas.` });
    Object.assign(s.data, { voice: channel, muted: false, deafened: false, screen: false, cam: false });
    ack({ ok: true });
    push(s.data.room);
  });
  s.on("voice-leave", () => { s.data.voice = false; push(s.data.room); });
  s.on("voice-state", (st) => {
    Object.assign(s.data, { muted: !!st.muted, deafened: !!st.deafened, screen: !!st.screen, cam: !!st.cam });
    push(s.data.room);
  });
  s.on("signal", ({ to, data }) => {
    const t = io.sockets.sockets.get(to);
    if (t && t.data.voice && t.data.voice === s.data.voice && t.data.room === s.data.room) t.emit("signal", { from: s.id, data });
  });

  s.on("disconnect", () => { push(s.data.room); pushMembers(s.data.room); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));