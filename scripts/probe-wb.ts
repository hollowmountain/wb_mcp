/**
 * Проверка токенов Wildberries без запуска сервера.
 *   npx tsx scripts/probe-wb.ts
 * Показывает по каждому кабинету: что зашито в токен и что реально отвечает WB.
 */
import { config } from '../src/config.js';
import { countUnansweredFeedbacks, countUnansweredQuestions, listChats } from '../src/wb/api.js';
import { WbApiError } from '../src/wb/client.js';
import type { Cabinet } from '../src/wb/cabinets.js';
import { CATEGORY_NAMES, daysLeft } from '../src/wb/token.js';

async function check(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
        const result = await fn();
        console.log(`    ✓ ${label}: ${JSON.stringify(result).slice(0, 160)}`);
    } catch (e) {
        console.log(`    ✗ ${label}: ${e instanceof WbApiError ? e.toUserMessage() : String(e)}`);
    }
}

async function probe(cabinet: Cabinet): Promise<void> {
    const { info } = cabinet;
    const days = daysLeft(info);

    console.log(`▸ ${cabinet.slug} — ${cabinet.label}`);
    console.log(`    тип токена: ${info.kind}`);
    console.log(`    доступ:     ${info.readOnly ? 'ТОЛЬКО ЧТЕНИЕ' : 'чтение и запись'}`);
    console.log(
        `    истекает:   ${info.expiresAt?.toISOString().slice(0, 10) ?? '?'}` +
            (days === null ? '' : ` (осталось ${days} дн.)`)
    );
    console.log(`    категории:  ${[...info.categories].map(k => CATEGORY_NAMES[k]).join(', ') || 'нет'}`);
    if (cabinet.problems.length > 0) console.log(`    ⚠ ${cabinet.problems.join('; ')}`);

    await check('Отзывы (count-unanswered)', () => countUnansweredFeedbacks(cabinet));
    await check('Вопросы (count-unanswered)', () => countUnansweredQuestions(cabinet));
    if (config.wb.sandbox) {
        console.log('    – Чаты: в песочнице недоступны');
    } else {
        await check('Чаты (seller/chats)', async () => (await listChats(cabinet)).length);
    }
    console.log();
}

console.log(`Режим: ${config.wb.sandbox ? 'песочница' : 'боевой'}`);
console.log(`Кабинетов настроено: ${config.cabinets.size}
`);

for (const cabinet of config.cabinets.all()) {
    await probe(cabinet);
}

for (const warning of config.cabinets.warnings) console.log(`⚠ ${warning}`);
