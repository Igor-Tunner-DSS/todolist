import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTask, stripMeta, cleanDescription, weekStartOf, isISODate, META_HEADER } from '../src/google/mapping.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { readIdToken, createGoogleClient, SCOPES, GoogleError } from '../src/google/client.js';

const cal = { calendarName: 'Estudos', calendarTz: 'America/Sao_Paulo' };
const count = (s, sub) => s.split(sub).length - 1;

test('5/6. mapeia título, data, horário, término, local e calendário', () => {
    const t = buildTask({ summary: 'Prova de Cálculo', description: 'Cap. 3 e 4', location: 'Biblioteca\nBloco B',
        start: { dateTime: '2026-10-20T14:00:00-03:00' }, end: { dateTime: '2026-10-20T16:00:00-03:00' } }, cal);
    assert.equal(t.title, 'Prova de Cálculo');
    assert.equal(t.due_date, '2026-10-20');
    assert.equal(t.original, 'Cap. 3 e 4');
    assert.match(t.description, /^Cap\. 3 e 4\n\n---\nImportado do Google Calendar\nHorário: 14:00–16:00\nFuso horário: America\/Sao_Paulo\nLocal: Biblioteca, Bloco B\nCalendário: Estudos$/);
    assert.equal(count(t.description, 'Importado do Google Calendar'), 1);
});

test('6. o bloco de metadados é substituído, nunca duplicado', () => {
    const first = buildTask({ summary: 'X', description: 'orig', start: { dateTime: '2026-10-20T10:00:00-03:00' }, end: { dateTime: '2026-10-20T11:00:00-03:00' } }, cal);
    assert.equal(stripMeta(first.description), 'orig');
    // regerar a partir do mesmo evento produz exatamente o mesmo texto
    const again = buildTask({ summary: 'X', description: stripMeta(first.description), start: { dateTime: '2026-10-20T10:00:00-03:00' }, end: { dateTime: '2026-10-20T11:00:00-03:00' } }, cal);
    assert.equal(again.description, first.description);
    assert.equal(count(again.description, META_HEADER), 1);
});

test('evento sem título, sem descrição e sem fim não quebra', () => {
    const t = buildTask({ start: { dateTime: '2026-10-20T09:30:00-03:00' } }, { calendarName: '', calendarTz: null });
    assert.equal(t.title, '(Sem título)');
    assert.equal(t.original, '');
    assert.match(t.description, /^---\nImportado do Google Calendar\nHorário: /);
    assert.equal(buildTask({ summary: 'sem início' }, cal), null);
    assert.equal(buildTask({ summary: 'x', start: {} }, cal), null);
});

test('dia inteiro não inventa horário; multi-dia mostra o término (fim é exclusivo)', () => {
    const one = buildTask({ summary: 'Feriado', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } }, cal);
    assert.equal(one.due_date, '2026-11-02');
    assert.equal(one.allDay, true);
    assert.match(one.description, /Horário: Dia inteiro/);
    assert.doesNotMatch(one.description, /Término/);
    const multi = buildTask({ summary: 'Viagem', start: { date: '2026-12-30' }, end: { date: '2027-01-03' } }, cal);
    assert.match(multi.description, /Término: 02\/01\/2027/); // virada de ano
});

test('fuso horário define a data local (não a data UTC) e eventos atravessam a meia-noite', () => {
    // 01:30Z em 26/10 é 22:30 de 25/10 em São Paulo
    const t = buildTask({ summary: 'Noite', start: { dateTime: '2026-10-26T01:30:00Z', timeZone: 'America/Sao_Paulo' }, end: { dateTime: '2026-10-26T04:00:00Z', timeZone: 'America/Sao_Paulo' } }, cal);
    assert.equal(t.due_date, '2026-10-25');
    assert.match(t.description, /Horário: 22:30\nTérmino: 26\/10\/2026 01:00/);
});

