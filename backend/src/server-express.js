import express from 'express';
import 'dotenv/config';
import morgan from 'morgan'; // alternativa do Express para o logger do Fastify
import cors from 'cors';
import router from './routes/tasks-express.js';

const app = express({});
app.use(express.json())
app.use(morgan('dev'));
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localost:5173'
}));

app.get('/health', async (req, res) => (res.send({status: 'ok'})));
app.use('/', router);

const port = Number(process.env.PORT) || 3333;

try {
    app.listen(port, 'localhost', () => {
        console.log(`Servidor rodando em http://localhost:${port}`);
    });
} catch (err) {
    console.error(err);
    process.exit(1);
}
