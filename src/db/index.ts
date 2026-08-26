import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id             TEXT PRIMARY KEY,
  client_secret         TEXT,
  client_id_issued_at   INTEGER NOT NULL,
  client_secret_expires_at INTEGER,
  metadata              TEXT NOT NULL
);

-- Заявка на авторизацию, живёт от /authorize до возврата из IdP.
CREATE TABLE IF NOT EXISTS pending_auth (
  id             TEXT PRIMARY KEY,
  purpose        TEXT NOT NULL DEFAULT 'oauth',
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  client_state   TEXT,
  code_challenge TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  resource       TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_email     TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  resource       TEXT,
  expires_at     INTEGER NOT NULL
);

-- Храним только SHA-256 от токена: утечка базы не даёт доступа.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id  TEXT NOT NULL,
  user_email TEXT NOT NULL,
  scopes     TEXT NOT NULL,
  resource   TEXT,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens (user_email, kind);

CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  -- Список кабинетов через запятую. NULL или пусто — доступ ко всем.
  cabinets   TEXT,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- Черновик ответа клиенту. Ничего не уходит в WB, пока статус не станет 'sent'.
CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY,
  cabinet     TEXT NOT NULL DEFAULT 'main',
  kind        TEXT NOT NULL CHECK (kind IN ('feedback','feedback_edit','question','chat')),
  target_id   TEXT NOT NULL,
  target_note TEXT,
  text        TEXT NOT NULL,
  author      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','discarded','failed')),
  sent_by     TEXT,
  sent_at     INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS drafts_status ON drafts (status, created_at);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  cabinet TEXT,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT,
  outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts DESC);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  -- Какие кабинеты откроет этот код. Пусто — все.
  cabinets   TEXT,
  -- Сколько раз кодом можно войти. 0 — без ограничения.
  max_uses   INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  -- Когда входили в последний раз.
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/**
 * Добавляет колонку, если её ещё нет. Нужно для баз, созданных до появления
 * поддержки нескольких кабинетов: у них в drafts и audit нет колонки cabinet.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some(c => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumnIfMissing('pending_auth', 'purpose', "TEXT NOT NULL DEFAULT 'oauth'");
addColumnIfMissing('users', 'cabinets', 'TEXT');
addColumnIfMissing('invites', 'cabinets', 'TEXT');
addColumnIfMissing('invites', 'max_uses', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('invites', 'used_count', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('drafts', 'cabinet', "TEXT NOT NULL DEFAULT 'main'");
addColumnIfMissing('audit', 'cabinet', 'TEXT');

export const now = (): number => Math.floor(Date.now() / 1000);
export const newId = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function kvGet(key: string): string | undefined {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
}

export function kvSet(key: string, value: string): void {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        value
    );
}

/** Периодическая уборка просроченных записей — вызывается по таймеру из index.ts. */
export function cleanupExpired(): void {
    const t = now();
    db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t);
    db.prepare('DELETE FROM pending_auth WHERE created_at < ?').run(t - 900);
    db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(t - 86400);
}
