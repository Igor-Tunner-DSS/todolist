import express from 'express';
import morgan from 'morgan'; // alternativa do Express para o logger do Fastify
import cors from 'cors';
import router from './routes/tasks-express.js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({
    path: path.resolve(__dirname, '../.env')
})
const app = express({});
app.use(express.json())
app.use(morgan('dev'));
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    methods: ['GET', 'DELETE', 'POST', 'PATCH']
}));

app.get('/health', async (req, res) => (res.send({status: 'ok'})));
app.use('/', router);

const port = Number(process.env.PORT) || 3000;

try {
    app.listen(port, 'localhost', () => {
        console.log(`Servidor rodando em http://localhost:${port}`);
    });
} catch (err) {
    console.error(err);
    process.exit(1);
}
