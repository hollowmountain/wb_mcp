import { createHmac, timingSafeEqual } from 'node:crypto';

import { config } from '../config.js';
import type { Quality } from './openai.js';
import type { Overlay, SizeKey, Slot } from './slots.js';

/**
 * Согласованный план генерации.
 *
 * Зачем он вообще. Генерация тратит настоящие деньги и почти всегда выходит
 * не с первого раза: модель меняет сцену, иначе расставляет текст, ловит
 * блик не туда. Поэтому между «человек сказал, чего хочет» и «списались
 * деньги» должна стоять остановка, где видно точный запрос и точную цену.
 *
 * План — не запись в базе, а подписанная строка. Так вышло не из экономии:
 * сервер работает без сессий, на каждый запрос он собирается заново, и
 * хранить состояние между двумя вызовами инструмента негде. Подпись на
 * SESSION_SECRET решает это и заодно даёт большее: запустится ровно то, что
 * показали человеку. Подменить промт после одобрения нельзя — подпись
 * перестанет сходиться.
 */

export interface Plan {
    slot: Slot;
    size: SizeKey;
    quality: Quality;
    /** Готовый промт целиком — тот самый, что показали человеку. */
    prompt: string;
    /** Откуда брать фото товара. Саму картинку в план не кладём: она тяжёлая. */
    cabinet: string | null;
    nmId?: number;
    photo?: number;
    imageUrl?: string;
    /** Что написано на картинке — чтобы повторить это в ответе и в журнале. */
    overlay: Overlay;
    /** Оценка на момент согласования. Настоящая цена придёт после запуска. */
    estUsd: number;
    /** Кому показали. Чужой план запустить нельзя. */
    email: string;
    /** Когда согласовали, unix-секунды. */
    at: number;
}

/** План живёт полчаса: за это время цена не изменится, а забытый план протухнет. */
const TTL_SECONDS = 1800;

const sign = (payload: string): string =>
    createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

export function encodePlan(plan: Plan): string {
    const payload = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
    return `${payload}.${sign(payload)}`;
}

export type PlanError = 'битый' | 'подделан' | 'просрочен' | 'чужой';

export function decodePlan(token: string, email: string): Plan | PlanError {
    const [payload, given] = token.trim().split('.');
    if (!payload || !given) return 'битый';

    const expected = sign(payload);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'подделан';

    let plan: Plan;
    try {
        plan = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Plan;
    } catch {
        return 'битый';
    }

    if (Math.floor(Date.now() / 1000) - plan.at > TTL_SECONDS) return 'просрочен';
    // План согласован конкретным человеком: чужой запускать нечего, да и в
    // журнале иначе получилось бы, что деньги потратил не тот.
    if (plan.email !== email) return 'чужой';

    return plan;
}

export const planErrorText = (e: PlanError): string => {
    switch (e) {
        case 'просрочен':
            return 'Согласование устарело — прошло больше получаса. Соберите план заново через media_plan.';
        case 'чужой':
            return 'Этот план согласовывал другой человек. Соберите свой через media_plan.';
        case 'подделан':
            return 'Подпись плана не сходится. Запускать можно только то, что вернул media_plan, не меняя ни знака.';
        default:
            return 'План не разобрать. Возьмите строку из ответа media_plan целиком.';
    }
};
