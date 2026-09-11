/**
 * Где живут готовые картинки и как человек их забирает.
 *
 * Отдавать картинку прямо в ответ инструмента можно, но она весит под
 * мегабайт, а за одну карточку их выходит семь. Поэтому файл кладётся на
 * диск, а в чат уходит ссылка.
 *
 * Ссылка подписана и живёт неделю. Без подписи чужой человек, знающий адрес
 * сервера, перебором нашёл бы чужие карточки до публикации; с подписью не
 * нужен вход в панель — менеджер просто открывает ссылку из переписки.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { config } from '../config.js';
import { logger } from '../logger.js';

/** Неделя: успеть скачать и загрузить на площадку — с запасом. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const dir = resolve(config.media.dir);
mkdirSync(dir, { recursive: true });

const sign = (id: string): string => createHmac('sha256', config.sessionSecret).update(`media:${id}`).digest('base64url');

export interface Stored {
    id: string;
    /** Полная ссылка, которую можно отдать человеку. */
    url: string;
    bytes: number;
}

export function save(bytes: Buffer, mime: string): Stored {
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const id = `${randomUUID()}.${ext}`;
    writeFileSync(join(dir, id), new Uint8Array(bytes), { mode: 0o640 });

    const url = new URL(`/media/${id}`, config.publicUrl);
    url.searchParams.set('s', sign(id));
    return { id, url: url.toString(), bytes: bytes.length };
}

export interface Found {
    bytes: Buffer;
    mime: string;
}

/** Читает файл, если подпись сходится и он ещё не протух. */
export function read(id: string, signature: string): Found | null {
    // Имя приходит из адресной строки: пускаем только то, что сами выдали.
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(id)) return null;

    const expected = sign(id);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const path = join(dir, id);
    if (!existsSync(path)) return null;
    if (Date.now() - statSync(path).mtimeMs > TTL_MS) return null;

    const ext = id.split('.').pop()?.toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { bytes: readFileSync(path), mime };
}

/**
 * Уборка старых файлов. Диск на сервере маленький, а карточки копятся:
 * без этого через полгода место кончится в самый неудобный момент.
 */
export function prune(): number {
    let removed = 0;
    try {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            try {
                if (Date.now() - statSync(path).mtimeMs > TTL_MS) {
                    rmSync(path);
                    removed += 1;
                }
            } catch {
                /* файл мог исчезнуть между чтением списка и проверкой */
            }
        }
    } catch (e) {
        logger.warn({ err: e }, 'не удалось прибрать каталог картинок');
    }
    return removed;
}
