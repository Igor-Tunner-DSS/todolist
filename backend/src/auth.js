import crypto from 'node:crypto';
import express from 'express';
import { pool } from './db.js';
import { config } from './config.js';
import { randomToken, sha256 } from './crypto.js';

// Autenticação mínima: o projeto não tinha usuários. Sessão = cookie httpOnly com token
// aleatório; só o hash SHA-256 do token é guardado no banco. O ID do usuário nunca vem do cliente.

const SESSION_DAYS = 14;
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
    const [alg, s, h] = String(stored).split('$');
    if (alg !== 'scrypt' || !s || !h) return false;
    const expected = Buffer.from(h, 'base64');
    const got = await scrypt(pw, Buffer.from(s, 'base64'));
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

export function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function setSessionCookie(res, token, maxAgeSec) {
    const parts = [`sid=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (config().cookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

async function createSession(res, userId) {
    const token = randomToken(32);
    await pool.query(
        'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))',
        [sha256(token), userId, SESSION_DAYS]
    );
    setSessionCookie(res, token, SESSION_DAYS * 86400);
}

// Define req.user (ou deixa indefinido). Nunca confia em IDs vindos do corpo/consulta.
export async function sessionMiddleware(req, _res, next) {
    try {
        const token = parseCookies(req.headers.cookie).sid;
        if (token) {
            const [[row]] = await pool.query(
                `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()`,
                [sha256(token)]
            );
            if (row) req.user = { id: row.id, email: row.email };
        }
        next();
    } catch (e) { next(e); }
}

export function requireUser(req, res, next) {
    if (!req.user) return res.status(401).send({ code: 'UNAUTHENTICATED', message: 'Sessão expirada. Entre novamente.' });
    next();
}

// Proteção CSRF para rotas que alteram estado: exige um cabeçalho personalizado, que um
// formulário/navegação de outro site não consegue enviar (CORS barra a pré-verificação).
export function csrfGuard(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-requested-with'] !== 'todolist') return res.status(403).send({ code: 'CSRF', message: 'Requisição não autorizada.' });
    next();
}

const attempts = new Map(); // limitador simples em memória: 10 tentativas / 5 min por IP+e-mail
function tooMany(key) {
    const now = Date.now();
    const list = (attempts.get(key) || []).filter((t) => now - t < 300000);
    list.push(now); attempts.set(key, list);
    return list.length > 10;
}
export const _resetAttempts = () => attempts.clear();

const validEmail = (e) => typeof e === 'string' && e.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export const authRouter = express.Router();

authRouter.post('/register', async (req, res) => {
    if (!config().signupEnabled) return res.status(403).send({ message: 'Cadastro desativado.' });
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!validEmail(email)) return res.status(400).send({ message: 'Informe um e-mail válido.' });
    if (password.length < 8 || password.length > 200) return res.status(400).send({ message: 'A senha deve ter de 8 a 200 caracteres.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM users');
        const [r] = await conn.query('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, await hashPassword(password)]);
        // Compatibilidade: as tarefas já existentes não tinham dono. O primeiro usuário cadastrado as adota.
        if (n === 0) await conn.query('UPDATE tasks SET user_id = ? WHERE user_id IS NULL', [r.insertId]);
        await conn.commit();
        await createSession(res, r.insertId);
        return res.status(201).send({ id: r.insertId, email });
    } catch (e) {
        await conn.rollback();
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).send({ message: 'Este e-mail já está cadastrado.' });
        throw e;
    } finally { conn.release(); }
});

authRouter.post('/login', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (tooMany(`${req.ip}|${email}`)) return res.status(429).send({ message: 'Muitas tentativas. Aguarde alguns minutos.' });
    const [[u]] = await pool.query('SELECT id, email, password_hash FROM users WHERE email = ?', [email]);
    const ok = u ? await verifyPassword(password, u.password_hash) : (await verifyPassword(password, 'scrypt$AAAA$AAAA'), false);
    if (!ok) return res.status(401).send({ message: 'E-mail ou senha incorretos.' });
    await createSession(res, u.id);
    return res.send({ id: u.id, email: u.email });
});

authRouter.post('/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
    setSessionCookie(res, '', 0);
    return res.status(204).send();
});

authRouter.get('/me', (req, res) => {
    if (!req.user) return res.status(401).send({ code: 'UNAUTHENTICATED', message: 'Não autenticado.' });
    return res.send(req.user);
});
