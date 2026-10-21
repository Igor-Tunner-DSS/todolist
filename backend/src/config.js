import 'dotenv/config';

// Lê a configuração a cada chamada para que os testes possam alterar process.env.
export function config() {
    const e = process.env;
    return {
        frontendUrl: e.FRONTEND_URL || 'http://localhost:5173',
        corsOrigin: e.CORS_ORIGIN || 'http://localhost:5173',
        cookieSecure: e.COOKIE_SECURE === 'true',
        signupEnabled: e.SIGNUP_ENABLED !== 'false',
        google: {
            clientId: e.GOOGLE_CLIENT_ID || '',
            clientSecret: e.GOOGLE_CLIENT_SECRET || '',
            redirectUri: e.GOOGLE_REDIRECT_URI || '',
            encryptionKey: e.TOKEN_ENCRYPTION_KEY || '',
        },
    };
}

export function googleConfigured() {
    const g = config().google;
    return Boolean(g.clientId && g.clientSecret && g.redirectUri && g.encryptionKey);
}
