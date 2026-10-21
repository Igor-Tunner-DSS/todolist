import 'dotenv/config';
import { createApp } from './app.js';
import { migrate } from './migrate.js';

const port = Number(process.env.PORT) || 3333;

try {
    // Migrações incrementais e idempotentes (ver migrate.js): seguras a cada inicialização.
    const ran = await migrate();
    if (ran.length) console.log('Migrações aplicadas:', ran.join(', '));

    createApp().listen(port, 'localhost', () => {
        console.log(`Servidor rodando em http://localhost:${port}`);
    });
} catch (err) {
    console.error(err);
    process.exit(1);
}
