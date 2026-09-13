/**
 * Свои исходники для генерации.
 *
 * Кадры из карточки маркетплейса — плохой исходник: там почти всегда лежит
 * инфографика, и модель копирует не предмет, а чужую вёрстку. У тех, кто
 * ведёт карточки, обычно есть студийные снимки товара — вот они и нужны.
 *
 * Отдать файл прямо в чат нельзя: инструмент принимает текстовые параметры,
 * а картинку через них не передать. Поэтому человек кладёт файл в панели и
 * получает короткий код, который называет в разговоре.
 *
 * Код намеренно короткий и произносимый: его диктуют и пересылают в
 * переписке, а не копируют мышкой.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { config } from '../config.js';
import { db } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Час. Исходник нужен ровно на время работы над кадром: загрузил, согласовал,
 * сгенерировал. Хранить чужие студийные снимки дольше незачем — это не архив,
 * а пересылка, и лишний день на диске нужен только тому, кто их ищет.
 */
const TTL_MS = 60 * 60 * 1000;

/** Больше этого OpenAI на вход не берёт, да и студийный кадр столько не весит. */
const MAX_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const dir = resolve(config.media.dir, 'uploads');
mkdirSync(dir, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS media_uploads (
  code       TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_uploads_email ON media_uploads (email, created_at DESC);
`);

/** Без гласных и похожих знаков: код диктуют вслух, и «0» с «O» путают. */
const ALPHABET = '23456789bcdfghjkmnpqrstvwxz';

function newCode(): string {
    const raw = randomBytes(6);
    let code = '';
    for (const byte of raw) code += ALPHABET[byte % ALPHABET.length];
    return `ref-${code}`;
}

export interface Upload {
    code: string;
    mime: string;
    bytes: number;
    note: string | null;
    createdAt: number;
}

export class UploadError extends Error {}

const extOf = (mime: string): string => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg');

export function saveUpload(email: string, bytes: Buffer, mime: string, note?: string): Upload {
    if (!ALLOWED_MIME.has(mime)) {
        throw new UploadError(`Формат ${mime} не принимается. Нужен JPEG, PNG или WebP.`);
    }
    if (bytes.length === 0) throw new UploadError('Файл пустой.');
    if (bytes.length > MAX_BYTES) throw new UploadError('Файл тяжелее 25 МБ.');

    const code = newCode();
    writeFileSync(join(dir, `${code}.${extOf(mime)}`), new Uint8Array(bytes), { mode: 0o640 });
    db.prepare('INSERT INTO media_uploads (code, email, mime, bytes, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        code,
        email,
        mime,
        bytes.length,
        note?.trim() || null,
        Math.floor(Date.now() / 1000)
    );
    return { code, mime, bytes: bytes.length, note: note?.trim() || null, createdAt: Math.floor(Date.now() / 1000) };
}

/**
 * Читает исходник по коду.
 *
 * Чужой код не подходит намеренно: студийная съёмка — рабочий материал
 * кабинета, и подбирать чужие коды перебором не должно иметь смысла.
 */
export function readUpload(code: string, email: string): { bytes: Buffer; mime: string; note: string | null } | null {
    const clean = code.trim().toLowerCase();
    if (!/^ref-[a-z0-9]{6}$/.test(clean)) return null;

    const row = db.prepare('SELECT email, mime, note, created_at FROM media_uploads WHERE code = ?').get(clean) as
        | { email: string; mime: string; note: string | null; created_at: number }
        | undefined;
    if (!row || row.email !== email) return null;

    const path = join(dir, `${clean}.${extOf(row.mime)}`);
    if (!existsSync(path)) return null;

    return { bytes: readFileSync(path), mime: row.mime, note: row.note };
}

/** Что человек загрузил — чтобы не искать код в переписке недельной давности. */
export function listUploads(email: string, limit = 20): Upload[] {
    return db
        .prepare('SELECT code, mime, bytes, note, created_at FROM media_uploads WHERE email = ? ORDER BY created_at DESC LIMIT ?')
        .all(email, limit)
        .map(r => {
            const row = r as { code: string; mime: string; bytes: number; note: string | null; created_at: number };
            return { code: row.code, mime: row.mime, bytes: row.bytes, note: row.note, createdAt: row.created_at };
        });
}

/**
 * Найти свой исходник по куску названия или кода.
 *
 * Человек помнит «то фото ланолина», а не ref-jjbf4d. Поэтому ищем по
 * подписи, которую он сам оставил при загрузке, и по коду заодно.
 */
export function findUploads(email: string, query: string, limit = 5): Upload[] {
    // Фильтруем в JS, а не запросом: lower() в SQLite приводит только латиницу,
    // и поиск по русскому названию молча не находил ничего.
    const q = query.trim().toLowerCase();
    if (!q) return listUploads(email, limit);
    return listUploads(email, 100)
        .filter(u => (u.note ?? '').toLowerCase().includes(q) || u.code.includes(q))
        .slice(0, limit);
}

/** Уборка: файл и запись о нём уходят вместе, иначе код будет числиться живым. */
export function pruneUploads(): number {
    let removed = 0;
    try {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            try {
                if (Date.now() - statSync(path).mtimeMs > TTL_MS) {
                    rmSync(path);
                    db.prepare('DELETE FROM media_uploads WHERE code = ?').run(name.replace(/\.[^.]+$/, ''));
                    removed += 1;
                }
            } catch {
                /* файл мог исчезнуть между чтением списка и проверкой */
            }
        }
    } catch (e) {
        logger.warn({ err: e }, 'не удалось прибрать загруженные исходники');
    }
    return removed;
}
