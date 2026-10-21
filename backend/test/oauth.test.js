import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, wipe, startApp, signup, connectGoogle, G } from './helpers.js';
import { decrypt } from '../src/crypto.js';
import { scenario, STUDY, WORK, SP, tasksOf } from './fixtures.js';

const KEY = process.env.TOKEN_ENCRYPTION_KEY;

test('1. usuário conecta a conta Google (OAuth com PKCE, state e somente leitura)', async (t) => {
    const { ctx, fake, A, conn } = await scenario(t);
    const u = new URL(conn.authUrl);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(u.searchParams.get('code_challenge'));
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('redirect_uri'), process.env.GOOGLE_REDIRECT_URI);
    const scopes = u.searchParams.get('scope').split(' ');
    assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.events.readonly'));
    assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.calendarlist.readonly'));
    for (const s of scopes.filter((s) => s.includes('/auth/calendar'))) assert.match(s, /readonly$/, `escopo de escrita solicitado: ${s}`);
    assert.ok(!scopes.includes('https://www.googleapis.com/auth/calendar'));

    const st = (await A.get(`${G}/status`)).body;
    assert.equal(st.connected, true);
    assert.equal(st.account.email, 'sub-a@gmail.com');
    assert.equal(st.state, 'active');
    assert.equal(st.configured, true);
    assert.equal(st.selectedCalendars, 0);

    // tokens: criptografados em repouso e nunca expostos ao cliente
    const [[row]] = await pool.query('SELECT * FROM google_connections');
    const { at, rt } = fake.lastIssued;
    assert.ok(row.access_token_enc.startsWith('v1:') && row.refresh_token_enc.startsWith('v1:'));
    assert.ok(!JSON.stringify(row).includes(at) && !JSON.stringify(row).includes(rt));
    assert.equal(decrypt(row.refresh_token_enc, KEY), rt);
    for (const body of [st, (await A.get(`${G}/calendars`)).body]) {
        const s = JSON.stringify(body);
        assert.ok(!s.includes(at) && !s.includes(rt) && !/token/i.test(s.replace(/"lastSyncStatus"/g, '')), 'resposta não pode conter tokens');
    }
});

test('15 (seg.). state: uso único, expira, pertence ao usuário e exige sessão', async (t) => {
    const { ctx, fake, A } = await scenario(t);
    const mk = async () => {
        const r = await A.post(`${G}/connect`);
        return new URL(r.body.url).searchParams.get('state');
    };
    // reuso (replay)
    let state = await mk();
    let r = await A.get(`${G}/callback?code=${fake.issueCode('sub-a')}&state=${state}`);
    assert.match(r.location, /google=connected/);
    r = await A.get(`${G}/callback?code=${fake.issueCode('sub-a')}&state=${state}`);
    assert.match(r.location, /google=error.*bad_state/);
    // state inventado / ausente
    r = await A.get(`${G}/callback?code=x&state=inventado`);
    assert.match(r.location, /bad_state/);
    r = await A.get(`${G}/callback?code=x`);
    assert.match(r.location, /bad_state/);
    // expirado
    state = await mk();
    await pool.query("UPDATE google_oauth_states SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)");
    r = await A.get(`${G}/callback?code=${fake.issueCode('sub-a')}&state=${state}`);
    assert.match(r.location, /bad_state/);
    // state gerado por A, apresentado por B (sessão diferente)
    state = await mk();
    const B = ctx.client(); await signup(B, 'b@teste.com');
    r = await B.get(`${G}/callback?code=${fake.issueCode('sub-b')}&state=${state}`);
    assert.match(r.location, /bad_state/);
    assert.equal((await B.get(`${G}/status`)).body.connected, false);
    // sem sessão
    const anon = ctx.client();
    state = await mk();
    r = await anon.get(`${G}/callback?code=x&state=${state}`);
    assert.match(r.location, /google=session_expired/);
});