test('horário de verão: usa o deslocamento do fuso na data do evento', () => {
    // Lisboa: DST termina em 25/10/2026 (01:00 UTC). 23:30 UTC de 24/10 ainda é 00:30 do dia 25 (UTC+1).
    const t = buildTask({ summary: 'DST', start: { dateTime: '2026-10-24T23:30:00Z', timeZone: 'Europe/Lisbon' }, end: { dateTime: '2026-10-25T00:30:00Z', timeZone: 'Europe/Lisbon' } }, cal);
    assert.equal(t.due_date, '2026-10-25');
    assert.match(t.description, /Horário: 00:30–01:30/);
});

test('HTML da descrição é tratado como texto não confiável', () => {
    const d = cleanDescription('<p>Olá<br>mundo</p><script>alert(1)</script> &amp; fim');
    assert.doesNotMatch(d, /<|>/);
    assert.match(d, /Olá\nmundo/);
});

test('semana começa na segunda e cruza virada de mês/ano', () => {
    assert.equal(weekStartOf('2026-10-19'), '2026-10-19');
    assert.equal(weekStartOf('2026-10-25'), '2026-10-19'); // domingo
    assert.equal(weekStartOf('2027-01-01'), '2026-12-28'); // virada de ano
    assert.equal(weekStartOf('2026-11-01'), '2026-10-26'); // virada de mês
    assert.ok(isISODate('2026-02-28')); assert.ok(!isISODate('2026-02-30')); assert.ok(!isISODate('abc'));
});

test('criptografia AES-GCM: ida e volta, adulteração e chave errada falham', () => {
    const key = Buffer.alloc(32, 1).toString('base64');
    const enc = encrypt('refresh-token-secreto', key);
    assert.ok(!enc.includes('refresh-token-secreto'));
    assert.equal(decrypt(enc, key), 'refresh-token-secreto');
    assert.notEqual(encrypt('a', key), encrypt('a', key)); // IV aleatório
    const parts = enc.split(':'); parts[3] = Buffer.from('xxxxxxxx').toString('base64');
    assert.throws(() => decrypt(parts.join(':'), key));
    assert.throws(() => decrypt(enc, Buffer.alloc(32, 2).toString('base64')));
    assert.throws(() => encrypt('a', 'curta'));
});

test('escopos: somente leitura (nenhum escopo de escrita)', () => {
    const calendar = SCOPES.filter((s) => s.includes('googleapis.com/auth/calendar'));
    assert.deepEqual(calendar.sort(), [
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly',
    ]);
    for (const s of calendar) assert.match(s, /readonly$/);
});

test('id_token: confere emissor, público e validade', () => {
    const mk = (c) => ['x', Buffer.from(JSON.stringify(c)).toString('base64url'), 'x'].join('.');
    const ok = { iss: 'https://accounts.google.com', aud: 'cid', sub: '42', email: 'a@b.c', exp: Math.floor(Date.now() / 1000) + 60 };
    assert.deepEqual(readIdToken(mk(ok), 'cid'), { sub: '42', email: 'a@b.c' });
    assert.throws(() => readIdToken(mk({ ...ok, aud: 'outro' }), 'cid'), GoogleError);
    assert.throws(() => readIdToken(mk({ ...ok, iss: 'https://evil.com' }), 'cid'), GoogleError);
    assert.throws(() => readIdToken(mk({ ...ok, exp: 1 }), 'cid'), GoogleError);
});

test('cliente: Calendar API só emite GET; backoff é limitado e não entra em laço infinito', async () => {
    const calls = []; const sleeps = [];
    const fetchImpl = async (url, init) => { calls.push(init.method); return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }) }; };
    const g = createGoogleClient({ fetchImpl, sleep: async (ms) => sleeps.push(ms), maxAttempts: 4, random: () => 0 });
    await assert.rejects(() => g.listEvents('t', 'cal', {}), (e) => e instanceof GoogleError && e.temporary && e.status === 429);
    assert.equal(calls.length, 4);
    assert.deepEqual(sleeps, [500, 1000, 2000]); // exponencial, sem espera após a última tentativa
    assert.ok(calls.every((m) => m === 'GET'));
    for (const forbidden of ['insert', 'update', 'patch', 'delete', 'quickAdd', 'move', 'import']) assert.equal(g[forbidden], undefined);
});
