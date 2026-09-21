import mysql from 'mysql2/promise';
import 'dotenv/config';

const {DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME} = process.env;

export const pool = mysql.createPool({
    host: DB_HOST || 'localhost',
    port: Number(DB_PORT) || 3306,
    user: DB_USER || 'root',
    password: DB_PASSWORD || '',
    database: DB_NAME || 'todolist',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
});