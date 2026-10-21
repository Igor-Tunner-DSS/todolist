import { pool } from './db.js';

// Migração incremental e idempotente (o projeto não tinha mecanismo de migração).
// Cada migração verifica o estado atual do banco antes de alterar, portanto é segura
// tanto em bancos antigos (só com schema.sql) quanto em bancos novos. Nenhuma tabela
// existente é apagada ou recriada.

const q = async (db, sql, p = []) => (await db.query(sql, p))[0];
const hasColumn = async (db, t, c) => (await q(db, 'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [t, c])).length > 0;
const hasIndex = async (db, t, i) => (await q(db, 'SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [t, i])).length > 0;
const hasConstraint = async (db, t, c) => (await q(db, 'SELECT 1 FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?', [t, c])).length > 0;

const migrations = [
    {
        id: '001_users_and_google_calendar',
        async up(db) {
            const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

            await db.query(`CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_users_email (email)
            ) ${T}`);

            await db.query(`CREATE TABLE IF NOT EXISTS sessions (
                token_hash CHAR(64) NOT NULL PRIMARY KEY,
                user_id INT NOT NULL,
                expires_at DATETIME NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY ix_sessions_user (user_id),
                CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ${T}`);

            // tasks: user_id (NULL = tarefa legada, ainda sem dono), source ('local' | 'google'),
            // e description passa de VARCHAR(1024) para TEXT (descrição + bloco de metadados).
            if (!(await hasColumn(db, 'tasks', 'user_id'))) await db.query('ALTER TABLE tasks ADD COLUMN user_id INT NULL');
            if (!(await hasColumn(db, 'tasks', 'source'))) await db.query("ALTER TABLE tasks ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'local'");
            await db.query('ALTER TABLE tasks MODIFY COLUMN description TEXT NULL');
            if (!(await hasIndex(db, 'tasks', 'ix_tasks_user_due'))) await db.query('ALTER TABLE tasks ADD INDEX ix_tasks_user_due (user_id, due_date)');
            if (!(await hasConstraint(db, 'tasks', 'fk_tasks_user'))) await db.query('ALTER TABLE tasks ADD CONSTRAINT fk_tasks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');

            await db.query(`CREATE TABLE IF NOT EXISTS google_connections (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                google_account_id VARCHAR(64) NOT NULL,
                google_email VARCHAR(255) NULL,
                access_token_enc TEXT NULL,
                refresh_token_enc TEXT NULL,
                access_expires_at DATETIME NULL,
                scopes VARCHAR(1024) NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'active',
                range_start DATE NOT NULL,
                range_end DATE NOT NULL,
                last_sync_at DATETIME NULL,
                last_sync_status VARCHAR(16) NULL,
                last_error VARCHAR(255) NULL,
                syncing_until DATETIME NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_gconn_user (user_id),
                CONSTRAINT fk_gconn_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ${T}`);

            await db.query(`CREATE TABLE IF NOT EXISTS google_calendars (
                id INT AUTO_INCREMENT PRIMARY KEY,
                connection_id INT NOT NULL,
                calendar_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
                summary VARCHAR(255) NOT NULL,
                color VARCHAR(16) NULL,
                time_zone VARCHAR(64) NULL,
                selected TINYINT(1) NOT NULL DEFAULT 0,
                has_recurring TINYINT(1) NOT NULL DEFAULT 0,
                updated_cursor DATETIME NULL,
                last_sync_at DATETIME NULL,
                last_error VARCHAR(255) NULL,
                UNIQUE KEY uq_gcal (connection_id, calendar_id),
                CONSTRAINT fk_gcal_conn FOREIGN KEY (connection_id) REFERENCES google_connections(id) ON DELETE CASCADE
            ) ${T}`);

            await db.query(`CREATE TABLE IF NOT EXISTS google_event_links (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                connection_id INT NOT NULL,
                calendar_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
                event_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                series_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NULL,
                occurrence_start VARCHAR(40) NULL,
                task_id INT NULL,
                etag VARCHAR(255) NULL,
                google_updated VARCHAR(40) NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'active',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_glink_event (user_id, calendar_id, event_id),
                KEY ix_glink_task (task_id),
                KEY ix_glink_series (user_id, series_id(191)),
                KEY ix_glink_conn (connection_id),
                CONSTRAINT fk_glink_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_glink_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
            ) ${T}`);

            await db.query(`CREATE TABLE IF NOT EXISTS google_oauth_states (
                state_hash CHAR(64) NOT NULL PRIMARY KEY,
                user_id INT NOT NULL,
                code_verifier VARCHAR(128) NOT NULL,
                expires_at DATETIME NOT NULL,
                CONSTRAINT fk_gstate_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ${T}`);

            await db.query(`CREATE TABLE IF NOT EXISTS google_week_fetches (
                connection_id INT NOT NULL,
                calendar_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
                week_start DATE NOT NULL,
                fetched_at DATETIME NOT NULL,
                PRIMARY KEY (connection_id, calendar_id, week_start),
                CONSTRAINT fk_gweek_conn FOREIGN KEY (connection_id) REFERENCES google_connections(id) ON DELETE CASCADE
            ) ${T}`);
        },
    },
];

export async function migrate(db = pool) {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(100) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [done] = await db.query('SELECT id FROM schema_migrations');
    const applied = new Set(done.map((r) => r.id));
    const ran = [];
    for (const m of migrations) {
        if (applied.has(m.id)) continue;
        await m.up(db);
        await db.query('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
        ran.push(m.id);
    }
    return ran;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    migrate().then((r) => { console.log('Migrações aplicadas:', r.length ? r.join(', ') : 'nenhuma (já atualizado)'); return pool.end(); })
        .catch((e) => { console.error(e); process.exit(1); });
}
