import './env.js';
import http from 'node:http';
import { after } from 'node:test';
import fs from 'node:fs';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { createGoogleClient } from '../src/google/client.js';
import { createSyncService } from '../src/google/sync.js';
import { createFakeGoogle } from './fake-google.js';
import { _resetAttempts } from '../src/auth.js';

export { pool };
after(() => pool.end()); // encerra o pool ao final de cada arquivo de teste
const TABLES = ['google_week_fetches', 'google_oauth_states', 'google_event_links', 'google_calendars', 'google_connections', 'sessions', 'tasks', 'users', 'schema_migrations'];

// Recria o banco de teste: tabela `tasks` LEGADA (schema.sql original) + migrações.
export async function resetDb({ legacyTasks = [] } = {}) {
    const c = await pool.getConnection();
    try {
        await c.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const t of TABLES) await c.query(`DROP TABLE IF EXISTS ${t}`);
        await c.query('SET FOREIGN_KEY_CHECKS = 1');
        const base = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/CREATE DATABASE[\s\S]*?;\s*USE todolist;/i, '');
        await c.query(base);
        for (const [title, due] of legacyTasks) await c.query('INSERT INTO tasks (title, due_date) VALUES (?, ?)', [title, due]);
    } finally { c.release(); }
    await migrate(pool);
}

export async function wipe() {
    const c = await pool.getConnection();
    try {
        await c.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const t of TABLES.filter((t) => t !== 'schema_migrations')) await c.query(`TRUNCATE TABLE ${t}`);
        await c.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { c.release(); }
    _resetAttempts();
}

// Cliente HTTP com jar de cookies; envia o cabeçalho anti-CSRF por padrão.
export class Client {
    constructor(base) { this.base = base; this.cookie = ''; }
    async call(method, path, body, { csrf = true, redirect = 'manual', headers = {} } = {}) {
        const h = { ...headers };
        if (body !== undefined) h['Content-Type'] = 'application/json';
        if (csrf) h['X-Requested-With'] = 'todolist';
        if (this.cookie) h.Cookie = this.cookie;
        const res = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect });
        for (const sc of res.headers.getSetCookie?.() ?? []) { const kv = sc.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
        const text = await res.text();
        let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
        return { status: res.status, body: data, location: res.headers.get('location'), headers: res.headers };
    }
    get(p, o) { return this.call('GET', p, undefined, o); }
    post(p, b, o) { return this.call('POST', p, b ?? {}, o); }
    put(p, b, o) { return this.call('PUT', p, b, o); }
    patch(p, b, o) { return this.call('PATCH', p, b, o); }
    del(p, o) { return this.call('DELETE', p, undefined, o); }
}

// Sobe a aplicação com Google falso e relógio controlável.
export async function startApp({ now = '2026-10-19T12:00:00Z' } = {}) {
    const fake = createFakeGoogle();
    const clock = { t: Date.parse(now) };
    fake.now = () => clock.t;
    const sleeps = [];
    const google = createGoogleClient({ fetchImpl: fake.fetch, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
    const service = createSyncService({ google, now: () => new Date(clock.t) });
    const app = createApp({ google, service, logger: false });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        fake, clock, sleeps, service, base, google,
        advance: (ms) => { clock.t += ms; },
        client: () => new Client(base),
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }),
    };
}

export async function signup(client, email, password = 'senha-forte-123') {
    const r = await client.post('/api/auth/register', { email, password });
    if (r.status !== 201) throw new Error(`register falhou: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
}

// Fluxo OAuth completo (connect -> callback) usando o Google falso.
export async function connectGoogle(client, ctx, sub) {
    const c = await client.post('/api/integrations/google/connect');
    if (c.status !== 200) throw new Error(`connect falhou: ${c.status}`);
    const state = new URL(c.body.url).searchParams.get('state');
    const code = ctx.fake.issueCode(sub);
    const cb = await client.get(`/api/integrations/google/callback?code=${code}&state=${state}`);
    return { authUrl: c.body.url, state, callback: cb };
}

export const G = '/api/integrations/google';
export const names = async (client) => (await client.get('/api/tasks')).body.tasks.map((t) => t.title).sort();
