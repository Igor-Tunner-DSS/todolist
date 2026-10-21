import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, resetDb, startApp, signup, wipe } from './helpers.js';
import { migrate } from '../src/migrate.js';

test('migração: preserva tarefas legadas, é idempotente e o primeiro usuário as adota', async (t) => {
    await resetDb({ legacyTasks: [['Tarefa antiga 1', '2026-10-20'], ['Tarefa antiga 2', null]] });
    // idempotente: rodar de novo não faz nada e não perde dados
    assert.deepEqual(await migrate(pool), []);
    const [[a]] = await pool.query('SELECT COUNT(*) n FROM tasks'); assert.equal(a.n, 2);
    const [cols] = await pool.query("SELECT column_name c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tasks'");
    for (const c of ['id', 'title', 'description', 'completed', 'due_date', 'user_id', 'source']) assert.ok(cols.some((x) => x.c === c), c);
    const [[d]] = await pool.query("SELECT source FROM tasks LIMIT 1"); assert.equal(d.source, 'local', 'tarefas legadas viram nativas');

    const ctx = await startApp(); t.after(() => ctx.close());
    const A = ctx.client(), B = ctx.client();
    await signup(A, 'primeiro@teste.com');
    await signup(B, 'segundo@teste.com');
    const aTasks = (await A.get('/api/tasks')).body;
    assert.deepEqual(aTasks.tasks.map((x) => x.title).sort(), ['Tarefa antiga 1', 'Tarefa antiga 2']);
    assert.ok(aTasks.tasks.every((x) => x.source === 'local'));
    assert.equal((await B.get('/api/tasks')).body.tasks.length, 0);
});

test('20. funcionalidades existentes continuam: criar, buscar, editar, concluir, excluir, contagens', async (t) => {
    await resetDb();
    await wipe();
    const ctx = await startApp(); t.after(() => ctx.close());
    const A = ctx.client(); await signup(A, 'a@teste.com');
    assert.equal((await A.post('/api/tasks', { title: '   ' })).status, 400);
    const t1 = (await A.post('/api/tasks', { title: 'Estudar', dueDate: '2026-10-20' })).body;
    const t2 = (await A.post('/api/tasks', { title: 'Comprar pão' })).body;
    assert.equal(t1.source, 'local');
    let list = (await A.get('/api/tasks')).body;
    assert.equal(list.total, 2); assert.equal(list.completed, 0);
    assert.deepEqual((await A.get('/api/tasks?search=pão')).body.tasks.map((x) => x.id), [t2.id]);
    // concluir NÃO pode apagar a data (bug corrigido: `typeof dueDate !== undefined` era sempre verdadeiro)
    let r = await A.patch(`/api/tasks/${t1.id}`, { completed: true });
    assert.equal(r.body.due_date.slice(0, 10), '2026-10-20');
    assert.equal((await A.get('/api/tasks?status=completed')).body.tasks.length, 1);
    assert.equal((await A.get('/api/tasks?status=pending')).body.tasks.length, 1);
    r = await A.patch(`/api/tasks/${t1.id}`, { dueDate: null });
    assert.equal(r.body.due_date, null);
    r = await A.patch(`/api/tasks/${t1.id}`, { title: 'Estudar mais', dueDate: '2026-11-01' });
    assert.equal(r.body.title, 'Estudar mais');
    assert.equal((await A.patch(`/api/tasks/${t1.id}`, {})).status, 400); // sem campos: 400 e nada é alterado
    assert.equal((await A.get('/api/tasks')).body.tasks.find((x) => x.id === t1.id).due_date.slice(0, 10), '2026-11-01');
    assert.equal((await A.patch('/api/tasks/999999', { completed: true })).status, 404);
    assert.equal((await A.del(`/api/tasks/${t2.id}`)).status, 204);
    assert.equal((await A.del(`/api/tasks/${t2.id}`)).status, 404);
    list = (await A.get('/api/tasks')).body;
    assert.equal(list.total, 1); assert.equal(list.completed, 1);
    // /health continua público
    assert.equal((await ctx.client().get('/health')).body.status, 'ok');
});

test('autenticação: cadastro, login, logout, senha fraca, e-mail duplicado, sessão por cookie httpOnly', async (t) => {
    await resetDb(); await wipe();
    const ctx = await startApp(); t.after(() => ctx.close());
    const A = ctx.client();
    assert.equal((await A.post('/api/auth/register', { email: 'x', password: '12345678' })).status, 400);
    assert.equal((await A.post('/api/auth/register', { email: 'a@b.co', password: 'curta' })).status, 400);
    const reg = await A.call('POST', '/api/auth/register', { email: 'A@B.co', password: 'senha-forte-123' });
    assert.equal(reg.status, 201);
    const cookie = reg.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    assert.equal((await ctx.client().post('/api/auth/register', { email: 'a@b.co', password: 'senha-forte-123' })).status, 409);
    const [[s]] = await pool.query('SELECT token_hash FROM sessions'); // só o hash é guardado
    assert.equal(s.token_hash.length, 64); assert.ok(!cookie.includes(s.token_hash));
    const [[u]] = await pool.query('SELECT password_hash FROM users'); assert.match(u.password_hash, /^scrypt\$/); assert.ok(!u.password_hash.includes('senha-forte'));
    assert.equal((await A.get('/api/auth/me')).body.email, 'a@b.co');
    assert.equal((await A.post('/api/auth/logout')).status, 204);
    assert.equal((await A.get('/api/auth/me')).status, 401);
    const L = ctx.client();
    assert.equal((await L.post('/api/auth/login', { email: 'a@b.co', password: 'errada-errada' })).status, 401);
    assert.equal((await L.post('/api/auth/login', { email: 'a@b.co', password: 'senha-forte-123' })).status, 200);
    assert.equal((await L.get('/api/tasks')).status, 200);
});
