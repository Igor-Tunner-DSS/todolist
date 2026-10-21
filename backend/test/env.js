// Configuração do ambiente de teste. Deve ser a PRIMEIRA importação de cada arquivo de teste,
// porque db.js lê o ambiente ao ser carregado.
const name = process.env.TEST_DB_NAME || 'todolist_test';
if (!/_test$/.test(name)) throw new Error('TEST_DB_NAME deve terminar com _test (os testes apagam dados).');
Object.assign(process.env, {
    DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT || '3306',
    DB_USER: process.env.TEST_DB_USER || 'tl',
    DB_PASSWORD: process.env.TEST_DB_PASSWORD || 'tl',
    DB_NAME: name,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3333/api/integrations/google/callback',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    FRONTEND_URL: 'http://localhost:5173',
    CORS_ORIGIN: 'http://localhost:5173',
    SIGNUP_ENABLED: 'true',
});
