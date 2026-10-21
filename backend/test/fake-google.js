// Google falso: implementa o `fetch` que o cliente real usa (OAuth + Calendar API).
// Registra todas as chamadas para que os testes provem que não há escrita no Google Calendar.

const jwt = (claims) => ['x', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'x'].join('.');
const json = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
export const CAL_SCOPES = 'https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly';

export function createFakeGoogle({ clientId = 'test-client-id' } = {}) {
    let seq = 0;
    const f = {
        calls: [],            // { method, host, path, params }
        accounts: {},         // sub -> { email, calendars: [] }
        events: {},           // calendarId -> evento[] (com _kind: simple|master|instance|exception)
        codes: new Map(),     // code -> { sub, scope }
        access: new Map(),    // access token -> sub
        refresh: new Map(),   // refresh token -> sub
        refreshCount: 0,
        pageSize: 250,
        delayMs: 0,
        netDown: false,
        failEvents: [],       // fila de { status, reason?, retryAfter? } consumida pelas requisições de eventos
        expiresIn: 3600,
        now: () => Date.now(),
    };
    f.addAccount = (sub, email, calendars) => { f.accounts[sub] = { email, calendars }; for (const c of calendars) f.events[c.id] ??= []; };
    f.issueCode = (sub, scope = CAL_SCOPES) => { const c = `code-${++seq}`; f.codes.set(c, { sub, scope: `openid email ${scope}`.trim() }); return c; };
    f.revokeAccount = (sub) => { for (const [t, s] of f.refresh) if (s === sub) f.refresh.delete(t); for (const [t, s] of f.access) if (s === sub) f.access.delete(t); f.revoked = true; };
    f.add = (calId, ev) => { const stored = { etag: `"e${++seq}"`, updated: new Date(f.now()).toISOString(), ...ev }; f.events[calId].push(stored); return stored; };
    f.change = (ev, patch) => Object.assign(ev, patch, { etag: `"e${++seq}"`, updated: new Date(f.now()).toISOString() });
    f.writes = () => f.calls.filter((c) => c.host === 'www.googleapis.com' && c.method !== 'GET');
    f.eventCalls = () => f.calls.filter((c) => c.path.endsWith('/events'));

    const startMs = (e) => Date.parse(e.start?.dateTime || `${e.start?.date}T00:00:00Z`);

    f.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method || 'GET';
        f.calls.push({ method, host: u.host, path: u.pathname, params: Object.fromEntries(u.searchParams) });
        if (f.netDown) throw new TypeError('fetch failed');
        if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));

        if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') return json(200, {});
        if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
            const p = new URLSearchParams(init.body);
            if (p.get('client_id') !== clientId || p.get('client_secret') !== 'test-client-secret') return json(401, { error: 'invalid_client' });
            if (p.get('grant_type') === 'authorization_code') {
                const c = f.codes.get(p.get('code'));
                if (!c || !p.get('code_verifier')) return json(400, { error: 'invalid_grant' });
                f.codes.delete(p.get('code'));
                const at = `at-${++seq}`, rt = `rt-${++seq}`;
                f.access.set(at, c.sub); f.refresh.set(rt, c.sub);
                f.lastIssued = { at, rt };
                return json(200, { access_token: at, refresh_token: rt, expires_in: f.expiresIn, scope: c.scope,
                    id_token: jwt({ iss: 'https://accounts.google.com', aud: clientId, sub: c.sub, email: f.accounts[c.sub]?.email, exp: Math.floor(f.now() / 1000) + 3600 }) });
            }
            if (p.get('grant_type') === 'refresh_token') {
                f.refreshCount++;
                const sub = f.refresh.get(p.get('refresh_token'));
                if (!sub) return json(400, { error: 'invalid_grant' });
                const at = `at-${++seq}`; f.access.set(at, sub);
                return json(200, { access_token: at, expires_in: f.expiresIn });
            }
            return json(400, { error: 'unsupported_grant_type' });
        }

        if (u.host !== 'www.googleapis.com') return json(404, {});
        const sub = f.access.get((init.headers?.Authorization || '').replace('Bearer ', ''));
        if (!sub) return json(401, { error: { status: 'UNAUTHENTICATED' } });

        if (u.pathname === '/calendar/v3/users/me/calendarList') return json(200, { items: f.accounts[sub].calendars });
        const m = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
        if (m) {
            const calId = decodeURIComponent(m[1]);
            const fail = f.failEvents.shift();
            if (fail) return json(fail.status, { error: { errors: [{ reason: fail.reason || '' }] } }, fail.retryAfter ? { 'retry-after': String(fail.retryAfter) } : {});
            if (!f.accounts[sub].calendars.some((c) => c.id === calId)) return json(404, { error: { errors: [{ reason: 'notFound' }] } });
            const q = u.searchParams;
            const expand = q.get('singleEvents') === 'true';
            const tMin = Date.parse(q.get('timeMin')), tMax = Date.parse(q.get('timeMax'));
            let list = (f.events[calId] || []).filter((e) => (expand ? e._kind !== 'master' : e._kind !== 'instance'));
            list = list.filter((e) => e._kind === 'master' || (startMs(e) >= tMin && startMs(e) < tMax) || e.status === 'cancelled' && startMs(e) >= tMin && startMs(e) < tMax);
            if (q.get('showDeleted') !== 'true') list = list.filter((e) => e.status !== 'cancelled');
            if (q.get('updatedMin')) list = list.filter((e) => Date.parse(e.updated) >= Date.parse(q.get('updatedMin')));
            const from = Number(q.get('pageToken') || 0), size = Math.min(f.pageSize, Number(q.get('maxResults') || 250));
            const page = list.slice(from, from + size).map(({ _kind, ...e }) => e);
            return json(200, { items: page, timeZone: 'America/Sao_Paulo', nextPageToken: from + size < list.length ? String(from + size) : undefined });
        }
        return json(404, {});
    };
    return f;
}
