const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const MAX = 10; // máximo de pessoas na call
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.ALLOWED_ORIGIN || "*" } });
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

// ---------- salas ----------
// sala = { name, owner, channels[], roles[], members: Map(pid -> {name, avatar, role}), msgs{canal: []} }
const rooms = new Map();
const newCode = () => { let c; do c = crypto.randomBytes(3).toString("hex").toUpperCase(); while (rooms.has(c)); return c; };
const newRoom = (name, owner) => ({
  name, owner, members: new Map(), msgs: { geral: [] },
  channels: [{ id: "geral", name: "geral" }],
  roles: [{ id: "admin", name: "Admin", color: "#f23f43" }],
});
const info = (r) => ({ channels: r.channels, roles: r.roles, owner: r.owner });
const socketsIn = (code) => [...io.sockets.sockets.values()].filter((s) => s.data.room === code);
const can = (s, r) => s.data.pid && (s.data.pid === r.owner || (r.members.get(s.data.pid) || {}).role === "admin");

const voiceOf = (code) =>
  socketsIn(code).filter((s) => s.data.voice).map((s) => ({
    id: s.id, pid: s.data.pid, name: s.data.name,
    muted: !!s.data.muted, deafened: !!s.data.deafened, screen: !!s.data.screen, cam: !!s.data.cam,
  }));
const push = (code) => code && io.to("r:" + code).emit("voice-users", voiceOf(code));
const membersOf = (code) => {
  const r = rooms.get(code);
  if (!r) return [];
  const on = new Set(socketsIn(code).map((s) => s.data.pid));
  return [...r.members].map(([pid, m]) => ({ pid, name: m.name, avatar: m.avatar || null, role: m.role || null, online: on.has(pid) }));
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
  s.data = { name: "Anônimo", avatar: null, pid: null };

  s.on("profile", ({ name, avatar, key }) => {
    if (typeof key === "string" && key.length >= 16 && key.length <= 80) s.data.pid = pidOf(key);
    s.data.name = clean(name, 20) || "Anônimo";
    s.data.avatar = okAvatar(avatar);
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
    ack({ ok: true, code, name: room.name, locked: !!room.hash, pid: s.data.pid, info: info(room), members: membersOf(code), ch: "geral" });
    push(code);
    pushMembers(code);
    pushInfo(code);
  });
  s.on("leave-room", () => leaveRoom(s));

  // ----- canais de texto -----
  s.on("history", ({ ch }, ack) => { const r = rooms.get(s.data.room); ack((r && r.msgs[ch]) || []); });
  s.on("msg", ({ ch, text }) => {
    const r = rooms.get(s.data.room);
    text = String(text || "").slice(0, 2000);
    if (!r || !text.trim() || !r.channels.some((c) => c.id === ch)) return;
    const m = { pid: s.data.pid, name: s.data.name, text, time: Date.now(), ch };
    const list = (r.msgs[ch] ??= []);
    list.push(m);
    if (list.length > 50) list.shift();
    io.to("r:" + s.data.room).emit("msg", m);
  });
  s.on("create-channel", ({ name }, ack) => {
    const r = rooms.get(s.data.room);
    if (!r || !can(s, r)) return ack({ error: "Sem permissão." });
    name = clean(name, 30);
    if (!name) return ack({ error: "Nome inválido." });
    if (r.channels.length >= 30) return ack({ error: "Limite de canais atingido." });
    const id = rid();
    r.channels.push({ id, name });
    r.msgs[id] = [];
    pushInfo(s.data.room); // antes do ack, para o cliente já conhecer o canal
    ack({ id });
  });
  s.on("delete-channel", ({ id }) => {
    const r = rooms.get(s.data.room);
    if (!r || !can(s, r) || r.channels.length <= 1) return;
    r.channels = r.channels.filter((c) => c.id !== id);
    delete r.msgs[id];
    pushInfo(s.data.room);
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
  s.on("voice-join", (_, ack) => {
    const r = s.data.room;
    if (!r) return ack({ error: "Entre em uma sala primeiro." });
    if (!s.data.voice && voiceOf(r).length >= MAX) return ack({ error: `Call cheia: máximo de ${MAX} pessoas.` });
    Object.assign(s.data, { voice: true, muted: false, deafened: false, screen: false, cam: false });
    ack({ ok: true });
    push(r);
  });
  s.on("voice-leave", () => { s.data.voice = false; push(s.data.room); });
  s.on("voice-state", (st) => {
    Object.assign(s.data, { muted: !!st.muted, deafened: !!st.deafened, screen: !!st.screen, cam: !!st.cam });
    push(s.data.room);
  });
  s.on("signal", ({ to, data }) => {
    const t = io.sockets.sockets.get(to);
    if (t && t.data.voice && t.data.room === s.data.room) t.emit("signal", { from: s.id, data });
  });

  s.on("disconnect", () => { push(s.data.room); pushMembers(s.data.room); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));
