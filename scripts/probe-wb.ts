/**
 * Проверка токена Wildberries без запуска сервера.
 *   npx tsx scripts/probe-wb.ts
 * Показывает, какие категории доступны и что именно отвечает WB.
 */
import { config } from '../src/config.js';
import { countUnansweredFeedbacks, countUnansweredQuestions, listChats } from '../src/wb/api.js';
import { WbApiError } from '../src/wb/client.js';

function decodeTokenCategories(token: string): string | null {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
        const type =
            payload.acc === 3 ? 'персональный' : payload.acc === 4 ? 'сервисный' : payload.acc === 2 ? 'тестовый' : 'базовый';
        const expires = typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : '?';
        return `тип: ${type}, действует до ${expires}, s (маска категорий): ${String(payload.s ?? '?')}`;
    } catch {
        return null;
    }
}

async function check(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
        const result = await fn();
        console.log(`  ✓ ${label}: ${JSON.stringify(result).slice(0, 160)}`);
    } catch (e) {
        console.log(`  ✗ ${label}: ${e instanceof WbApiError ? e.toUserMessage() : String(e)}`);
    }
}

console.log(`Режим: ${config.wb.sandbox ? 'песочница' : 'боевой'}`);
const info = decodeTokenCategories(config.wb.token);
console.log(`Токен: ${info ?? 'не удалось разобрать — это точно JWT из ЛК продавца?'}`);
console.log('');

await check('Отзывы (count-unanswered)', countUnansweredFeedbacks);
await check('Вопросы (count-unanswered)', countUnansweredQuestions);
if (config.wb.sandbox) {
    console.log('  – Чаты: в песочнице недоступны');
} else {
    await check('Чаты (seller/chats)', async () => (await listChats()).length);
}
