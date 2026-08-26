import type { Chat, ChatEvent, Feedback, Question } from '../wb/api.js';

const dash = '—';

function ts(value: string | undefined | null): string {
    if (!value) return dash;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function tsFromMillis(value: number | undefined): string {
    if (!value) return dash;
    return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * WB отдаёт цену в goodCard целым числом без указания единиц. По значениям
 * похоже на копейки, но в документации это не зафиксировано — поэтому
 * показываем и человекочитаемую сумму, и исходное число для сверки.
 */
function price(value: number | undefined, currency: string | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return dash;
    const major = (value / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${major} ${currency ?? ''}`.trim() + ` (WB отдаёт ${value})`;
}

function stars(n: number): string {
    if (!Number.isFinite(n) || n < 1) return dash;
    return '★'.repeat(Math.min(5, n)) + '☆'.repeat(Math.max(0, 5 - n)) + ` (${n})`;
}

export function formatFeedback(f: Feedback, index?: number): string {
    const head = index === undefined ? '' : `${index}. `;
    const lines: string[] = [
        `${head}Отзыв ${f.id} ${dash} ${stars(f.productValuation)} ${dash} ${ts(f.createdDate)}`,
        `   Товар: ${f.productDetails?.productName ?? dash} (nmId ${f.productDetails?.nmId ?? dash}, артикул ${f.productDetails?.supplierArticle ?? dash})`,
        `   Покупатель: ${f.userName || 'без имени'} ${dash} статус заказа: ${f.orderStatus || dash}`
    ];

    if (f.text) lines.push(`   Текст: ${f.text}`);
    if (f.pros) lines.push(`   Плюсы: ${f.pros}`);
    if (f.cons) lines.push(`   Минусы: ${f.cons}`);
    if (f.bables?.length) lines.push(`   Теги WB: ${f.bables.join(', ')}`);
    if (f.photoLinks?.length) lines.push(`   Фото: ${f.photoLinks.length} шт.`);
    if (f.video) lines.push(`   Видео: ${f.video.durationSec} с`);

    if (f.answer?.text) {
        const editable = f.answer.editable ? 'можно отредактировать один раз' : 'редактирование недоступно';
        lines.push(`   Наш ответ: ${f.answer.text}`);
        lines.push(`   Статус ответа: ${f.answer.state ?? dash}, ${editable}`);
    } else {
        lines.push('   Наш ответ: отсутствует');
    }

    if (f.isAbleReturnProductOrders) lines.push('   Доступен запрос возврата товара по этому отзыву');
    return lines.join('\n');
}

export function formatQuestion(q: Question, index?: number): string {
    const head = index === undefined ? '' : `${index}. `;
    const lines: string[] = [
        `${head}Вопрос ${q.id} ${dash} ${ts(q.createdDate)} ${dash} состояние: ${q.state}`,
        `   Товар: ${q.productDetails?.productName ?? dash} (nmId ${q.productDetails?.nmId ?? dash}, артикул ${q.productDetails?.supplierArticle ?? dash})`,
        `   Текст: ${q.text}`
    ];
    if (q.answer?.text) {
        const editable = q.answer.editable ? 'можно отредактировать один раз' : 'редактирование недоступно';
        lines.push(`   Наш ответ: ${q.answer.text} (${ts(q.answer.createDate)}, ${editable})`);
    } else {
        lines.push('   Наш ответ: отсутствует');
    }
    if (q.isWarned) lines.push('   ⚠ Вопрос помечен WB как проблемный');
    if (!q.wasViewed) lines.push('   Не просмотрен');
    return lines.join('\n');
}

export function formatChat(c: Chat, index?: number): string {
    const head = index === undefined ? '' : `${index}. `;
    const lines = [
        `${head}Чат ${c.chatID} ${dash} покупатель: ${c.clientName || 'без имени'}`
    ];
    if (c.goodCard?.nmID) {
        lines.push(`   Товар: nmId ${c.goodCard.nmID}, ${price(c.goodCard.price, c.goodCard.priceCurrency)}, размер ${c.goodCard.size || dash}`);
    }
    if (c.lastMessage) {
        lines.push(`   Последнее сообщение (${tsFromMillis(c.lastMessage.addTimestamp)}): ${c.lastMessage.text}`);
    }
    return lines.join('\n');
}

export function formatChatEvent(e: ChatEvent, index?: number): string {
    const head = index === undefined ? '' : `${index}. `;
    const who = e.sender === 'client' ? `покупатель ${e.clientName ?? ''}`.trim() : 'мы';
    const lines = [`${head}[${tsFromMillis(e.addTimestamp)}] чат ${e.chatID} ${dash} ${who}`];

    if (e.isNewChat) lines.push('   Это новый чат');
    if (e.message?.text) lines.push(`   ${e.message.text}`);

    const files = e.message?.attachments?.files ?? [];
    const images = e.message?.attachments?.images ?? [];
    for (const f of files) lines.push(`   Файл: ${f.name} (${f.contentType}, ${Math.round(f.size / 1024)} КБ, downloadID ${f.downloadID})`);
    for (const img of images) lines.push(`   Изображение: downloadID ${img.downloadID}`);

    const card = e.message?.attachments?.goodCard;
    if (card?.nmID) lines.push(`   Товар в обсуждении: nmId ${card.nmID}, ${price(card.price, card.priceCurrency)}`);

    return lines.join('\n');
}

export function joinBlocks(blocks: string[], emptyMessage: string): string {
    return blocks.length === 0 ? emptyMessage : blocks.join('\n\n');
}
