// Cliente HTTP do Google (OAuth + Calendar API).
//
// REGRA INEGOCIÁVEL: integração somente leitura. Toda chamada à Calendar API passa por
// `calendarGet`, que só emite GET. Os únicos POST existentes vão aos endpoints OAuth do
// Google (troca de código, refresh e revogação de token) e não alteram nenhum calendário.

import crypto from 'node:crypto';

export const SCOPES = [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.events.readonly',      // ler eventos
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly', // listar calendários
];
export const REQUIRED_CALENDAR_SCOPES = SCOPES.filter((s) => s.includes('/calendar.'));

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

export class GoogleError extends Error {
    constructor(message, { status = 0, reason = '', temporary = false, auth = false, revoked = false } = {}) {
        super(message);
        this.name = 'GoogleError';
        Object.assign(this, { status, reason, temporary, auth, revoked });
    }
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGoogleClient({ fetchImpl = globalThis.fetch, sleep = defaultSleep, maxAttempts = 4, random = Math.random } = {}) {
    // Requisição com espera exponencial limitada. Nunca entra em laço infinito.
    async function send(url, init) {
        let lastErr;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let res;
            try {
                res = await fetchImpl(url, init);
            } catch {
                lastErr = new GoogleError('Falha de rede ao falar com o Google.', { temporary: true });
                if (attempt < maxAttempts - 1) { await sleep(backoff(attempt, null)); continue; }
                throw lastErr;
            }
            if (res.ok) return res;
            const body = await res.json().catch(() => ({}));
            const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || (typeof body?.error === 'string' ? body.error : '') || '';
            const status = res.status;
            if (status === 401) throw new GoogleError('Autorização do Google inválida ou expirada.', { status, reason, auth: true });
            if (status === 400 && reason === 'invalid_grant') throw new GoogleError('Acesso revogado ou expirado.', { status, reason, auth: true, revoked: true });
            const retriable = status === 429 || status >= 500 || (status === 403 && RATE_REASONS.has(reason));
            lastErr = new GoogleError(`Erro ${status} da API do Google.`, { status, reason, temporary: retriable });
            if (!retriable) throw lastErr;
            if (attempt < maxAttempts - 1) await sleep(backoff(attempt, res.headers?.get?.('retry-after')));
        }
        throw lastErr;
    }
    const backoff = (attempt, retryAfter) => {
        const ra = Number(retryAfter);
        if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30000);
        return Math.min(500 * 2 ** attempt, 8000) + Math.floor(random() * 250);
    };

    const form = (obj) => new URLSearchParams(obj).toString();
    const tokenPost = (params) => send(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form(params),
    }).then((r) => r.json());

    // GET-only: única porta de acesso à Calendar API.
    async function calendarGet(path, params, accessToken) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) qs.set(k, String(v));
        const url = `${CAL_BASE}${path}${qs.size ? `?${qs}` : ''}`;
        const res = await send(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } });
        return res.json();
    }

    async function paged(path, params, accessToken, maxPages = 40) {
        const items = [];
        let pageToken;
        let meta = {};
        for (let i = 0; i < maxPages; i++) {
            const data = await calendarGet(path, { ...params, maxResults: 250, pageToken }, accessToken);
            items.push(...(data.items || []));
            meta = { timeZone: data.timeZone };
            pageToken = data.nextPageToken;
            if (!pageToken) return { items, ...meta };
        }
        throw new GoogleError('Resultado paginado grande demais.', { temporary: false });
    }

    return {
        newPkce() {
            const verifier = crypto.randomBytes(48).toString('base64url');
            return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
        },
        authUrl({ clientId, redirectUri, state, challenge, loginHint }) {
            const p = new URLSearchParams({
                client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
                state, code_challenge: challenge, code_challenge_method: 'S256',
                access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
            });
            if (loginHint) p.set('login_hint', loginHint);
            return `${AUTH_URL}?${p}`;
        },
        exchangeCode: ({ clientId, clientSecret, redirectUri, code, verifier }) =>
            tokenPost({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier }),
        refresh: ({ clientId, clientSecret, refreshToken }) =>
            tokenPost({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }),
        async revoke(token) {
            try { await send(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ token }) }); return true; }
            catch { return false; } // melhor esforço
        },
        listCalendars: (accessToken) => paged('/users/me/calendarList', { minAccessRole: 'reader', showHidden: false }, accessToken),
        listEvents: (accessToken, calendarId, params) => paged(`/calendars/${encodeURIComponent(calendarId)}/events`, params, accessToken),
    };
}

// Decodifica o id_token recebido diretamente do endpoint de token do Google (canal TLS autenticado
// com client_secret) e confere emissor, público e validade.
export function readIdToken(idToken, clientId, now = Date.now()) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new GoogleError('id_token inválido.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) throw new GoogleError('Emissor do id_token inválido.');
    if (claims.aud !== clientId) throw new GoogleError('Público do id_token inválido.');
    if (!claims.exp || claims.exp * 1000 < now) throw new GoogleError('id_token expirado.');
    if (!claims.sub) throw new GoogleError('id_token sem identificador de conta.');
    return { sub: String(claims.sub), email: claims.email ? String(claims.email) : null };
}
