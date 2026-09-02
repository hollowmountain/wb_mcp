import { splitRemains } from '../wb/api.js';
import type { RegionLevel, RegionTotal } from '../wb/api.js';
import type {
    Chat,
    ChatEvent,
    Feedback,
    FbsOrder,
    Good,
    ProductCard,
    Question,
    RemainsRow,
    ReturnClaim
} from '../wb/api.js';

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

/**
 * Цены из discounts-prices-api приходят целыми числами. Судя по тому, что
 * clubDiscountedPrice в том же ответе дробное, это рубли, а не копейки —
 * поэтому здесь, в отличие от price(), на 100 не делим.
 */
function rub(value: number | undefined, currency: string | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return dash;
    // Ограничиваем два знака: WB иногда отдаёт цену с тремя после запятой,
    // и «690,833 RUB» выглядит как ошибка, хотя это просто округление скидки.
    const shown = value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    return `${shown} ${currency ?? ''}`.trim();
}

/**
 * В заявках на возврат валюта приходит числовым кодом ISO 4217 («643»),
 * а в ценах — буквенным («RUB»). Приводим к буквенному, чтобы в выводе
 * не появлялось «889 643», где 643 — это не разряды, а код валюты.
 */
const ISO_4217_NUMERIC: Record<string, string> = {
    '643': 'RUB',
    '840': 'USD',
    '978': 'EUR',
    '398': 'KZT',
    '933': 'BYN',
    '051': 'AMD',
    '417': 'KGS',
    '860': 'UZS',
    '972': 'TJS'
};

function currencyName(code: string | number | undefined): string | undefined {
    if (code === undefined || code === null || code === '') return undefined;
    const key = String(code);
    return ISO_4217_NUMERIC[key] ?? key;
}

function characteristic(c: { name: string; value: unknown }): string {
    const v = Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '');
    return `${c.name}: ${v}`;
}

export function formatProductCard(card: ProductCard, good: Good | null): string {
    const lines: string[] = [
        `${card.title || card.vendorCode} ${dash} ${card.brand || dash}`,
        `   nmID ${card.nmID}, артикул ${card.vendorCode}, предмет: ${card.subjectName || dash}`
    ];

    if (good) {
        const sizes = good.sizes ?? [];
        if (sizes.length === 1 && sizes[0]) {
            const s = sizes[0];
            lines.push(
                `   Цена: ${rub(s.discountedPrice, good.currencyIsoCode4217)} со скидкой ${good.discount}% (до скидки ${rub(s.price, good.currencyIsoCode4217)})`
            );
        } else if (sizes.length > 1) {
            lines.push(`   Цены по размерам:`);
            for (const s of sizes.slice(0, 12)) {
                lines.push(
                    `      ${s.techSizeName || s.sizeID}: ${rub(s.discountedPrice, good.currencyIsoCode4217)} (до скидки ${rub(s.price, good.currencyIsoCode4217)})`
                );
            }
        }
    }

    const sizes = card.sizes ?? [];
    if (sizes.length > 0) {
        // У товара без размерной сетки WB кладёт techSize «0» — это не размер,
        // а его отсутствие, и показывать «Размеры: 0» только путает.
        const names = sizes.map(s => s.techSize || s.wbSize).filter(n => n && n !== '0');
        lines.push(`   Размеры: ${names.length > 0 ? names.join(', ') : 'без размерной сетки'}`);
        const barcodes = sizes.flatMap(s => s.skus ?? []);
        if (barcodes.length > 0) lines.push(`   Штрихкоды: ${barcodes.slice(0, 6).join(', ')}${barcodes.length > 6 ? ' …' : ''}`);
    }

    const d = card.dimensions;
    // Подписываем оси: без подписи «8×17×6» читается как угодно.
    if (d) lines.push(`   Габариты: длина ${d.length} × ширина ${d.width} × высота ${d.height} см, вес брутто ${d.weightBrutto} кг`);

    const chars = card.characteristics ?? [];
    if (chars.length > 0) {
        lines.push(`   Характеристики (${chars.length}):`);
        for (const c of chars.slice(0, 25)) lines.push(`      ${characteristic(c)}`);
        if (chars.length > 25) lines.push(`      … ещё ${chars.length - 25}`);
    }

    if (card.description) {
        const desc = card.description.length > 600 ? card.description.slice(0, 600) + '…' : card.description;
        lines.push(`   Описание: ${desc}`);
    }
    if (card.photos?.length) lines.push(`   Фото: ${card.photos.length} шт.`);
    lines.push(`   Обновлена: ${ts(card.updatedAt)}`);
    return lines.join('\n');
}

