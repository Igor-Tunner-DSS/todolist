import express from 'express';
import { pool } from '../db.js';
import { config, googleConfigured } from '../config.js';
import { randomToken, sha256 } from '../crypto.js';
import { requireUser } from '../auth.js';
import { GoogleError } from './client.js';
import { ServiceError } from './sync.js';

// Todas as rotas exigem sessão válida: o ID do usuário vem sempre de req.user (cookie), nunca do corpo
// nem da query. Nenhuma rota aqui escreve no Google Calendar.

const STATE_MINUTES = 10;

export function createGoogleRouter({ service, google, db = pool }) {
    const router = express.Router();

    // O retorno do Google é uma navegação (GET) e trata a sessão por conta própria, para poder
    // redirecionar de volta ao frontend com um resultado em vez de responder 401 em JSON.
    router.get('/callback', async (req, res) => {
        const back = (result, extra = {}) => {
            const url = new URL(config().frontendUrl);
            url.searchParams.set('google', result);
            for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
            res.redirect(302, url.toString());
        };
        try {
            if (!req.user) return back('session_expired');
            const { code, state, error } = req.query;
            if (typeof state !== 'string' || !state) return back('error', { reason: 'bad_state' });

            // `state` é de uso único: é consumido antes de qualquer outra verificação.
            const stateHash = sha256(state);
            const [[row]] = await db.query('SELECT user_id, code_verifier, expires_at FROM google_oauth_states WHERE state_hash = ?', [stateHash]);
            await db.query('DELETE FROM google_oauth_states WHERE state_hash = ?', [stateHash]);
            const expired = !row || new Date(`${String(row.expires_at).replace(' ', 'T')}Z`) < new Date();
            if (!row || expired || row.user_id !== req.user.id) return back('error', { reason: 'bad_state' });

            if (error) return back(error === 'access_denied' ? 'denied' : 'error', { reason: 'denied' });
            if (typeof code !== 'string' || !code) return back('error', { reason: 'no_code' });

            await service.completeOAuth({ userId: req.user.id, code, verifier: row.code_verifier });
            return back('connected');
        } catch (e) {
            // Sem detalhes do Google nem tokens na URL/log.
            const reason = e instanceof ServiceError ? e.code.toLowerCase() : 'failed';
            console.error('[google] falha no callback OAuth:', e?.name, e?.code || e?.status || '');
            return back('error', { reason });
        }
    });

    router.use(requireUser);

    router.get('/status', async (req, res) => {
        const s = await service.status(req.user.id);
        res.send({ configured: googleConfigured(), ...s });
    });

    // POST (e não GET) porque cria estado no servidor e exige o cabeçalho anti-CSRF.
    router.post('/connect', async (req, res) => {
        if (!googleConfigured()) throw new ServiceError(503, 'NOT_CONFIGURED', 'A integração com o Google não está configurada neste servidor.');
        const g = config().google;
        const state = randomToken(32);
        const { verifier, challenge } = google.newPkce();
        await db.query('DELETE FROM google_oauth_states WHERE expires_at < UTC_TIMESTAMP()');
        await db.query(
            'INSERT INTO google_oauth_states (state_hash, user_id, code_verifier, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))',
            [sha256(state), req.user.id, verifier, STATE_MINUTES]);
        res.send({ url: google.authUrl({ clientId: g.clientId, redirectUri: g.redirectUri, state, challenge, loginHint: req.user.email }) });
    });

    router.get('/calendars', async (req, res) => {
        res.send({ calendars: await service.listCalendars(req.user.id, { refresh: req.query.refresh === '1' }) });
    });

    // Salva a seleção e, se algum calendário foi marcado agora, já importa os eventos dele.
    router.put('/calendars', async (req, res) => {
        const { selected, onDeselect } = req.body ?? {};
        const result = await service.setSelection(req.user.id, selected, onDeselect);
        const sync = result.newlySelected > 0 ? await safeSync(req.user.id) : null;
        res.send({ ...result, sync });
    });

    router.put('/settings', async (req, res) => {
        const { rangeStart, rangeEnd, outside } = req.body ?? {};
        const result = await service.setSettings(req.user.id, { rangeStart, rangeEnd, outside });
        const sync = await safeSync(req.user.id);
        res.send({ ...result, sync });
    });

    router.post('/sync', async (req, res) => {
        res.send(await service.syncUser(req.user.id));
    });

    // Recorrências sob demanda: o frontend informa as semanas visíveis (segundas-feiras YYYY-MM-DD).
    router.post('/sync/weeks', async (req, res) => {
        const { weeks, force } = req.body ?? {};
        res.send(await service.syncWeeks(req.user.id, weeks, { force: force === true }));
    });

    router.post('/disconnect', async (req, res) => {
        res.send(await service.disconnect(req.user.id, req.body?.tasks));
    });

    async function safeSync(userId) {
        try { return await service.syncUser(userId); } catch (e) {
            if (e instanceof ServiceError) return { status: 'error', code: e.code, message: e.message };
            return { status: 'error', message: 'Não foi possível sincronizar agora. Use o botão Sync para tentar de novo.' };
        }
    }

    return router;
}

// Converte erros em respostas seguras: nunca devolve corpo/tokens/eventos do Google ao cliente.
export function googleErrorHandler(err, _req, res, next) {
    if (res.headersSent) return next(err);
    if (err instanceof ServiceError) return res.status(err.status).send({ code: err.code, message: err.message, ...err.extra });
    if (err instanceof GoogleError) {
        const status = err.temporary ? 503 : 502;
        const code = err.status === 429 ? 'RATE_LIMITED' : err.temporary ? 'NETWORK' : 'GOOGLE_ERROR';
        const message = err.status === 429 ? 'Limite de requisições do Google atingido. Tente novamente em instantes.'
            : err.temporary ? 'Não foi possível falar com o Google agora. Tente novamente.' : 'O Google recusou a requisição.';
        return res.status(status).send({ code, message });
    }
    console.error('[erro]', err?.name, err?.message);
    return res.status(500).send({ code: 'INTERNAL', message: 'Erro interno do servidor.' });
}
