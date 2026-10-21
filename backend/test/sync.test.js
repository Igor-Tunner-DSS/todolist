import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, G } from './helpers.js';
import { scenario, seedSeries, tasksOf, byTitle, countMeta, STUDY, WORK, timed } from './fixtures.js';

const HOUR = 3600e3;

test('3. seleciona e desmarca calendários; só os selecionados são importados', async (t) => {
    const { A, fake } = await scenario(t);
    const list = (await A.get(`${G}/calendars`)).body.calendars;
    assert.deepEqual(list.map((c) => [c.id, c.summary, c.selected]), [['cal-study', 'Estudos', false], ['cal-work', 'Trabalho', false]]);
    assert.ok(list.every((c) => c.color));
    assert.equal((await tasksOf(A)).length, 0, 'nada é importado antes da seleção');

    let r = await A.put(`${G}/calendars`, { selected: [STUDY.id] });
    assert.equal(r.body.newlySelected, 1);
    assert.equal(r.body.sync.status, 'ok');
    let titles = (await tasksOf(A)).map((x) => x.title).sort();
    assert.deepEqual(titles, ['(Sem título)', 'Feriado', 'Prova de Cálculo']);
    assert.ok(!fake.eventCalls().some((c) => c.path.includes('cal-work')), 'calendário não selecionado nunca é consultado');

    r = await A.put(`${G}/calendars`, { selected: [STUDY.id, WORK.id] });
    assert.equal(r.body.newlySelected, 1);
    titles = (await tasksOf(A)).map((x) => x.title).sort();
    assert.deepEqual(titles, ['(Sem título)', 'Feriado', 'Prova de Cálculo', 'Reunião de equipe']); // sem duplicar os de Estudos

    // desmarcar exige escolha, e nada muda sem ela
    r = await A.put(`${G}/calendars`, { selected: [STUDY.id] });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CHOICE_REQUIRED');
    assert.equal(r.body.affectedTasks, 1);
    assert.equal((await tasksOf(A)).length, 4);
    assert.equal((await A.put(`${G}/calendars`, { selected: [STUDY.id] , onDeselect: 'apagar-tudo' })).status, 409);

    // manter como cópias locais
    await A.post('/api/tasks', { title: 'Nativa', dueDate: '2026-10-22' });
    r = await A.put(`${G}/calendars`, { selected: [STUDY.id], onDeselect: 'keep' });
    assert.equal(r.status, 200);
    assert.equal((await tasksOf(A)).length, 5);
    const [[ev]] = await pool.query("SELECT status FROM google_event_links WHERE event_id = 'ev-reuniao'");
    assert.equal(ev.status, 'detached');
    // o evento muda e some no Google: a cópia local não é tocada
    fake.change(fake.events[WORK.id][0], { summary: 'Reunião NOVA' });
    await A.post(`${G}/sync`);
    fake.change(fake.events[WORK.id][0], { status: 'cancelled' });
    await A.post(`${G}/sync`);
    assert.ok((await tasksOf(A)).some((x) => x.title === 'Reunião de equipe'));
    assert.equal(fake.eventCalls().filter((c) => c.path.includes('cal-work')).length, 1 /* só a importação inicial */);

    // remover as importadas de um calendário
    fake.change(fake.events[WORK.id][0], { status: 'confirmed', summary: 'Reunião de equipe' });
    await A.put(`${G}/calendars`, { selected: [STUDY.id, WORK.id] }); // re-seleção re-adota a cópia, sem duplicar
    assert.equal(byTitle(await tasksOf(A), 'Reunião de equipe').length, 1);
    r = await A.put(`${G}/calendars`, { selected: [STUDY.id], onDeselect: 'remove' });
    assert.equal(r.status, 200);
    titles = (await tasksOf(A)).map((x) => x.title).sort();
    assert.deepEqual(titles, ['(Sem título)', 'Feriado', 'Nativa', 'Prova de Cálculo']);
    assert.equal((await A.put(`${G}/calendars`, { selected: ['nao-existe'] })).status, 400);
});

