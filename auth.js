const crypto = require("crypto");
const { promisify } = require("util");
const express = require("express");
const { Pool } = require("pg");

const scrypt = promisify(crypto.scrypt);
const router = express.Router();
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  : null;
const TOKEN_TTL = 7 * 24 * 60 * 60;
const tokenSecret = process.env.AUTH_SECRET || null;

let schemaReady;
async function ensureSchema() {
  if (!pool) throw Object.assign(new Error("Banco de dados não configurado."), { status: 503 });
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS squad_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT NOT NULL,
        username_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar TEXT,
        presence TEXT NOT NULL DEFAULT 'online'
          CHECK (presence IN ('online','away','dnd','invisible')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS squad_users_username_idx ON squad_users(username_normalized);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  await schemaReady;
}
function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name,
    avatar: row.avatar || null, presence: row.presence, createdAt: row.created_at };
}
function signToken(userId) {
  if (!tokenSecret || tokenSecret.length < 32) {
    throw Object.assign(new Error("O servidor precisa configurar AUTH_SECRET com pelo menos 32 caracteres."), { status: 503 });
  }
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL })).toString("base64url");
  const sig = crypto.createHmac("sha256", tokenSecret).update(payload).digest("base64url");
  return payload + "." + sig;
}
function readToken(token) {
  if (!tokenSecret || !token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac("sha256", tokenSecret).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch { return null; }
}
async function authUser(req, res, next) {
  try {
    await ensureSchema();
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const payload = readToken(token);
    if (!payload) return res.status(401).json({ error: "Sessão inválida ou expirada." });
    const result = await pool.query(
      "SELECT id, username, display_name, avatar, presence, created_at FROM squad_users WHERE id = $1",
      [payload.sub]
    );
    if (!result.rowCount) return res.status(401).json({ error: "Conta não encontrada." });
    req.user = result.rows[0];
    next();
  } catch (err) { next(err); }
}
router.post("/register", async (req, res, next) => {
  try {
    await ensureSchema();
    const username = String(req.body?.username || "").trim();
    const normalized = username.toLocaleLowerCase("en-US");
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || username).trim().replace(/[\u0000-\u001f]/g, "").slice(0, 30);
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username))
      return res.status(400).json({ error: "O usuário deve ter de 3 a 24 caracteres: letras, números, ponto, _ ou -." });
    if (password.length < 10 || password.length > 128)
      return res.status(400).json({ error: "A senha deve ter entre 10 e 128 caracteres." });
    if (!displayName) return res.status(400).json({ error: "Escolha um nome de exibição." });
    const salt = crypto.randomBytes(16);
    const derived = await scrypt(password, salt, 64);
    const passwordHash = salt.toString("hex") + ":" + Buffer.from(derived).toString("hex");
    const result = await pool.query(
      "INSERT INTO squad_users (username, username_normalized, password_hash, display_name) VALUES ($1,$2,$3,$4) RETURNING id, username, display_name, avatar, presence, created_at",
      [username, normalized, passwordHash, displayName]
    );
    res.status(201).json({ user: publicUser(result.rows[0]), token: signToken(result.rows[0].id) });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Esse nome de usuário já está em uso." });
    next(err);
  }
});
router.post("/login", async (req, res, next) => {
  try {
    await ensureSchema();
    const normalized = String(req.body?.username || "").trim().toLocaleLowerCase("en-US");
    const password = String(req.body?.password || "");
    const result = await pool.query("SELECT * FROM squad_users WHERE username_normalized = $1", [normalized]);
    if (!result.rowCount) return res.status(401).json({ error: "Usuário ou senha incorretos." });
    const row = result.rows[0];
    const [saltHex, hashHex] = String(row.password_hash).split(":");
    const calculated = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), 64));
    const stored = Buffer.from(hashHex || "", "hex");
    if (stored.length !== calculated.length || !crypto.timingSafeEqual(stored, calculated))
      return res.status(401).json({ error: "Usuário ou senha incorretos." });
    res.json({ user: publicUser(row), token: signToken(row.id) });
  } catch (err) { next(err); }
});
router.get("/me", authUser, (req, res) => res.json({ user: publicUser(req.user) }));
router.patch("/me", authUser, async (req, res, next) => {
  try {
    const displayName = String(req.body?.displayName || "").trim().replace(/[\u0000-\u001f]/g, "").slice(0, 30);
    const avatar = req.body?.avatar === null ? null : String(req.body?.avatar || "");
    const presence = String(req.body?.presence || "");
    if (!displayName) return res.status(400).json({ error: "Nome de exibição inválido." });
    if (avatar && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar) || avatar.length > 40000))
      return res.status(400).json({ error: "Imagem de avatar inválida ou muito grande." });
    if (presence && !["online", "away", "dnd", "invisible"].includes(presence))
      return res.status(400).json({ error: "Status de presença inválido." });
    const result = await pool.query(
      "UPDATE squad_users SET display_name=$1, avatar=$2, presence=COALESCE(NULLIF($3,''),presence), updated_at=NOW() WHERE id=$4 RETURNING id, username, display_name, avatar, presence, created_at",
      [displayName, avatar || null, presence, req.user.id]
    );
    res.json({ user: publicUser(result.rows[0]) });
  } catch (err) { next(err); }
});
router.post("/logout", (_req, res) => res.json({ ok: true, note: "Remova o token do dispositivo para encerrar a sessão local." }));

function registerAuth(app) {
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/auth", router);
  app.use((err, _req, res, _next) => {
    console.error("[auth]", err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Erro interno do servidor." });
  });
}
module.exports = { registerAuth };
