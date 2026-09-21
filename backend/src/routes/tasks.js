import {pool} from '../db.js';

const SELECT_FIELDS = 'id, title, description, completed, due_date, created_at';
export default async function taskRoutes(app) {
    app.get('/api/tasks', async (req, res) => {
        const { search = '', status = 'all' } = req.query;
        
        let sql = `SELECT ${SELECT_FIELDS} FROM tasks WHERE title LIKE ?`;
        const params = [`%${search}%`];

        if (status === 'pending') {
            sql += ' AND completed = 0'
        } else if (status === 'completed') {
            sql += ' AND completed = 1'
        }
        sql += ' ORDER BY (due_date IS NULL), due_date ASC, created_at DESC';

        const [rows] = await pool.query(sql, params);
        const [[totals]] = await pool.query(
            'SELECT COUNT(*) AS total, SUM(completed = 1) AS completedCount FROM tasks'
        );

        return res.send({
            tasks: rows,
            total: totals.total,
            completed: Number(totals.completedCount) || 0,
        });
    });

    app.post('/api/tasks', async (req, res) => {
        const { title, dueDate } = req.body ?? {};

        if (!title || !title.trim()) {
            return res.status(400).send({message: "O nome da tarefa é obrigatório"});
        }
        const [result] = await pool.query(
            'INSERT INTO tasks (title, completed, due_date) VALUES (?, false, ?)',
            [title.trim(), dueDate || null]
        );

        const [[task]] = await pool.query(
            `SELECT ${SELECT_FIELDS} FROM tasks WHERE id = ?`,
            [result.insertId]
        );

        return res.status(201).send(task);
    });

    app.patch('/api/tasks/:id', async (req, res) => {
        const { id } = req.params;
        const { completed, title, description, dueDate } = req.body ?? {};

        const [[existing]] = await pool.query('SELECT id FROM tasks WHERE id = ?', [id]);
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
        if (typeof dueDate !== undefined) {
            fields.push('due_date = ?');
            values.push(dueDate || null);
        }
        if (fields.length === 0) {
            return res.status(400).send({message: 'Nada para atualizar'});
        }

        values.push(id);
        await pool.query(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, values);

        const [[task]] = await pool.query(
            `SELECT ${SELECT_FIELDS} FROM tasks WHERE id = ?`,
            [id]
        );

        return res.send(task);
    });

    app.delete('/api/tasks/:id', async (req, res) => {
        const { id } = req.params;
        const [result] = await pool.query('DELETE FROM tasks WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).send({message: "Tarefa não encontrada"});
        }
        return res.status(204).send();
    });
}