test('1 (seg.). autorização cancelada e escopos insuficientes', async (t) => {
    const { ctx, fake } = await scenario(t);
    const B = ctx.client(); await signup(B, 'b@teste.com');
    fake.addAccount('sub-b', 'b@gmail.com', [STUDY]);
    let state = new URL((await B.post(`${G}/connect`)).body.url).searchParams.get('state');
    let r = await B.get(`${G}/callback?error=access_denied&state=${state}`);
    assert.match(r.location, /google=denied/);
    assert.equal((await B.get(`${G}/status`)).body.connected, false);
    // usuário desmarcou as permissões de calendário na tela de consentimento
    state = new URL((await B.post(`${G}/connect`)).body.url).searchParams.get('state');
    r = await B.get(`${G}/callback?code=${fake.issueCode('sub-b', 'https://www.googleapis.com/auth/userinfo.email')}&state=${state}`);
    assert.match(r.location, /google=error.*insufficient_scope/);
    assert.equal((await B.get(`${G}/status`)).body.connected, false);
});

test('15 (seg.). rotas exigem sessão e cabeçalho anti-CSRF; ID de usuário do cliente é ignorado', async (t) => {
    const { ctx, A } = await scenario(t, { select: [STUDY.id] });
    const anon = ctx.client();
    for (const [m, p] of [['get', '/status'], ['get', '/calendars'], ['post', '/sync'], ['post', '/connect'], ['post', '/disconnect'], ['put', '/settings'], ['post', '/sync/weeks']]) {
        const r = await anon[m](G + p, m === 'get' ? undefined : {});
        assert.equal(r.status, 401, `${m} ${p}`);
    }
    assert.equal((await anon.get('/api/tasks')).status, 401);
    // POST/PUT sem o cabeçalho X-Requested-With
    for (const [m, p] of [['post', '/sync'], ['post', '/disconnect'], ['put', '/calendars']]) {
        const r = await A[m](G + p, {}, { csrf: false });
        assert.equal(r.status, 403, `${m} ${p}`);
    }
    assert.equal((await A.post('/api/tasks', { title: 'x' }, { csrf: false })).status, 403);
    // userId no corpo/consulta não muda de quem são os dados
    const B = ctx.client(); await signup(B, 'b@teste.com');
    const r = await B.post(`${G}/sync`, { userId: 1 });
    assert.equal(r.status, 404); // B não tem conexão, mesmo "pedindo" o usuário 1
    assert.equal((await B.get('/api/tasks?userId=1')).body.tasks.length, 0);
    assert.ok((await tasksOf(A)).length > 0);
});

test('2. outro usuário conecta outra conta e não acessa os dados do primeiro', async (t) => {
    const { ctx, fake, A } = await scenario(t, { select: [STUDY.id, WORK.id] });
    const aTasks = await tasksOf(A);
    assert.ok(aTasks.length >= 4);

    const personal = { id: 'cal-b', summary: 'Pessoal B', timeZone: SP };
    fake.addAccount('sub-b', 'b@gmail.com', [personal]);
    fake.add('cal-b', { id: 'ev-b1', summary: 'Dentista', start: { dateTime: '2026-10-23T09:00:00-03:00' }, end: { dateTime: '2026-10-23T10:00:00-03:00' } });
    const B = ctx.client(); await signup(B, 'b@teste.com');
    assert.equal((await B.get(`${G}/status`)).body.connected, false);
    assert.equal((await B.get(`${G}/calendars`)).status, 404);
    await connectGoogle(B, ctx, 'sub-b');

    const bs = (await B.get(`${G}/status`)).body;
    assert.equal(bs.account.email, 'b@gmail.com');
    const cals = (await B.get(`${G}/calendars`)).body.calendars;
    assert.deepEqual(cals.map((c) => c.id), ['cal-b']);
    // B não pode selecionar calendários de A
    assert.equal((await B.put(`${G}/calendars`, { selected: [STUDY.id] })).status, 400);
    assert.equal((await B.put(`${G}/calendars`, { selected: ['cal-b'] })).status, 200);

    const bTasks = await tasksOf(B);
    assert.deepEqual(bTasks.map((x) => x.title), ['Dentista']);
    const aAfter = await tasksOf(A);
    assert.equal(aAfter.length, aTasks.length);
    assert.ok(!aAfter.some((x) => x.title === 'Dentista'));
    // acesso cruzado a tarefas de A
    const victim = aAfter[0].id;
    assert.equal((await B.patch(`/api/tasks/${victim}`, { completed: true })).status, 404);
    assert.equal((await B.del(`/api/tasks/${victim}`)).status, 404);
    assert.equal(Boolean((await tasksOf(A)).find((x) => x.id === victim).completed), false);
    // B desconectar não afeta A
    assert.equal((await B.post(`${G}/disconnect`, { tasks: 'remove' })).status, 200);
    assert.equal((await A.get(`${G}/status`)).body.connected, true);
    assert.equal((await tasksOf(A)).length, aTasks.length);
    // cada usuário tem tokens próprios
    const [rows] = await pool.query('SELECT user_id, google_account_id FROM google_connections');
    assert.equal(rows.length, 1);
});

