import { DatabaseSync } from "node:sqlite";
import path from "path";

// База лежит рядом с кодом, а не в папке, из которой запущен процесс
const db = new DatabaseSync(path.join(import.meta.dirname, "mycord.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
`);

// Добавляет колонку в таблицу, если её ещё нет
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn("messages", "file_url", "TEXT");
addColumn("messages", "file_name", "TEXT");
addColumn("messages", "deleted", "INTEGER NOT NULL DEFAULT 0"); // пользователь удалил своё сообщение
addColumn("sessions", "created_at", "INTEGER"); // для баз, созданных раньше
addColumn("users", "avatar", "TEXT");
addColumn("users", "server_muted", "INTEGER NOT NULL DEFAULT 0"); // заглушка от администратора
addColumn("users", "banned", "INTEGER NOT NULL DEFAULT 0"); // блокировка аккаунта администратором
db.prepare("UPDATE sessions SET created_at = ? WHERE created_at IS NULL").run(Date.now());
addColumn("channels", "kind", "TEXT NOT NULL DEFAULT 'text'"); // text или voice
addColumn("users", "moderator", "INTEGER NOT NULL DEFAULT 0"); // права модератора
addColumn("channels", "pos", "INTEGER NOT NULL DEFAULT 0"); // порядок каналов
addColumn("channels", "password_hash", "TEXT"); // пароль канала (хеш), NULL = без пароля

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS channel_access (
    user_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT
  );
`);

// Стартовые каналы создаём только при самом первом запуске,
// иначе удалённые каналы появлялись бы снова после перезапуска
if (db.prepare("SELECT COUNT(*) AS c FROM channels").get().c === 0) {
  const add = db.prepare("INSERT INTO channels (name, kind) VALUES (?, ?)");
  add.run("general", "text");
  add.run("random", "text");
  add.run("голосовой", "voice");
}

addColumn("messages", "reply_to", "INTEGER"); // ответ на сообщение
addColumn("messages", "edited", "INTEGER NOT NULL DEFAULT 0"); // сообщение изменено
addColumn("messages", "pinned", "INTEGER NOT NULL DEFAULT 0"); // закреплено
db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_name, emoji)
  );
  CREATE TABLE IF NOT EXISTS reads (
    user_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    last_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );
`);

addColumn("channels", "keep", "INTEGER NOT NULL DEFAULT 0"); // личная переписка остаётся в списке, даже если её очистили
addColumn("users", "status_mode", "TEXT NOT NULL DEFAULT 'online'"); // online | away | dnd
addColumn("users", "status_text", "TEXT"); // своя строчка статуса
addColumn("users", "bio", "TEXT"); // «о себе»
addColumn("users", "created_at", "INTEGER"); // дата регистрации (для старых аккаунтов неизвестна)
db.exec(`
  CREATE TABLE IF NOT EXISTS dm_members (
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
`);

db.exec("UPDATE channels SET pos = id WHERE pos = 0"); // порядок для каналов, созданных раньше

export default db;