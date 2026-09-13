/**
 * Ссылка на загрузку фото, которую можно дать прямо в переписке.
 *
 * Раньше исходник клали на страницу панели, а туда нужен вход по коду.
 * Для менеджера это лишний барьер: код надо где-то взять, кому-то переслать,
 * не потерять. При этом человек уже опознан — он разговаривает с коннектором
 * под своей учётной записью, и кто он, мы знаем.
 *
 * Поэтому ссылка сама и есть пропуск: в ней подписана почта и срок жизни.
 * Подпись на SESSION_SECRET, состояния на сервере нет — то же решение, что
 * у плана генерации, и по той же причине: сервер собирается заново на каждый
 * запрос, хранить сессии негде.
 *
 * Живёт двадцать минут: этого хватает открыть на телефоне и перетащить файл,
 * но потерянная в переписке ссылка через полчаса уже ничего не открывает.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { config } from '../config.js';

const TTL_SECONDS = 1200;

const sign = (payload: string): string =>
    createHmac('sha256', config.sessionSecret).update(`upload:${payload}`).digest('base64url');

/** Выдаёт ссылку вида https://.../u/<токен> — её и отдают человеку. */
export function makeUploadLink(email: string): { url: string; minutes: number } {
    const payload = Buffer.from(JSON.stringify({ e: email, x: Math.floor(Date.now() / 1000) + TTL_SECONDS }), 'utf8')
        .toString('base64url');
    const url = new URL(`/u/${payload}.${sign(payload)}`, config.publicUrl);
    return { url: url.toString(), minutes: Math.round(TTL_SECONDS / 60) };
}

export type LinkError = 'битая' | 'подделана' | 'просрочена';

/** Чья это ссылка и жива ли она. Возвращает почту либо причину отказа. */
export function emailFromLink(token: string): string | LinkError {
    const [payload, given] = token.trim().split('.');
    if (!payload || !given) return 'битая';

    const expected = sign(payload);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'подделана';

    let data: { e?: unknown; x?: unknown };
    try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { e?: unknown; x?: unknown };
    } catch {
        return 'битая';
    }

    if (typeof data.e !== 'string' || typeof data.x !== 'number') return 'битая';
    if (Math.floor(Date.now() / 1000) > data.x) return 'просрочена';
    return data.e;
}

export const linkErrorText = (e: LinkError): string =>
    e === 'просрочена'
        ? 'Ссылка устарела — она живёт двадцать минут. Попросите в чате новую.'
        : 'Ссылка недействительна. Попросите в чате новую.';