test('17. desconectar e manter cópias locais preserva as tarefas e encerra a sincronização', async (t) => {
    const { ctx, fake, A } = await scenario(t, { select: [STUDY.id, WORK.id] });
    const before = await tasksOf(A);
    const imported = before.filter((x) => x.source === 'google');
    assert.ok(imported.length >= 4);

    let r = await A.post(`${G}/disconnect`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CHOICE_REQUIRED');
    assert.equal(r.body.affectedTasks, imported.length);
    assert.equal((await A.get(`${G}/status`)).body.connected, true); // nada mudou sem confirmação

    r = await A.post(`${G}/disconnect`, { tasks: 'keep' });
    assert.equal(r.status, 200);
    assert.equal(r.body.tokenRevoked, true);
    assert.ok(fake.calls.some((c) => c.path === '/revoke'), 'token revogado no Google');
    assert.deepEqual((await A.get(`${G}/status`)).body.connected, false);

    const after = await tasksOf(A);
    assert.equal(after.length, before.length);
    // cópias locais: sem vínculo -> evento excluído no Google não as afeta
    const [links] = await pool.query('SELECT COUNT(*) n FROM google_event_links'); assert.equal(links[0].n, 0);
    const [conns] = await pool.query('SELECT COUNT(*) n FROM google_connections'); assert.equal(conns[0].n, 0);
    // nova sincronização é impossível
    assert.equal((await A.post(`${G}/sync`)).status, 404);
    const callsBefore = fake.calls.length;
    await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-19'] });
    assert.equal(fake.calls.length, callsBefore, 'nenhuma chamada ao Google após desconectar');
});

test('18. desconectar e remover apaga só as importadas; nativas e dados de outros usuários ficam', async (t) => {
    const { ctx, fake, A } = await scenario(t, { select: [STUDY.id, WORK.id] });
    await A.post('/api/tasks', { title: 'Tarefa nativa', dueDate: '2026-10-20' });
    await A.post('/api/tasks', { title: 'Prova de Cálculo', dueDate: '2026-10-20' }); // mesmo título/data de um evento
    fake.addAccount('sub-b', 'b@gmail.com', [{ id: 'cal-b', summary: 'B', timeZone: SP }]);
    fake.add('cal-b', { id: 'ev-b', summary: 'Evento do B', start: { dateTime: '2026-10-23T09:00:00-03:00' }, end: { dateTime: '2026-10-23T10:00:00-03:00' } });
    const B = ctx.client(); await signup(B, 'b@teste.com'); await connectGoogle(B, ctx, 'sub-b');
    await B.put(`${G}/calendars`, { selected: ['cal-b'] });

    const r = await A.post(`${G}/disconnect`, { tasks: 'remove' });
    assert.equal(r.status, 200);
    const left = await tasksOf(A);
    assert.deepEqual(left.map((x) => x.title).sort(), ['Prova de Cálculo', 'Tarefa nativa']);
    assert.ok(left.every((x) => x.source === 'local'));
    assert.deepEqual((await tasksOf(B)).map((x) => x.title), ['Evento do B']);
    assert.equal((await B.get(`${G}/status`)).body.connected, true);
    const [[tk]] = await pool.query('SELECT COUNT(*) n FROM google_connections'); assert.equal(tk.n, 1);
});
