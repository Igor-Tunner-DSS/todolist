// Serviço de sincronização Google Calendar -> tarefas (UNIDIRECIONAL).
// Nada neste arquivo escreve no Google Calendar: só há leituras (via client.listEvents /
// client.listCalendars) e escritas no banco local.

import { pool } from '../db.js';
import { config } from '../config.js';
import { encrypt, decrypt } from '../crypto.js';
import { GoogleError, REQUIRED_CALENDAR_SCOPES, readIdToken } from './client.js';
import { addDays, buildTask, eventDate, isISODate, weekStartOf } from './mapping.js';

const LOCK_MINUTES = 5;
const STALE_MS = 15 * 60 * 1000;
const WEEK_RECHECK_MS = 10 * 60 * 1000;
const MAX_RANGE_DAYS = 731;

const sqlUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const fromSql = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}Z`) : null);
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const todayUtc = (now) => now().toISOString().slice(0, 10);

export class ServiceError extends Error {
    constructor(status, code, message, extra = {}) { super(message); Object.assign(this, { status, code, extra }); }
}

export function createSyncService({ db = pool, google, now = () => new Date() }) {
    const gcfg = () => config().google;

    // ---------- conexão e tokens ----------
    async function getConnection(userId) {
        const [[c]] = await db.query('SELECT * FROM google_connections WHERE user_id = ?', [userId]);
        return c || null;
    }
    async function requireConnection(userId) {
        const c = await getConnection(userId);
        if (!c) throw new ServiceError(404, 'NOT_CONNECTED', 'Google Calendar não está conectado.');
        return c;
    }
    async function markNeedsReauth(conn, msg = 'Acesso ao Google revogado ou expirado. Reconecte a conta.') {
        await db.query("UPDATE google_connections SET status = 'needs_reauth', last_sync_status = 'error', last_error = ? WHERE id = ?", [msg, conn.id]);
    }

    async function refreshAccessToken(conn) {
        if (!conn.refresh_token_enc) { await markNeedsReauth(conn); throw new ServiceError(401, 'TOKEN_REVOKED', 'Reconecte sua conta Google.'); }
        let tok;
        try {
            tok = await google.refresh({
                clientId: gcfg().clientId, clientSecret: gcfg().clientSecret,
                refreshToken: decrypt(conn.refresh_token_enc, gcfg().encryptionKey),
            });
        } catch (e) {
            if (e instanceof GoogleError && (e.revoked || e.auth)) { await markNeedsReauth(conn); throw new ServiceError(401, 'TOKEN_REVOKED', 'Acesso ao Google revogado. Reconecte sua conta.'); }
            throw e;
        }
        const exp = new Date(now().getTime() + (Number(tok.expires_in) || 3600) * 1000);
        await db.query('UPDATE google_connections SET access_token_enc = ?, access_expires_at = ? WHERE id = ?',
            [encrypt(tok.access_token, gcfg().encryptionKey), sqlUtc(exp), conn.id]);
        return tok.access_token;
    }
    async function accessToken(conn, { force = false } = {}) {
        const exp = fromSql(conn.access_expires_at);
        if (!force && conn.access_token_enc && exp && exp.getTime() - now().getTime() > 60000) {
            return decrypt(conn.access_token_enc, gcfg().encryptionKey);
        }
        return refreshAccessToken(conn);
    }
    // Executa `fn(token)`; se o Google responder 401, renova o token uma vez e repete.
    async function withToken(conn, fn) {
        let token = await accessToken(conn);
        try { return await fn(token); } catch (e) {
            if (e instanceof GoogleError && e.auth && !e.revoked) { token = await accessToken(conn, { force: true }); return fn(token); }
            if (e instanceof GoogleError && e.revoked) { await markNeedsReauth(conn); throw new ServiceError(401, 'TOKEN_REVOKED', 'Acesso ao Google revogado. Reconecte sua conta.'); }
            throw e;
        }
    }

    // ---------- bloqueio contra sincronizações concorrentes (por usuário) ----------
    async function acquire(conn) {
        const [r] = await db.query(
            'UPDATE google_connections SET syncing_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE) WHERE id = ? AND (syncing_until IS NULL OR syncing_until < UTC_TIMESTAMP())',
            [LOCK_MINUTES, conn.id]);
        return r.affectedRows === 1;
    }
    const release = (conn) => db.query('UPDATE google_connections SET syncing_until = NULL WHERE id = ?', [conn.id]);

    // ---------- upsert de um evento ----------
    async function removeByLinks(userId, where, params) {
        const c = await db.getConnection();
        try {
            await c.beginTransaction();
            const [links] = await c.query(`SELECT id, task_id FROM google_event_links WHERE user_id = ? AND status = 'active' AND ${where} FOR UPDATE`, [userId, ...params]);
            const ids = links.map((l) => l.task_id).filter(Boolean);
            // Só vínculos ATIVOS: cópias locais mantidas ('detached') nunca são apagadas pelo Google.
            // Só tarefas importadas e do próprio usuário: tarefas nativas nunca são apagadas.
            if (ids.length) await c.query("DELETE FROM tasks WHERE user_id = ? AND source = 'google' AND id IN (?)", [userId, ids]);
            if (links.length) await c.query('DELETE FROM google_event_links WHERE id IN (?)', [links.map((l) => l.id)]);
            await c.commit();
            return ids.length;
        } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
    }

    async function upsert(ctx, cal, ev, built, allowCreate) {
        const { conn, stats } = ctx;
        const etag = ev.etag || null;
        const c = await db.getConnection();
        try {
            await c.beginTransaction();
            const [[link]] = await c.query(
                'SELECT * FROM google_event_links WHERE user_id = ? AND calendar_id = ? AND event_id = ? FOR UPDATE',
                [conn.user_id, cal.calendar_id, ev.id]);
            const common = [ev.recurringEventId || null, ev.originalStartTime?.dateTime || ev.originalStartTime?.date || ev.start?.dateTime || ev.start?.date || null, etag, ev.updated || null];

            if (!link) {
                if (!allowCreate) { await c.rollback(); return; }
                const [t] = await c.query("INSERT INTO tasks (user_id, title, description, completed, due_date, source) VALUES (?, ?, ?, 0, ?, 'google')",
                    [conn.user_id, built.title, built.description, built.due_date]);
                await c.query(
                    "INSERT INTO google_event_links (user_id, connection_id, calendar_id, event_id, series_id, occurrence_start, etag, google_updated, task_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')",
                    [conn.user_id, conn.id, cal.calendar_id, ev.id, ...common, t.insertId]);
                stats.created++;
            } else if (link.status === 'dismissed' || !link.task_id) {
                stats.skipped++;
            } else if (link.status === 'detached' && !allowCreate) {
                stats.skipped++;
            } else {
                const unchanged = link.etag === etag && link.google_updated === (ev.updated || null) && etag !== null;
                if (!unchanged) {
                    // Atualiza só título/descrição/data: o estado "concluída" é local e nunca é tocado.
                    await c.query("UPDATE tasks SET title = ?, description = ?, due_date = ? WHERE id = ? AND user_id = ? AND source = 'google'",
                        [built.title, built.description, built.due_date, link.task_id, conn.user_id]);
                    stats.updated++;
                } else stats.skipped++;
                await c.query("UPDATE google_event_links SET series_id = ?, occurrence_start = ?, etag = ?, google_updated = ?, status = 'active' WHERE id = ?",
                    [...common, link.id]);
            }
            await c.commit();
        } catch (e) {
            await c.rollback();
            if (e.code === 'ER_DUP_ENTRY') { stats.skipped++; return; } // duplicação evitada pela restrição de unicidade
            throw e;
        } finally { c.release(); }
    }

    // scope: { kind: 'main' } ou { kind: 'week', from, to }
    async function applyEvent(ctx, cal, ev, scope) {
        if (!ev || typeof ev.id !== 'string' || !ev.id) return;
        const { conn, stats } = ctx;

        if (ev.status === 'cancelled') {
            // Cancelamento explícito vindo do Google: remove a ocorrência (ou a série inteira, se for o mestre).
            stats.deleted += await removeByLinks(conn.user_id, 'calendar_id = ? AND (event_id = ? OR series_id = ?)', [cal.calendar_id, ev.id, ev.id]);
            return;
        }
        const isInstance = Boolean(ev.recurringEventId);
        if (Array.isArray(ev.recurrence) && !isInstance) { ctx.seenMaster.add(cal.id); return; } // série: não expandir

        const built = buildTask(ev, { calendarName: cal.summary, calendarTz: cal.time_zone });
        if (!built) return;

        if (scope.kind === 'main') {
            const inRange = built.due_date >= ctx.range.start && built.due_date <= ctx.range.end;
            // exceções de série só são atualizadas aqui se já materializadas; criação é sob demanda por semana
            await upsert(ctx, cal, ev, built, isInstance ? false : inRange);
        } else {
            if (!isInstance) return; // eventos simples já são cobertos pela sincronização principal
            const inWeek = built.due_date >= scope.from && built.due_date <= scope.to;
            await upsert(ctx, cal, ev, built, inWeek);
        }
    }

    const apiWindow = (from, to) => ({ timeMin: `${addDays(from, -1)}T00:00:00Z`, timeMax: `${addDays(to, 2)}T00:00:00Z` });

    function describeError(e) {
        if (e instanceof GoogleError) {
            if (e.status === 404 || e.status === 403 && !e.temporary) return 'Calendário inacessível.';
            if (e.status === 429 || e.temporary && e.status) return 'Limite de requisições do Google atingido. Tente novamente em instantes.';
            if (e.temporary) return 'Falha de rede ao acessar o Google. Tente novamente.';
            return 'Erro ao acessar o Google Calendar.';
        }
        return 'Erro inesperado durante a sincronização.';
    }

    // ---------- sincronização principal (intervalo configurado, calendários selecionados) ----------
    async function syncUser(userId) {
        const conn = await requireConnection(userId);
        if (conn.status !== 'active') throw new ServiceError(409, 'NEEDS_REAUTH', 'Reconecte sua conta Google para sincronizar.');
        if (!(await acquire(conn))) return { status: 'skipped', reason: 'in_progress' };
        const stats = { created: 0, updated: 0, deleted: 0, skipped: 0 };
        let failed = 0, ok = 0, lastError = null;
        try {
            const [cals] = await db.query('SELECT * FROM google_calendars WHERE connection_id = ? AND selected = 1', [conn.id]);
            const ctx = { conn, stats, range: { start: String(conn.range_start).slice(0, 10), end: String(conn.range_end).slice(0, 10) }, seenMaster: new Set() };
            for (const cal of cals) {
                const started = now();
                try {
                    const params = { singleEvents: false, showDeleted: true, ...apiWindow(ctx.range.start, ctx.range.end) };
                    const cursor = fromSql(cal.updated_cursor);
                    if (cursor) params.updatedMin = cursor.toISOString();
                    const { items } = await withToken(conn, (t) => google.listEvents(t, cal.calendar_id, params));
                    for (const ev of items) await applyEvent(ctx, cal, ev, { kind: 'main' });
                    const sawMaster = ctx.seenMaster.has(cal.id);
                    await db.query(
                        'UPDATE google_calendars SET updated_cursor = ?, last_sync_at = ?, last_error = NULL, has_recurring = ? WHERE id = ?',
                        [sqlUtc(new Date(started.getTime() - 2 * 60000)), sqlUtc(now()), cursor ? (cal.has_recurring || sawMaster ? 1 : 0) : (sawMaster ? 1 : 0), cal.id]);
                    ok++;
                } catch (e) {
                    if (e instanceof ServiceError) throw e; // revogação: aborta tudo
                    failed++; lastError = describeError(e);
                    await db.query('UPDATE google_calendars SET last_error = ? WHERE id = ?', [lastError, cal.id]);
                }
            }
            const status = failed === 0 ? 'ok' : ok === 0 ? 'error' : 'partial';
            await db.query('UPDATE google_connections SET last_sync_status = ?, last_error = ?, last_sync_at = IF(?, ?, last_sync_at) WHERE id = ?',
                [status, lastError, failed === 0 ? 1 : 0, sqlUtc(now()), conn.id]);
            return { status, ...stats, calendarsOk: ok, calendarsFailed: failed, message: lastError };
        } finally { await release(conn); }
    }

    // ---------- recorrência sob demanda por semana ----------
    async function syncWeeks(userId, weeks, { force = false } = {}) {
        const conn = await requireConnection(userId);
        if (conn.status !== 'active') throw new ServiceError(409, 'NEEDS_REAUTH', 'Reconecte sua conta Google para sincronizar.');
        const list = [...new Set((Array.isArray(weeks) ? weeks : []).filter(isISODate).map(weekStartOf))].slice(0, 6);
        if (!list.length) throw new ServiceError(400, 'BAD_WEEKS', 'Informe ao menos uma semana válida (YYYY-MM-DD).');
        if (!(await acquire(conn))) return { status: 'skipped', reason: 'in_progress' };
        const stats = { created: 0, updated: 0, deleted: 0, skipped: 0 };
        let failed = 0, queried = 0;
        try {
            const range = { start: String(conn.range_start).slice(0, 10), end: String(conn.range_end).slice(0, 10) };
            const ctx = { conn, stats, range, seenMaster: new Set() };
            const [cals] = await db.query('SELECT * FROM google_calendars WHERE connection_id = ? AND selected = 1 AND has_recurring = 1', [conn.id]);
            for (const ws of list) {
                // semana ∩ intervalo configurado
                const from = ws > range.start ? ws : range.start;
                const toWeek = addDays(ws, 6);
                const to = toWeek < range.end ? toWeek : range.end;
                if (from > to) continue;
                for (const cal of cals) {
                    if (!force) {
                        const [[f]] = await db.query('SELECT fetched_at FROM google_week_fetches WHERE connection_id = ? AND calendar_id = ? AND week_start = ?', [conn.id, cal.calendar_id, ws]);
                        if (f && now().getTime() - fromSql(f.fetched_at).getTime() < WEEK_RECHECK_MS) continue;
                    }
                    try {
                        const params = { singleEvents: true, showDeleted: true, ...apiWindow(from, to) };
                        const { items } = await withToken(conn, (t) => google.listEvents(t, cal.calendar_id, params));
                        queried++;
                        for (const ev of items) await applyEvent(ctx, cal, ev, { kind: 'week', from, to });
                        await db.query('REPLACE INTO google_week_fetches (connection_id, calendar_id, week_start, fetched_at) VALUES (?, ?, ?, ?)', [conn.id, cal.calendar_id, ws, sqlUtc(now())]);
                    } catch (e) {
                        if (e instanceof ServiceError) throw e;
                        failed++;
                        await db.query('UPDATE google_calendars SET last_error = ? WHERE id = ?', [describeError(e), cal.id]);
                    }
                }
            }
            return { status: failed ? 'partial' : 'ok', ...stats, queried, failed };
        } finally { await release(conn); }
    }

    // ---------- OAuth ----------
    async function completeOAuth({ userId, code, verifier }) {
        const tok = await google.exchangeCode({ clientId: gcfg().clientId, clientSecret: gcfg().clientSecret, redirectUri: gcfg().redirectUri, code, verifier });
        const granted = String(tok.scope || '').split(' ');
        if (!REQUIRED_CALENDAR_SCOPES.every((s) => granted.includes(s))) throw new ServiceError(400, 'INSUFFICIENT_SCOPE', 'Permissões insuficientes: autorize a leitura de calendários e eventos.');
        const who = readIdToken(tok.id_token, gcfg().clientId, now().getTime());
        const existing = await getConnection(userId);
        const exp = new Date(now().getTime() + (Number(tok.expires_in) || 3600) * 1000);
        const key = gcfg().encryptionKey;
        const refreshEnc = tok.refresh_token ? encrypt(tok.refresh_token, key) : existing?.refresh_token_enc || null;
        if (!refreshEnc) throw new ServiceError(400, 'NO_REFRESH_TOKEN', 'O Google não devolveu um token de renovação. Revogue o acesso do app na conta Google e tente de novo.');

        if (!existing) {
            const t = todayUtc(now);
            await db.query(
                `INSERT INTO google_connections (user_id, google_account_id, google_email, access_token_enc, refresh_token_enc, access_expires_at, scopes, status, range_start, range_end)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
                [userId, who.sub, who.email, encrypt(tok.access_token, key), refreshEnc, sqlUtc(exp), tok.scope, addDays(t, -30), addDays(t, 90)]);
        } else {
            if (existing.google_account_id !== who.sub) {
                // outra conta Google: as tarefas antigas viram cópias locais e os calendários antigos são descartados
                await db.query("UPDATE google_event_links SET status = 'detached' WHERE connection_id = ? AND status = 'active'", [existing.id]);
                await db.query('DELETE FROM google_calendars WHERE connection_id = ?', [existing.id]);
                await db.query('DELETE FROM google_week_fetches WHERE connection_id = ?', [existing.id]);
            }
            await db.query(
                "UPDATE google_connections SET google_account_id = ?, google_email = ?, access_token_enc = ?, refresh_token_enc = ?, access_expires_at = ?, scopes = ?, status = 'active', last_error = NULL, syncing_until = NULL WHERE id = ?",
                [who.sub, who.email, encrypt(tok.access_token, key), refreshEnc, sqlUtc(exp), tok.scope, existing.id]);
        }
    }

    // ---------- calendários ----------
    async function refreshCalendars(userId) {
        const conn = await requireConnection(userId);
        if (conn.status !== 'active') throw new ServiceError(409, 'NEEDS_REAUTH', 'Reconecte sua conta Google.');
        const { items } = await withToken(conn, (t) => google.listCalendars(t));
        for (const c of items) {
            if (!c?.id) continue;
            await db.query(
                `INSERT INTO google_calendars (connection_id, calendar_id, summary, color, time_zone) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE summary = VALUES(summary), color = VALUES(color), time_zone = VALUES(time_zone)`,
                [conn.id, c.id, String(c.summaryOverride || c.summary || c.id).slice(0, 255), typeof c.backgroundColor === 'string' ? c.backgroundColor.slice(0, 16) : null, c.timeZone || null]);
        }
    }
    async function listCalendars(userId, { refresh = false } = {}) {
        const conn = await requireConnection(userId);
        const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM google_calendars WHERE connection_id = ?', [conn.id]);
        if (refresh || n === 0) await refreshCalendars(userId);
        const [rows] = await db.query(
            `SELECT c.calendar_id AS id, c.summary, c.color, c.selected, c.last_error AS lastError, c.last_sync_at AS lastSyncAt,
                    (SELECT COUNT(*) FROM google_event_links l WHERE l.connection_id = c.connection_id AND l.calendar_id = c.calendar_id AND l.task_id IS NOT NULL) AS importedTasks
             FROM google_calendars c WHERE c.connection_id = ? ORDER BY c.summary`, [conn.id]);
        return rows.map((r) => ({ ...r, selected: Boolean(r.selected), importedTasks: Number(r.importedTasks) }));
    }

    // onDeselect: 'remove' apaga as tarefas importadas daquele calendário; 'keep' mantém como cópias locais.
    async function setSelection(userId, selectedIds, onDeselect) {
        const conn = await requireConnection(userId);
        if (!Array.isArray(selectedIds) || selectedIds.some((s) => typeof s !== 'string')) throw new ServiceError(400, 'BAD_REQUEST', 'Lista de calendários inválida.');
        let [cals] = await db.query('SELECT * FROM google_calendars WHERE connection_id = ?', [conn.id]);
        if (selectedIds.some((s) => !cals.some((c) => c.calendar_id === s))) {
            // lista local vazia ou desatualizada: consulta o Google uma vez antes de rejeitar
            await refreshCalendars(userId);
            [cals] = await db.query('SELECT * FROM google_calendars WHERE connection_id = ?', [conn.id]);
        }
        const known = new Set(cals.map((c) => c.calendar_id));
        if (selectedIds.some((s) => !known.has(s))) throw new ServiceError(400, 'UNKNOWN_CALENDAR', 'Calendário desconhecido para esta conta.');
        const want = new Set(selectedIds);
        const newlyOff = cals.filter((c) => c.selected && !want.has(c.calendar_id));
        const newlyOn = cals.filter((c) => !c.selected && want.has(c.calendar_id));

        let affected = 0;
        if (newlyOff.length) {
            const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM google_event_links WHERE connection_id = ? AND calendar_id IN (?) AND task_id IS NOT NULL', [conn.id, newlyOff.map((c) => c.calendar_id)]);
            affected = Number(n);
            if (affected > 0 && !['remove', 'keep'].includes(onDeselect)) {
                throw new ServiceError(409, 'CHOICE_REQUIRED', 'Escolha o que fazer com as tarefas importadas dos calendários desmarcados.', { affectedTasks: affected, options: ['remove', 'keep'] });
            }
            for (const c of newlyOff) {
                if (onDeselect === 'remove') await removeByLinks(userId, 'connection_id = ? AND calendar_id = ?', [conn.id, c.calendar_id]);
                else await db.query("UPDATE google_event_links SET status = 'detached' WHERE connection_id = ? AND calendar_id = ? AND status = 'active'", [conn.id, c.calendar_id]);
                await db.query('UPDATE google_calendars SET selected = 0, updated_cursor = NULL WHERE id = ?', [c.id]);
            }
        }
        for (const c of newlyOn) {
            // primeira seleção (ou reseleção): importação completa do intervalo; vínculos existentes evitam duplicatas
            await db.query('UPDATE google_calendars SET selected = 1, updated_cursor = NULL, last_error = NULL WHERE id = ?', [c.id]);
            await db.query('DELETE FROM google_week_fetches WHERE connection_id = ? AND calendar_id = ?', [conn.id, c.calendar_id]);
        }
        return { selected: selectedIds.length, deselected: newlyOff.length, newlySelected: newlyOn.length, affectedTasks: affected };
    }

    // ---------- intervalo ----------
    async function setSettings(userId, { rangeStart, rangeEnd, outside }) {
        const conn = await requireConnection(userId);
        if (!isISODate(rangeStart) || !isISODate(rangeEnd)) throw new ServiceError(400, 'BAD_RANGE', 'Datas inválidas.');
        if (rangeStart > rangeEnd) throw new ServiceError(400, 'BAD_RANGE', 'A data inicial deve ser anterior ou igual à final.');
        if (daysBetween(rangeStart, rangeEnd) > MAX_RANGE_DAYS) throw new ServiceError(400, 'RANGE_TOO_LARGE', 'O intervalo máximo é de 2 anos.');

        const [out] = await db.query(
            `SELECT l.id, l.task_id FROM google_event_links l JOIN tasks t ON t.id = l.task_id
             WHERE l.connection_id = ? AND l.status = 'active' AND t.due_date IS NOT NULL AND (t.due_date < ? OR t.due_date > ?)`,
            [conn.id, rangeStart, rangeEnd]);
        if (out.length && !['remove', 'keep'].includes(outside)) {
            throw new ServiceError(409, 'CHOICE_REQUIRED', 'Existem tarefas importadas fora do novo intervalo.', { affectedTasks: out.length, options: ['remove', 'keep'] });
        }
        if (out.length) {
            const linkIds = out.map((o) => o.id);
            if (outside === 'remove') {
                await db.query("DELETE FROM tasks WHERE user_id = ? AND source = 'google' AND id IN (?)", [userId, out.map((o) => o.task_id)]);
                await db.query('DELETE FROM google_event_links WHERE id IN (?)', [linkIds]);
            } else {
                await db.query("UPDATE google_event_links SET status = 'detached' WHERE id IN (?)", [linkIds]);
            }
        }
        await db.query('UPDATE google_connections SET range_start = ?, range_end = ? WHERE id = ?', [rangeStart, rangeEnd, conn.id]);
        await db.query('UPDATE google_calendars SET updated_cursor = NULL WHERE connection_id = ?', [conn.id]);
        await db.query('DELETE FROM google_week_fetches WHERE connection_id = ?', [conn.id]);
        return { outsideTasks: out.length };
    }

    // ---------- desconexão ----------
    async function disconnect(userId, tasksChoice) {
        const conn = await requireConnection(userId);
        if (!['remove', 'keep'].includes(tasksChoice)) {
            const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM google_event_links WHERE connection_id = ? AND task_id IS NOT NULL AND status = 'active'", [conn.id]);
            throw new ServiceError(409, 'CHOICE_REQUIRED', 'Escolha o que fazer com as tarefas importadas.', { affectedTasks: Number(n), options: ['remove', 'keep'] });
        }
        if (!(await acquire(conn))) throw new ServiceError(409, 'SYNC_IN_PROGRESS', 'Uma sincronização está em andamento. Tente novamente em instantes.');
        let revoked = false;
        try {
            // revoga o token no Google (melhor esforço; revogar o refresh token invalida também os access tokens)
            const enc = conn.refresh_token_enc || conn.access_token_enc;
            if (enc) { try { revoked = await google.revoke(decrypt(enc, gcfg().encryptionKey)); } catch { revoked = false; } }

            const c = await db.getConnection();
            try {
                await c.beginTransaction();
                if (tasksChoice === 'remove') {
                    // só tarefas ativamente sincronizadas; cópias locais antigas (detached) e nativas são preservadas
                    const [links] = await c.query("SELECT task_id FROM google_event_links WHERE connection_id = ? AND status = 'active' AND task_id IS NOT NULL", [conn.id]);
                    const ids = links.map((l) => l.task_id);
                    if (ids.length) await c.query("DELETE FROM tasks WHERE user_id = ? AND source = 'google' AND id IN (?)", [userId, ids]);
                }
                await c.query('DELETE FROM google_event_links WHERE connection_id = ?', [conn.id]);
                await c.query('DELETE FROM google_connections WHERE id = ?', [conn.id]); // apaga tokens, calendários e cache de semanas
                await c.commit();
            } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
        } catch (e) {
            await release(conn).catch(() => {});
            throw e;
        }
        return { disconnected: true, tokenRevoked: revoked };
    }

    // ---------- status (nunca expõe tokens) ----------
    async function status(userId) {
        const conn = await getConnection(userId);
        if (!conn) return { connected: false };
        const last = fromSql(conn.last_sync_at);
        const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM google_calendars WHERE connection_id = ? AND selected = 1', [conn.id]);
        const syncing = Boolean(conn.syncing_until && fromSql(conn.syncing_until) > now());
        return {
            connected: true,
            account: { email: conn.google_email },
            state: conn.status, // 'active' | 'needs_reauth'
            range: { start: String(conn.range_start).slice(0, 10), end: String(conn.range_end).slice(0, 10) },
            lastSyncAt: last ? last.toISOString() : null,
            lastSyncStatus: conn.last_sync_status,
            lastError: conn.last_error,
            syncing,
            selectedCalendars: Number(n),
            stale: conn.status === 'active' && Number(n) > 0 && !syncing && (!last || now().getTime() - last.getTime() > STALE_MS),
        };
    }

    return { getConnection, status, syncUser, syncWeeks, completeOAuth, listCalendars, setSelection, setSettings, disconnect };
}