test('4. intervalo configurável: importa só o intervalo; alterar sincroniza o novo período sem duplicar', async (t) => {
    const { A } = await scenario(t, { select: [STUDY.id] });
    const st = (await A.get(`${G}/status`)).body;
    assert.deepEqual(st.range, { start: '2026-09-19', end: '2027-01-17' });
    assert.ok(!(await tasksOf(A)).some((x) => x.title === 'Evento distante'));

    // validações
    for (const body of [{ rangeStart: '2026-12-01', rangeEnd: '2026-11-01' }, { rangeStart: 'x', rangeEnd: '2026-11-01' }, { rangeStart: '2020-01-01', rangeEnd: '2030-01-01' }]) {
        assert.equal((await A.put(`${G}/settings`, body)).status, 400);
    }
    // expandir: o evento distante entra; os demais não duplicam
    let r = await A.put(`${G}/settings`, { rangeStart: '2026-09-19', rangeEnd: '2027-12-31' });
    assert.equal(r.status, 200);
    let tasks = await tasksOf(A);
    assert.equal(byTitle(tasks, 'Evento distante').length, 1);
    assert.equal(byTitle(tasks, 'Prova de Cálculo').length, 1);
    assert.equal(tasks.length, 4);

    // encolher: exige escolha sobre as tarefas fora do novo intervalo
    r = await A.put(`${G}/settings`, { rangeStart: '2026-10-01', rangeEnd: '2026-10-31' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CHOICE_REQUIRED');
    assert.equal(r.body.affectedTasks, 2); // Feriado (02/11) e Evento distante
    assert.deepEqual((await A.get(`${G}/status`)).body.range, { start: '2026-09-19', end: '2027-12-31' }, 'sem escolha, nada muda');

    r = await A.put(`${G}/settings`, { rangeStart: '2026-10-01', rangeEnd: '2026-10-31', outside: 'keep' });
    assert.equal(r.status, 200);
    assert.equal((await tasksOf(A)).length, 4, 'cópias locais preservadas');
    r = await A.put(`${G}/settings`, { rangeStart: '2026-10-01', rangeEnd: '2026-10-20', outside: 'remove' });
    assert.equal(r.status, 200);
    assert.equal(r.body.outsideTasks, 1); // só a "(Sem título)" de 21/10 ainda estava ativa fora do intervalo
    // limites inclusivos: o dia final entra
    assert.ok((await tasksOf(A)).some((x) => x.title === 'Prova de Cálculo' && x.due_date.startsWith('2026-10-20')));
});

test('5-8. mapeamento correto, badge só nas importadas, sync repetida não duplica', async (t) => {
    const { A, fake, ctx } = await scenario(t, { select: [STUDY.id, WORK.id] });
    await A.post('/api/tasks', { title: 'Tarefa nativa', dueDate: '2026-10-20' });
    let tasks = await tasksOf(A);
    const prova = byTitle(tasks, 'Prova de Cálculo')[0];
    assert.equal(prova.due_date.slice(0, 10), '2026-10-20');
    assert.equal(prova.source, 'google');
    assert.equal(prova.description, 'Cap. 3 e 4\n\n---\nImportado do Google Calendar\nHorário: 14:00–16:00\nFuso horário: America/Sao_Paulo\nLocal: Biblioteca\nCalendário: Estudos');
    const fer = byTitle(tasks, 'Feriado')[0];
    assert.match(fer.description, /^---\nImportado do Google Calendar\nHorário: Dia inteiro\nCalendário: Estudos$/);
    assert.doesNotMatch(fer.description, /\d\d:\d\d/, 'dia inteiro não inventa horário');
    assert.equal(byTitle(tasks, '(Sem título)').length, 1);
    // badge: apenas importadas têm source=google
    assert.equal(byTitle(tasks, 'Tarefa nativa')[0].source, 'local');
    assert.equal(tasks.filter((x) => x.source === 'google').length, 4);

    // idempotência: várias sincronizações, manual e por semanas
    const before = tasks.map((x) => x.id).sort();
    for (let i = 0; i < 3; i++) {
        const r = (await A.post(`${G}/sync`)).body;
        assert.equal(r.created, 0); assert.equal(r.status, 'ok');
    }
    await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-19', '2026-10-26'], force: true });
    tasks = await tasksOf(A);
    assert.deepEqual(tasks.map((x) => x.id).sort(), before);
    for (const x of tasks.filter((x) => x.source === 'google')) assert.equal(countMeta(x.description), 1);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM google_event_links'); assert.equal(n, 4);
    // a sincronização incremental usa updatedMin (não reimporta tudo)
    assert.ok(fake.eventCalls().at(-1).params.updatedMin || fake.eventCalls().some((c) => c.params.updatedMin));

    // sincronização "obsoleta": a abertura do site só sincroniza se passou tempo
    let st = (await A.get(`${G}/status`)).body;
    assert.equal(st.stale, false); assert.equal(st.lastSyncStatus, 'ok'); assert.ok(st.lastSyncAt);
    ctx.advance(20 * 60e3);
    assert.equal((await A.get(`${G}/status`)).body.stale, true);
    await A.post(`${G}/sync`);
    assert.equal((await A.get(`${G}/status`)).body.stale, false);
});

test('paginação: todos os eventos são importados mesmo em várias páginas', async (t) => {
    const { A, fake } = await scenario(t, { seed: false });
    for (let i = 1; i <= 7; i++) fake.add(STUDY.id, timed(`p${i}`, `Evento ${i}`, `2026-10-2${i}T10:00:00-03:00`, `2026-10-2${i}T11:00:00-03:00`));
    fake.pageSize = 3;
    await A.put(`${G}/calendars`, { selected: [STUDY.id] });
    assert.equal((await tasksOf(A)).length, 7);
    assert.ok(fake.eventCalls().length >= 3, 'seguiu os nextPageToken');
});

test('9-11. mudanças e exclusões no Google refletem nas importadas; nativas e estado local são preservados', async (t) => {
    const { A, fake, ctx, events } = await scenario(t, { select: [STUDY.id, WORK.id] });
    const native = (await A.post('/api/tasks', { title: 'Prova de Cálculo', dueDate: '2026-10-20' })).body; // mesmo título e data
    const prova = byTitle(await tasksOf(A), 'Prova de Cálculo').find((x) => x.source === 'google');
    await A.patch(`/api/tasks/${prova.id}`, { completed: true });

    ctx.advance(HOUR);
    fake.change(events.prova, { summary: 'Prova de Cálculo II', location: 'Auditório', description: 'Cap. 5',
        start: { dateTime: '2026-10-23T08:00:00-03:00' }, end: { dateTime: '2026-10-23T10:30:00-03:00' } });
    let r = (await A.post(`${G}/sync`)).body;
    assert.equal(r.updated, 1); assert.equal(r.created, 0);
    let t2 = (await tasksOf(A)).find((x) => x.id === prova.id);
    assert.equal(t2.title, 'Prova de Cálculo II');
    assert.equal(t2.due_date.slice(0, 10), '2026-10-23');
    assert.equal(t2.description, 'Cap. 5\n\n---\nImportado do Google Calendar\nHorário: 08:00–10:30\nFuso horário: America/Sao_Paulo\nLocal: Auditório\nCalendário: Estudos');
    assert.equal(countMeta(t2.description), 1, 'bloco substituído, não anexado');
    assert.equal(Boolean(t2.completed), true, 'conclusão local é preservada');

    // exclusão e cancelamento: removem só a importada
    ctx.advance(HOUR);
    fake.change(events.prova, { status: 'cancelled' });
    fake.change(events.feriado, { status: 'cancelled' });
    r = (await A.post(`${G}/sync`)).body;
    assert.equal(r.deleted, 2);
    const left = await tasksOf(A);
    assert.ok(!left.some((x) => x.id === prova.id || x.title === 'Feriado'));
    assert.ok(left.some((x) => x.id === native.id), 'tarefa nativa homônima permanece');
    assert.deepEqual(left.map((x) => x.title).sort(), ['(Sem título)', 'Prova de Cálculo', 'Reunião de equipe']);
    assert.equal(left.filter((x) => x.source === 'local').length, 1);
});

test('12-13. recorrência: só materializa a semana visitada e revisitar não duplica', async (t) => {
    const { A, fake, ctx } = await scenario(t, { select: [STUDY.id] });
    const { inst } = seedSeries(fake);
    await A.post(`${G}/sync`); // a série (mestre) é vista, mas NÃO é expandida
    assert.equal((await tasksOf(A)).filter((x) => x.title === 'Aula semanal').length, 0);
    const [[cal]] = await pool.query("SELECT has_recurring FROM google_calendars WHERE calendar_id = 'cal-study'");
    assert.equal(cal.has_recurring, 1);

    const n0 = fake.eventCalls().length;
    let r = (await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-26'] })).body;
    assert.equal(r.created, 1); assert.equal(r.queried, 1);
    const call = fake.eventCalls().at(-1);
    assert.equal(call.params.singleEvents, 'true');
    assert.ok(call.params.timeMin <= '2026-10-26T00:00:00Z' && call.params.timeMax >= '2026-11-02T00:00:00Z');
    let aulas = (await tasksOf(A)).filter((x) => x.title === 'Aula semanal');
    assert.deepEqual(aulas.map((x) => x.due_date.slice(0, 10)), ['2026-10-27']);
    assert.equal(aulas[0].source, 'google');
    assert.match(aulas[0].description, /Horário: 10:00–11:00/);

    // revisitar a mesma semana: sem nova consulta (cache) e sem recriar
    r = (await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-26'] })).body;
    assert.equal(r.queried, 0); assert.equal(r.created, 0);
    assert.equal(fake.eventCalls().length, n0 + 1);
    // dia no meio da semana é normalizado para a segunda-feira (cache pela mesma semana)
    r = (await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-29'] })).body;
    assert.equal(r.queried, 0);
    // forçado (botão Sync): consulta, mas não duplica nem atualiza sem mudança
    r = (await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-26'], force: true })).body;
    assert.equal(r.queried, 1); assert.equal(r.created, 0); assert.equal(r.updated, 0);
    // após o tempo de revalidação, revisita e confere alterações pendentes
    ctx.advance(11 * 60e3);
    r = (await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-26'] })).body;
    assert.equal(r.queried, 1); assert.equal(r.created, 0);

    // outra semana (virada de mês): só a ocorrência dela; as demais futuras seguem sem tarefa
    r = (await A.post(`${G}/sync/weeks`, { weeks: ['2026-11-02'] })).body;
    assert.equal(r.created, 1);
    aulas = (await tasksOf(A)).filter((x) => x.title === 'Aula semanal');
    assert.deepEqual(aulas.map((x) => x.due_date.slice(0, 10)).sort(), ['2026-10-27', '2026-11-03']);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM google_event_links WHERE series_id = 'm1'");
    assert.equal(n, 2, 'ocorrências 20/10 e 10/11 não foram criadas antecipadamente');
    for (const a of aulas) assert.ok(a.id);
    const [links] = await pool.query("SELECT event_id, series_id, occurrence_start, task_id FROM google_event_links WHERE series_id = 'm1' ORDER BY event_id");
    assert.deepEqual(links.map((l) => l.event_id), ['m1_20261027T130000Z', 'm1_20261103T130000Z']);
    assert.ok(links.every((l) => l.occurrence_start && l.task_id));

    // intervalo configurado vale mais que a navegação: semana fora do intervalo não importa nada
    r = (await A.post(`${G}/sync/weeks`, { weeks: ['2027-02-01'] })).body;
    assert.equal(r.queried, 0); assert.equal(r.created, 0);
    assert.ok(!(await tasksOf(A)).some((x) => x.due_date?.startsWith('2027-02')));
    // entrada inválida
    assert.equal((await A.post(`${G}/sync/weeks`, { weeks: ['lixo'] })).status, 400);
    assert.equal((await A.post(`${G}/sync/weeks`, {})).status, 400);
    void inst;
});

test('13. a semana que cruza a virada do ano usa a segunda-feira correta', async (t) => {
    const { A, fake } = await scenario(t, { select: [STUDY.id], startOpts: { now: '2026-12-20T12:00:00Z' } });
    const { master } = seedSeries(fake);
    fake.add(STUDY.id, { id: 'm1_20270101', _kind: 'instance', recurringEventId: 'm1', summary: 'Aula semanal', start: { dateTime: '2027-01-01T10:00:00-03:00' }, end: { dateTime: '2027-01-01T11:00:00-03:00' } });
    await A.post(`${G}/sync`);
    const r = (await A.post(`${G}/sync/weeks`, { weeks: ['2027-01-01'] })).body; // sexta -> semana de 28/12
    assert.equal(r.created, 1);
    assert.ok((await tasksOf(A)).some((x) => x.due_date?.startsWith('2027-01-01')));
    void master;
});

test('14. ocorrências canceladas e exceções de série', async (t) => {
    const { A, fake, ctx } = await scenario(t, { select: [STUDY.id], seed: false });
    const { inst } = seedSeries(fake);
    await A.post(`${G}/sync`);
    await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-26', '2026-11-02'] });
    assert.equal((await tasksOf(A)).filter((x) => x.title === 'Aula semanal').length, 2);

    // ocorrência cancelada
    ctx.advance(HOUR);
    fake.change(inst['2026-10-27'], { status: 'cancelled' });
    let r = (await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-26'], force: true })).body;
    assert.equal(r.deleted, 1);
    let aulas = (await tasksOf(A)).filter((x) => x.title === 'Aula semanal');
    assert.deepEqual(aulas.map((x) => x.due_date.slice(0, 10)), ['2026-11-03']);
    // cancelada não é recriada ao revisitar
    r = (await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-26'], force: true })).body;
    assert.equal(r.created, 0);

    // exceção: horário/título alterados e movida para outra semana
    ctx.advance(HOUR);
    fake.change(inst['2026-11-03'], { _kind: 'exception', summary: 'Aula (reposição)', start: { dateTime: '2026-11-10T16:00:00-03:00', timeZone: 'America/Sao_Paulo' }, end: { dateTime: '2026-11-10T17:00:00-03:00', timeZone: 'America/Sao_Paulo' } });
    r = (await A.post(`${G}/sync`)).body; // sincronização principal atualiza ocorrências já materializadas
    assert.equal(r.updated, 1); assert.equal(r.created, 0);
    let moved = (await tasksOf(A)).find((x) => x.title === 'Aula (reposição)');
    assert.equal(moved.due_date.slice(0, 10), '2026-11-10');
    assert.match(moved.description, /Horário: 16:00–17:00/);
    assert.equal((await tasksOf(A)).filter((x) => x.title === 'Aula semanal').length, 0);
    // visitar a semana de destino não duplica a ocorrência movida
    r = (await A.post(`${G}/sync/weeks`, { weeks: ['2026-11-09'], force: true })).body;
    assert.equal(r.created, 1, 'só a ocorrência regular de 10/11 (a exceção já estava vinculada)');
    const all = (await tasksOf(A)).filter((x) => /^Aula/.test(x.title));
    assert.equal(all.length, 2);

    // série inteira cancelada: remove todas as ocorrências materializadas
    ctx.advance(HOUR);
    fake.change(fake.events[STUDY.id].find((e) => e.id === 'm1'), { status: 'cancelled' });
    r = (await A.post(`${G}/sync`)).body;
    assert.equal(r.deleted, 2);
    assert.equal((await tasksOf(A)).filter((x) => /^Aula/.test(x.title)).length, 0);
});

test('15-16. editar, concluir e excluir tarefa importada no site nunca escreve no Google', async (t) => {
    const { A, fake, ctx, events } = await scenario(t, { select: [STUDY.id, WORK.id] });
    const calls0 = fake.calls.length;
    const prova = byTitle(await tasksOf(A), 'Prova de Cálculo')[0];
    const reun = byTitle(await tasksOf(A), 'Reunião de equipe')[0];

    // concluir / reabrir / editar título e data: tudo local; concluir NÃO apaga a data
    let r = await A.patch(`/api/tasks/${prova.id}`, { completed: true });
    assert.equal(Boolean(r.body.completed), true);
    assert.equal(r.body.due_date.slice(0, 10), '2026-10-20', 'concluir preserva a data');
    await A.patch(`/api/tasks/${prova.id}`, { completed: false });
    r = await A.patch(`/api/tasks/${prova.id}`, { title: 'Meu título local', dueDate: '2026-10-25', description: 'minha nota' });
    assert.equal(r.body.title, 'Meu título local');
    assert.equal(fake.calls.length, calls0, 'nenhuma chamada ao Google por ações locais');

    // edições locais persistem enquanto a origem não mudar
    await A.post(`${G}/sync`);
    await A.post(`${G}/sync/weeks`, { weeks: ['2026-10-19'], force: true });
    let cur = (await tasksOf(A)).find((x) => x.id === prova.id);
    assert.equal(cur.title, 'Meu título local');
    assert.equal(cur.due_date.slice(0, 10), '2026-10-25');
    // quando a origem muda, a fonte Google atualiza (título/data/descrição), sem tocar na conclusão
    await A.patch(`/api/tasks/${prova.id}`, { completed: true });
    ctx.advance(HOUR);
    fake.change(events.prova, { summary: 'Prova remarcada' });
    await A.post(`${G}/sync`);
    cur = (await tasksOf(A)).find((x) => x.id === prova.id);
    assert.equal(cur.title, 'Prova remarcada');
    assert.equal(Boolean(cur.completed), true);

    // excluir no site: o evento continua no Google e a tarefa não ressurge
    assert.equal((await A.del(`/api/tasks/${reun.id}`)).status, 204);
    assert.ok(fake.events[WORK.id].some((e) => e.id === 'ev-reuniao' && e.status !== 'cancelled'));
    ctx.advance(HOUR);
    fake.change(fake.events[WORK.id][0], { location: 'Sala 9' });
    await A.post(`${G}/sync`);
    assert.ok(!(await tasksOf(A)).some((x) => x.id === reun.id || x.title === 'Reunião de equipe'));
    assert.deepEqual(fake.writes(), []);
    assert.ok(fake.calls.every((c) => c.method === 'GET' || c.host === 'oauth2.googleapis.com'));
});

test('19. token expirado é renovado; revogação exige reconexão sem perder dados', async (t) => {
    const { A, fake, ctx, events } = await scenario(t, { select: [STUDY.id] });
    fake.expiresIn = 120;
    // access token do usuário A expira; renovação automática
    await A.post(`${G}/disconnect`, { tasks: 'keep' });
    await (await import('./helpers.js')).connectGoogle(A, ctx, 'sub-a');
    await A.put(`${G}/calendars`, { selected: [STUDY.id] });
    const rc = fake.refreshCount;
    ctx.advance(10 * 60e3);
    let r = await A.post(`${G}/sync`);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'ok');
    assert.equal(fake.refreshCount, rc + 1);
    // access token invalidado no servidor do Google (401): renova uma vez e repete
    for (const k of fake.access.keys()) fake.access.delete(k);
    r = await A.post(`${G}/sync`);
    assert.equal(r.body.status, 'ok');

    // revogação do acesso
    const before = await tasksOf(A);
    fake.revokeAccount('sub-a');
    r = await A.post(`${G}/sync`);
    assert.equal(r.status, 401); assert.equal(r.body.code, 'TOKEN_REVOKED');
    let st = (await A.get(`${G}/status`)).body;
    assert.equal(st.state, 'needs_reauth');
    assert.equal(st.syncing, false, 'bloqueio liberado após a falha');
    assert.equal((await A.post(`${G}/sync`)).status, 409);
    assert.equal((await tasksOf(A)).length, before.length, 'nenhuma tarefa perdida');

    // reconectar: volta a funcionar sem duplicar
    ctx.advance(HOUR);
    fake.change(events.prova, { summary: 'Prova pós-reconexão' });
    const { connectGoogle } = await import('./helpers.js');
    const c = await connectGoogle(A, ctx, 'sub-a');
    assert.match(c.callback.location, /google=connected/);
    assert.equal((await A.get(`${G}/status`)).body.state, 'active');
    r = await A.post(`${G}/sync`);
    assert.equal(r.body.status, 'ok');
    const after = await tasksOf(A);
    assert.equal(after.length, before.length);
    assert.ok(after.some((x) => x.title === 'Prova pós-reconexão'));
});

test('19. falhas de rede e limites: retentativas limitadas, sem perda de dados, falha parcial consistente', async (t) => {
    const { A, fake, ctx, events } = await scenario(t, { select: [STUDY.id, WORK.id] });
    const before = await tasksOf(A);
    const last = (await A.get(`${G}/status`)).body.lastSyncAt;
    ctx.advance(HOUR);

    // rede fora do ar: não interpreta como exclusão, não avança "última sincronização"
    fake.netDown = true;
    const n0 = fake.calls.length;
    let r = (await A.post(`${G}/sync`)).body;
    assert.equal(r.status, 'error'); assert.match(r.message, /rede/i);
    assert.ok(fake.calls.length - n0 <= 2 * 4, 'retentativas limitadas (4 por calendário)');
    fake.netDown = false;
    assert.equal((await tasksOf(A)).length, before.length);
    assert.equal((await A.get(`${G}/status`)).body.lastSyncAt, last);
    assert.equal((await A.get(`${G}/status`)).body.lastSyncStatus, 'error');

    // 503 temporário: recupera na retentativa (com espera exponencial)
    fake.failEvents = [{ status: 503 }, { status: 503 }];
    r = (await A.post(`${G}/sync`)).body;
    assert.equal(r.status, 'ok');
    assert.ok(ctx.sleeps.length >= 2 && ctx.sleeps[1] > ctx.sleeps[0]);

    // 429 persistente: desiste, mensagem clara, nada apagado
    fake.failEvents = Array.from({ length: 50 }, () => ({ status: 429, reason: 'rateLimitExceeded' }));
    const n1 = fake.calls.length;
    r = (await A.post(`${G}/sync`)).body;
    assert.equal(r.status, 'error'); assert.match(r.message, /Limite de requisições/);
    assert.ok(fake.calls.length - n1 <= 8);
    fake.failEvents = [];
    assert.equal((await tasksOf(A)).length, before.length);

    // um calendário inacessível: sincronização parcial; o outro é atualizado
    ctx.advance(HOUR);
    fake.change(events.reuniao, { summary: 'Reunião v2' });
    fake.change(events.prova, { summary: 'Prova v2' });
    fake.failEvents = [{ status: 404, reason: 'notFound' }]; // atinge o 1º calendário (Estudos)
    r = (await A.post(`${G}/sync`)).body;
    assert.equal(r.status, 'partial');
    assert.equal(r.calendarsOk, 1); assert.equal(r.calendarsFailed, 1);
    const titles = (await tasksOf(A)).map((x) => x.title);
    assert.ok(titles.includes('Reunião v2') && titles.includes('Prova de Cálculo'));
    const cals = (await A.get(`${G}/calendars`)).body.calendars;
    assert.match(cals.find((c) => c.id === STUDY.id).lastError, /inacessível/);
    // repetir a operação conclui o que faltou, sem duplicar
    r = (await A.post(`${G}/sync`)).body;
    assert.equal(r.status, 'ok');
    const final = await tasksOf(A);
    assert.equal(final.length, before.length);
    assert.ok(final.some((x) => x.title === 'Prova v2'));
});

test('8/15 (seg.). sincronizações simultâneas não duplicam (bloqueio por usuário)', async (t) => {
    const { A, fake } = await scenario(t, { select: [STUDY.id, WORK.id] });
    fake.delayMs = 40;
    await pool.query('UPDATE google_calendars SET updated_cursor = NULL');
    const rs = await Promise.all([A.post(`${G}/sync`), A.post(`${G}/sync`), A.post(`${G}/sync`)]);
    const kinds = rs.map((r) => r.body.status ?? r.body.reason);
    assert.ok(kinds.includes('skipped'), JSON.stringify(rs.map((r) => r.body)));
    assert.equal((await tasksOf(A)).filter((x) => x.source === 'google').length, 4);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM google_event_links'); assert.equal(n, 4);
    assert.equal((await A.get(`${G}/status`)).body.syncing, false);
});
