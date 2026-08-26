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
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- Черновик ответа клиенту. Ничего не уходит в WB, пока статус не станет 'sent'.
CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY,
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
  created_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

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
