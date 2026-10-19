import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import taskRoutes from './routes/tasks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({
    path: path.resolve(__dirname, '../.env')
})
const app = Fastify({ logger: true });

await app.register(cors, {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    methods: ['GET', 'PATCH', 'DELETE', 'POST']
});

app.get('/health', async () => ({status: 'ok'}));

await app.register(taskRoutes);

const port = Number(process.env.PORT) || 3000;

try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Servidor rodando em http://localhost:${port}`);
} catch (err) {
    app.log.error(err);
    process.exit(1);
}