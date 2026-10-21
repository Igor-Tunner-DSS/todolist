import assert from 'node:assert/strict';
import { startApp, signup, connectGoogle, wipe, resetDb, G } from './helpers.js';

let ready; // esquema legado + migrações, criado uma vez por arquivo de teste (cada arquivo é um processo)

export const SP = 'America/Sao_Paulo';
export const STUDY = { id: 'cal-study', summary: 'Estudos', timeZone: SP, backgroundColor: '#7986cb' };
export const WORK = { id: 'cal-work', summary: 'Trabalho', timeZone: SP, backgroundColor: '#33b679' };

export const timed = (id, summary, start, end, extra = {}) => ({ id, summary, start: { dateTime: start }, end: { dateTime: end }, ...extra });
export const allDay = (id, summary, start, end, extra = {}) => ({ id, summary, start: { date: start }, end: { date: end }, ...extra });

// "Hoje" nos testes = 2026-10-19 (segunda). Intervalo padrão = 2026-09-19 .. 2027-01-17.
export function seedEvents(fake) {
    const e = {};
    e.prova = fake.add(STUDY.id, timed('ev-prova', 'Prova de Cálculo', '2026-10-20T14:00:00-03:00', '2026-10-20T16:00:00-03:00', { description: 'Cap. 3 e 4', location: 'Biblioteca' }));
    e.feriado = fake.add(STUDY.id, allDay('ev-feriado', 'Feriado', '2026-11-02', '2026-11-03'));
    e.semTitulo = fake.add(STUDY.id, { id: 'ev-sem-titulo', start: { dateTime: '2026-10-21T09:00:00-03:00' }, end: { dateTime: '2026-10-21T09:30:00-03:00' } });
    e.foraDoIntervalo = fake.add(STUDY.id, timed('ev-fora', 'Evento distante', '2027-06-01T10:00:00-03:00', '2027-06-01T11:00:00-03:00'));
    e.reuniao = fake.add(WORK.id, timed('ev-reuniao', 'Reunião de equipe', '2026-10-22T10:00:00-03:00', '2026-10-22T11:00:00-03:00', { location: 'Sala 2' }));
    return e;
}

// Série semanal (terças 10:00 -03:00) com instâncias pré-calculadas pela "API".
export function seedSeries(fake, calId = STUDY.id) {
    const master = fake.add(calId, { id: 'm1', _kind: 'master', summary: 'Aula semanal', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
        start: { dateTime: '2026-10-06T10:00:00-03:00', timeZone: SP }, end: { dateTime: '2026-10-06T11:00:00-03:00', timeZone: SP } });
    const inst = {};
    for (const d of ['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10', '2027-02-02']) {
        const key = d.replaceAll('-', '');
        inst[d] = fake.add(calId, { id: `m1_${key}T130000Z`, _kind: 'instance', recurringEventId: 'm1', summary: 'Aula semanal',
            originalStartTime: { dateTime: `${d}T10:00:00-03:00` },
            start: { dateTime: `${d}T10:00:00-03:00`, timeZone: SP }, end: { dateTime: `${d}T11:00:00-03:00`, timeZone: SP } });
    }
    return { master, inst };
}

// Sobe app + usuário A conectado ao Google falso. Ao final de cada teste, exige zero escritas no Google.
export async function scenario(t, { select = null, seed = true, email = 'a@teste.com', sub = 'sub-a', startOpts } = {}) {
    await (ready ??= resetDb());
    await wipe();
    const ctx = await startApp(startOpts);
    t.after(async () => {
        try {
            assert.deepEqual(ctx.fake.writes(), [], 'NENHUMA escrita pode ser feita no Google Calendar');
            const posts = ctx.fake.calls.filter((c) => c.method !== 'GET').map((c) => c.host + c.path);
            assert.ok(posts.every((p) => p.startsWith('oauth2.googleapis.com/')), `POST/PUT inesperado: ${posts}`);
        } finally { await ctx.close(); }
    });
    ctx.fake.addAccount(sub, `${sub}@gmail.com`, [STUDY, WORK]);
    const events = seed ? seedEvents(ctx.fake) : {};
    const A = ctx.client();
    await signup(A, email);
    const conn = await connectGoogle(A, ctx, sub);
    assert.match(conn.callback.location, /google=connected/);
    if (select) {
        const r = await A.put(`${G}/calendars`, { selected: select });
        assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    return { ctx, fake: ctx.fake, A, events, conn };
}

export const tasksOf = async (c) => (await c.get('/api/tasks')).body.tasks;
export const byTitle = (list, title) => list.filter((t) => t.title === title);
export const countMeta = (d) => (String(d).split('Importado do Google Calendar').length - 1);