export function formatReturnClaim(c: ReturnClaim, index?: number): string {
    const head = index === undefined ? '' : `${index}. `;
    const lines: string[] = [
        `${head}Заявка ${c.id} ${dash} ${ts(c.dt)}`,
        `   Товар: ${c.imt_name || dash} (nmID ${c.nm_id})`,
        `   Сумма: ${rub(c.price, currencyName(c.currency_code))} ${dash} заказ от ${ts(c.order_dt)}`,
        // Числовые коды WB не расшифровывает в открытой документации, поэтому
        // показываем как есть: врать про смысл статуса хуже, чем показать цифру.
        `   Статус: код ${c.status} (расширенный ${c.status_ex}), тип заявки ${c.claim_type}`
    ];
    if (c.user_comment) lines.push(`   Покупатель: ${c.user_comment}`);
    if (c.wb_comment) lines.push(`   Комментарий WB: ${c.wb_comment}`);
    if (c.actions?.length) lines.push(`   Доступные действия: ${c.actions.join(', ')}`);
    if (c.photos?.length) lines.push(`   Фото: ${c.photos.length} шт.`);
    if (c.delivery_dt) lines.push(`   Доставка: ${ts(c.delivery_dt)}`);
    lines.push(`   srid: ${c.srid}`);
    return lines.join('\n');
}

/**
 * Суммы в заказах приходят в копейках — в отличие от цен и возвратов, где рубли.
 * Проверено сверкой: заказ на 90200 при цене товара 1147 ₽ и заявке на возврат
 * того же товара на 889 ₽, то есть 902,00 ₽. Поэтому делим на 100.
 */
function kopecks(value: number | undefined, currency: string | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return dash;
    const shown = (value / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${shown} ${currency ?? ''}`.trim();
}

export function formatStockRow(r: RemainsRow, index?: number): string {
    const head = index === undefined ? '' : `${index}. `;
    const { onHand, toCustomers, returning, warehouses } = splitRemains(r);
    const size = r.techSize && r.techSize !== '0' ? `, размер ${r.techSize}` : '';

    const lines = [`${head}nmID ${r.nmId}${size} ${dash} на складах ${onHand} шт.`];
    if (r.vendorCode || r.subjectName) {
        lines.push(`   ${[r.subjectName, r.vendorCode].filter(Boolean).join(', ')}`);
    }
    // Товар в пути не лежит на складе и покупателю недоступен — показываем
    // отдельной строкой, а не в общем числе.
    const transit: string[] = [];
    if (toCustomers > 0) transit.push(`едет покупателям ${toCustomers}`);
    if (returning > 0) transit.push(`возвраты в пути ${returning}`);
    if (transit.length > 0) lines.push(`   В пути: ${transit.join(', ')}`);

    if (warehouses.length === 0) {
        lines.push('   Нет ни на одном складе');
    } else {
        for (const w of warehouses.slice(0, 15)) lines.push(`   ${w.warehouseName}: ${w.quantity}`);
        if (warehouses.length > 15) lines.push(`   … ещё складов: ${warehouses.length - 15}`);
    }
    return lines.join('\n');
}

export function formatFbsOrder(o: FbsOrder, index?: number): string {
    const head = index === undefined ? '' : `${index}. `;
    const lines = [
        `${head}Заказ ${o.id} ${dash} ${ts(o.createdAt)}`,
        `   Товар: nmID ${o.nmId}, артикул ${o.article || dash}`,
        `   Сумма: ${kopecks(o.price, currencyName(o.currencyCode))}`
    ];
    // Валюта заказа отличается от валюты продавца только у трансграничных заказов —
    // тогда пересчитанная сумма и есть та, что придёт продавцу.
    if (o.convertedCurrencyCode !== o.currencyCode) {
        lines.push(`   К зачислению: ${kopecks(o.convertedPrice, currencyName(o.convertedCurrencyCode))}`);
    }
    lines.push(`   Доставка: ${o.deliveryType || dash}${o.supplyId ? `, поставка ${o.supplyId}` : ''}`);
    if (o.skus?.length) lines.push(`   Штрихкод: ${o.skus.join(', ')}`);
    if (o.comment) lines.push(`   Комментарий: ${o.comment}`);
    lines.push(`   rid: ${o.rid}`);
    return lines.join('\n');
}

const REGION_LEVEL_TITLE: Record<RegionLevel, string> = {
    country: 'странам',
    district: 'федеральным округам',
    region: 'регионам',
    city: 'городам'
};

export function formatRegionSales(
    totals: RegionTotal[],
    level: RegionLevel,
    period: { from: string; to: string },
    limit: number
): string {
    if (totals.length === 0) return `Продаж за период ${period.from} — ${period.to} не найдено.`;

    const amount = totals.reduce((s, t) => s + t.amount, 0);
    const quantity = totals.reduce((s, t) => s + t.quantity, 0);
    const shown = totals.slice(0, limit);

    const lines = [
        `Продажи по ${REGION_LEVEL_TITLE[level]} за ${period.from} — ${period.to}`,
        `Всего: ${rub(amount, 'RUB')}, ${quantity} шт., точек ${totals.length}`,
        ''
    ];
    for (const [i, t] of shown.entries()) {
        lines.push(`${i + 1}. ${t.name} ${dash} ${rub(t.amount, 'RUB')} (${t.share.toFixed(1)}%), ${t.quantity} шт.`);
    }
    if (totals.length > shown.length) {
        const rest = totals.slice(limit);
        const restAmount = rest.reduce((s, t) => s + t.amount, 0);
        lines.push(`… остальные ${rest.length}: ${rub(restAmount, 'RUB')}`);
    }
    return lines.join('\n');
}
