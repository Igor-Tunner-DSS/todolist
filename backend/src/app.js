import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import { config } from './config.js';
import { sessionMiddleware, csrfGuard, authRouter } from './auth.js';
import tasksRouter from './routes/tasks-express.js';
import { createGoogleRouter, googleErrorHandler } from './google/routes.js';
import { createGoogleClient } from './google/client.js';
import { createSyncService } from './google/sync.js';

// Monta a aplicação. `google` e `service` podem ser injetados (testes usam um Google falso).
export function createApp({ google = createGoogleClient(), service = createSyncService({ google }), logger = true } = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '100kb' }));
    // Log só com método, caminho (SEM query string: o callback OAuth leva `code` e `state` nela) e status.
    morgan.token('safe-path', (req) => new URL(req.originalUrl, 'http://x').pathname);
    if (logger) app.use(morgan(':method :safe-path :status :response-time ms'));
    // credentials: o cookie de sessão precisa acompanhar as requisições do frontend.
    app.use(cors({ origin: config().corsOrigin, credentials: true }));

    app.get('/health', (_req, res) => res.send({ status: 'ok' }));

    app.use(sessionMiddleware);
    app.use(csrfGuard);
    app.use('/api/auth', authRouter);
    app.use('/api/integrations/google', createGoogleRouter({ service, google }));
    app.use('/', tasksRouter);

    app.use(googleErrorHandler);
    return app;
}
