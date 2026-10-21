import { pool } from '../db.js';
import express from 'express';
import { requireUser } from '../auth.js';
const router = express.Router();

// Todas as operações são restritas às tarefas do usuário da sessão (user_id = req.user.id).
// Estas rotas só mexem no banco local: nenhuma delas chama o Google Calendar, nem para
// tarefas importadas (concluir, editar e excluir são sempre locais).
const SELECT_FIELDS = 'id, title, description, completed, due_date, created_at, source';

router.use('/api/tasks', requireUser);

router.get('/api/tasks', async (req, res) => {
    const { search = '', status = 'all' } = req.query;
    const uid = req.user.id;

    let sql = `SELECT ${SELECT_FIELDS} FROM tasks WHERE user_id = ? AND title LIKE ?`;
    const params = [uid, `%${String(search)}%`];

    if (status === 'pending') {
        sql += ' AND completed = 0'
    } else if (status === 'completed') {
        sql += ' AND completed = 1'
    }
    sql += ' ORDER BY (due_date IS NULL), due_date ASC, created_at DESC';

    const [rows] = await pool.query(sql, params);
    const [[totals]] = await pool.query(
        'SELECT COUNT(*) AS total, SUM(completed = 1) AS completedCount FROM tasks WHERE user_id = ?',
        [uid]
    );

    return res.send({
        tasks: rows,
        total: totals.total,
        completed: Number(totals.completedCount) || 0,
    });
});

router.post('/api/tasks', async (req, res) => {
    const { title, dueDate } = req.body ?? {};

    if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).send({message: "O nome da tarefa é obrigatório"});
    }
    const [result] = await pool.query(
        "INSERT INTO tasks (user_id, title, completed, due_date, source) VALUES (?, ?, false, ?, 'local')",
        [req.user.id, title.trim(), dueDate || null]
    );

    const [[task]] = await pool.query(
        `SELECT ${SELECT_FIELDS} FROM tasks WHERE id = ? AND user_id = ?`,
        [result.insertId, req.user.id]
    );

    return res.status(201).send(task);
});

router.patch('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    const { completed, title, description, dueDate } = req.body ?? {};

    const [[existing]] = await pool.query('SELECT id FROM tasks WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!existing) {
        return res.status(404).send({message: "Tarefa não encontrada"});
    }
    const fields = [];
    const values = [];

    if (typeof completed === 'boolean') {
        fields.push('completed = ?');
        values.push(completed);
    }
    if (typeof title === 'string' && title.trim()) {
        fields.push('title = ?');
        values.push(title);
    }
    if (typeof description === 'string' && description.trim()) {
        fields.push('description = ?');
        values.push(description);
    }
    // dueDate é uma string 'YYYY-MM-DD', null (para remover) ou undefined (não alterar)
    if (dueDate !== undefined) {
        fields.push('due_date = ?');
        values.push(dueDate || null);
    }
    if (fields.length === 0) {
        return res.status(400).send({message: 'Nada para atualizar'});
    }

    values.push(id, req.user.id);
    await pool.query(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, values);

    const [[task]] = await pool.query(
        `SELECT ${SELECT_FIELDS} FROM tasks WHERE id = ? AND user_id = ?`,
        [id, req.user.id]
    );

    return res.send(task);
});

router.delete('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM tasks WHERE id = ? AND user_id = ?', [id, req.user.id]);

    if (result.affectedRows === 0) {
        return res.status(404).send({message: "Tarefa não encontrada"});
    }
    return res.status(204).send();
});

export default router;
