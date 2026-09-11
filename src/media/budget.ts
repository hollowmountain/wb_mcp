/**
 * Предел трат на генерацию.
 *
 * Область media уже закрыта по умолчанию, но одного разрешения мало:
 * человек с доступом может за вечер нащёлкать карточек на сумму, которую
 * никто не собирался тратить — не со зла, а подбирая сцену. Поэтому кроме
 * «можно или нельзя» есть «сколько в день».
 *
 * Считаем по фактической стоимости из ответа OpenAI, а не по оценке: иначе
 * ошибка в прикидке накапливалась бы весь месяц.
 */

import { db } from '../db/index.js';
import { config } from '../config.js';

db.exec(`
CREATE TABLE IF NOT EXISTS media_spend (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ts    INTEGER NOT NULL,
  -- День и месяц храним строками: так суммы считаются одним запросом
  -- и не зависят от часового пояса машины.
  day   TEXT NOT NULL,
  month TEXT NOT NULL,
  usd   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS media_spend_day ON media_spend (email, day);
CREATE INDEX IF NOT EXISTS media_spend_month ON media_spend (email, month);
`);

/** Дата по Москве: рабочий день у людей заканчивается вечером, а не в полночь UTC. */
function stamps(at = new Date()): { day: string; month: string } {
    const msk = new Date(at.getTime() + 3 * 60 * 60 * 1000);
    const day = msk.toISOString().slice(0, 10);
    return { day, month: day.slice(0, 7) };
}

export interface Spent {
    day: number;
    month: number;
    dayLimit: number;
    monthLimit: number;
}

export function spent(email: string): Spent {
    const { day, month } = stamps();
    const one = (column: 'day' | 'month', value: string): number => {
        const row = db
            .prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM media_spend WHERE email = ? AND ${column} = ?`)
            .get(email, value) as { total: number };
        return row.total;
    };
    return {
        day: one('day', day),
        month: one('month', month),
        dayLimit: config.media.dailyUsd,
        monthLimit: config.media.monthlyUsd
    };
}

const money = (usd: number): string => `${usd.toFixed(2)} $`;

/**
 * Хватает ли лимита на ещё одну генерацию. Проверяем по оценке до запуска:
 * отказать до списания можно, вернуть деньги после — нет.
 */
export function refuseIfOverLimit(email: string, estimateUsd: number): string | null {
    const s = spent(email);

    if (s.day + estimateUsd > s.dayLimit) {
        return (
            `Дневной предел на генерацию исчерпан: сегодня уже ${money(s.day)} из ${money(s.dayLimit)}, ` +
            `а этот запуск добавит примерно ${money(estimateUsd)}. Предел обновится завтра; ` +
            'поднять его может администратор в настройках сервера.'
        );
    }
    if (s.month + estimateUsd > s.monthLimit) {
        return (
            `Месячный предел исчерпан: ${money(s.month)} из ${money(s.monthLimit)}. ` +
            'Поднять его может администратор в настройках сервера.'
        );
    }
    return null;
}

export function record(email: string, usd: number): void {
    const { day, month } = stamps();
    db.prepare('INSERT INTO media_spend (email, ts, day, month, usd) VALUES (?, ?, ?, ?, ?)').run(
        email,
        Math.floor(Date.now() / 1000),
        day,
        month,
        usd
    );
}

/** Строка для ответа инструмента: сколько потрачено и сколько осталось. */
export function describe(email: string): string {
    const s = spent(email);
    return `Потрачено сегодня ${money(s.day)} из ${money(s.dayLimit)}, за месяц ${money(s.month)} из ${money(s.monthLimit)}.`;
}
