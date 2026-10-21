// Servidor de DEMONSTRAÇÃO/E2E: usa um Google FALSO (sem rede, sem credenciais) e o banco *_test.
// Não use em produção. Uso:  npm run demo   (porta 3333; pareie com `npm run dev` do frontend)
import './env.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { createGoogleClient } from '../src/google/client.js';
import { createSyncService } from '../src/google/sync.js';
import { createFakeGoogle } from './fake-google.js';

const fake = createFakeGoogle();
const google = createGoogleClient({ fetchImpl: fake.fetch, sleep: async () => {} });
const service = createSyncService({ google });

// banco limpo (esquema legado + migrações)
const c = await pool.getConnection();
await c.query('SET FOREIGN_KEY_CHECKS = 0');
for (const t of ['google_week_fetches', 'google_oauth_states', 'google_event_links', 'google_calendars', 'google_connections', 'sessions', 'tasks', 'users', 'schema_migrations']) await c.query(`DROP TABLE IF EXISTS ${t}`);
await c.query('SET FOREIGN_KEY_CHECKS = 1');
await c.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/CREATE DATABASE[\s\S]*?;\s*USE todolist;/i, ''));
c.release();
await migrate(pool);

// eventos relativos a hoje
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const SP = 'America/Sao_Paulo';
fake.addAccount('demo-sub', 'demo@gmail.com', [
    { id: 'estudos', summary: 'Estudos', timeZone: SP, backgroundColor: '#7986cb' },
    { id: 'trabalho', summary: 'Trabalho', timeZone: SP, backgroundColor: '#33b679' },
    { id: 'pessoal', summary: 'Pessoal', timeZone: SP, backgroundColor: '#e67c73' },
]);
const timed = (id, summary, d, a, b, extra = {}) => ({ id, summary, start: { dateTime: `${d}T${a}:00-03:00` }, end: { dateTime: `${d}T${b}:00-03:00` }, ...extra });
fake.add('estudos', timed('e1', 'Prova de Cálculo', day(1), '14:00', '16:00', { description: 'Cap. 3 e 4', location: 'Biblioteca' }));
fake.add('estudos', { id: 'e2', summary: 'Feriado', start: { date: day(2) }, end: { date: day(3) } });
fake.add('trabalho', timed('t1', 'Reunião de equipe', day(1), '10:00', '11:00', { location: 'Sala 2' }));
fake.add('pessoal', timed('p1', 'Dentista', day(3), '09:00', '10:00'));
fake.add('estudos', { id: 'serie', _kind: 'master', summary: 'Aula semanal', recurrence: ['RRULE:FREQ=WEEKLY'], start: { dateTime: `${day(-21)}T10:00:00-03:00`, timeZone: SP }, end: { dateTime: `${day(-21)}T11:00:00-03:00`, timeZone: SP } });
for (let i = -3; i <= 12; i++) fake.add('estudos', { id: `serie_${i + 5}`, _kind: 'instance', recurringEventId: 'serie', summary: 'Aula semanal', start: { dateTime: `${day(i * 7)}T10:00:00-03:00`, timeZone: SP }, end: { dateTime: `${day(i * 7)}T11:00:00-03:00`, timeZone: SP } });

const app = createApp({ google, service, logger: false });
// Ganchos só desta demonstração: emitem o "código" que o Google devolveria e expõem as chamadas feitas.
app.post('/__demo/code', (_req, res) => res.send({ code: fake.issueCode('demo-sub') }));
app.get('/__demo/calls', (_req, res) => res.send({ calls: fake.calls.map((x) => `${x.method} ${x.host}${x.path}`), writes: fake.writes().length }));
app.post('/__demo/change', (_req, res) => { fake.change(fake.events.estudos[0], { summary: 'Prova de Cálculo II (remarcada)' }); res.send({ ok: true }); });
app.listen(3333, 'localhost', () => console.log('Demo em http://localhost:3333 (Google falso)'));
