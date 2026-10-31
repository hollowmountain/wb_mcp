import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { config } from '../../config.js';
import {
    getOzonAnalytics,
    getOzonBalance,
    getOzonRealization,
    getAllOzonPrices,
    getOzonChatHistory,
    getAllOzonStocks,
    getOzonWarehouseStocks,
    listFboPostings,
    listFbsPostings,
    listOzonChats,
    listOzonProducts,
    listOzonReturns,
    type OzonCabinet
} from '../../ozon/client.js';
import {
    FORM_LINES,
    RETURN,
    SALE,
    describeType,
    formLineOf,
    getAccrualTypes,
    getOzonAccruals,
    resolveSkus,
    type AccrualAggregate,
    type AccrualType,
    type FormLine
} from '../../ozon/accruals.js';
import { adSpendBySku, ctr, dailyStats, drr, hasPerf, listCampaigns, rollUpByCampaign } from '../../ozon/performance.js';
import { logger } from '../../logger.js';
import { CabinetError } from '../../wb/cabinets.js';
import { actorOf, explainError, guarded, text, type ToolResult } from './common.js';

const dash = '—';

/**
 * Кабинеты Ozon — отдельная область видимости от кабинетов Wildberries.
 * Юрлицо может быть одно, но людей за площадками сажают разных: менеджер
 * Ozon не должен видеть переписку Wildberries того же бренда. Поэтому у
 * Ozon свои слаги вида oz-harbez, и доступ выдаётся по ним отдельно.
 */
function allowedOzon(actor: Actor): OzonCabinet[] {
    const all = config.ozon;
    if (all.length === 0) return [];
    if (actor.cabinets === null) return all;
    const scope = new Set(actor.cabinets);
    return all.filter(c => scope.has(c.slug));
}

/**
 * Кабинет Ozon по тому, как его назвала модель.
 *
 * Модели путаются: пишут harbez вместо oz-harbez — так называется кабинет
 * Wildberries — или берут подпись из Nepsell, «PixelTapic». За неделю до
 * 30.09.2026 так ошиблись шесть раз, каждый раз лишний заход. Подбор идёт
 * только среди кабинетов, открытых человеку, поэтому доступа не расширяет.
 */
function matchOzon(allowed: OzonCabinet[], slug: string): OzonCabinet | undefined {
    const wanted = slug.trim().toLowerCase().replace(/^ozon[-_ ]?/, 'oz-');
    const base = wanted.startsWith('oz-') ? wanted : `oz-${wanted}`;
    for (const candidate of [wanted, base, base.replace(/pixeltapic$/, 'pixeltap')]) {
        const hit = allowed.find(c => c.slug === candidate);
        if (hit) return hit;
    }
    return undefined;
}

function resolve(actor: Actor, slug?: string): OzonCabinet[] {
    const allowed = allowedOzon(actor);
    if (allowed.length === 0) {
        throw new CabinetError('Кабинеты Ozon вам не открыты. Обратитесь к администратору.');
    }
    if (!slug) return allowed;
    const one = matchOzon(allowed, slug);
    if (!one) {
        throw new CabinetError(`Кабинет «${slug}» вам не доступен. Доступны: ${allowed.map(c => c.slug).join(', ')}`);
    }
    return [one];
}


const heading = (cabinet: OzonCabinet, total: number): string =>
    total === 1 ? '' : `━━ ${cabinet.slug} ━━\n`;

async function overCabinets(
    actor: Actor,
    slug: string | undefined,
    run: (cabinet: OzonCabinet) => Promise<string>
): Promise<ToolResult> {
    const cabinets = resolve(actor, slug);
    let failed = 0;
    const blocks = await Promise.all(
        cabinets.map(async c => {
            try {
                return heading(c, cabinets.length) + (await run(c));
            } catch (e) {
                failed++;
                logger.warn({ cabinet: c.slug, err: e instanceof Error ? e.message.slice(0, 300) : String(e) }, 'cabinet failed');
                return `${heading(c, cabinets.length)}Ошибка: ${explainError(e)}`;
            }
        })
    );
    return finish(blocks, failed === cabinets.length);
}

/**
 * Если упали все кабинеты, вызов целиком — сбой. Раньше он писался в журнал
 * как удачный: 05.10.2026 ozon_finance получил от Ozon «404 page not found»,
 * а в журнале стояло ok, и поломку было не найти.
 */
function finish(blocks: string[], allFailed: boolean): ToolResult {
    const result = text(blocks.join('\n\n'));
    return allFailed ? { ...result, isError: true, sourceFailed: true } : result;
}

const rub = (v: string | undefined, cur?: string): string =>
    v === undefined || v === '' ? dash : `${Number(v).toLocaleString('ru-RU')} ${cur ?? '₽'}`.trim();

const day = (v: string | undefined): string => (v ? v.slice(0, 10) : dash);

const money = (n: number): string =>
    `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} \u20bd`;

/** \u0414\u043e\u043b\u044f, \u043a\u043e\u0442\u043e\u0440\u043e\u0439 \u043c\u043e\u0436\u0435\u0442 \u043d\u0435 \u0431\u044b\u0442\u044c: \u0431\u0435\u0437 \u043f\u043e\u043a\u0430\u0437\u043e\u0432 CTR \u043d\u0435 \u043d\u043e\u043b\u044c, \u0430 \u00ab\u043d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u043e\u00bb. */
const pctOrDash = (v: number | null): string => (v === null ? dash : `${v}%`);

const dateArg = (what: string) =>
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в виде 2026-09-01').describe(what);

/**
 * Как overCabinets, но кабинеты опрашиваются по очереди. Нужно там, где Ozon
 * особенно скуп на частоту: у аналитики третий запрос подряд уже ловит 429,
 * а три кабинета разом — это ровно три запроса.
 */
async function overCabinetsInTurn(
    actor: Actor,
    slug: string | undefined,
    run: (cabinet: OzonCabinet) => Promise<string>
): Promise<ToolResult> {
    const cabinets = resolve(actor, slug);
    const blocks: string[] = [];
    let failed = 0;
    for (const c of cabinets) {
        try {
            blocks.push(heading(c, cabinets.length) + (await run(c)));
        } catch (e) {
            failed++;
            logger.warn({ cabinet: c.slug, err: e instanceof Error ? e.message.slice(0, 300) : String(e) }, 'cabinet failed');
            blocks.push(`${heading(c, cabinets.length)}Ошибка: ${explainError(e)}`);
        }
    }
    return finish(blocks, failed === cabinets.length);
}

/** Как Ozon называет услуги в балансе — и как это сказать по-русски. */
const SERVICE_NAMES: Record<string, string> = {
    pay_per_click: 'реклама: оплата за клик',
    promotion_with_cost_per_order: 'реклама: оплата за заказ',
    logistics: 'логистика',
    reverse_logistics: 'обратная логистика',
    courier_client_reinvoice: 'курьерская доставка покупателю',
    delivery_to_handover_place_by_ozon: 'доставка до места передачи',
    cross_docking: 'кросс-докинг',
    acquiring: 'эквайринг',
    product_placement_in_ozon_warehouses: 'размещение на складах Ozon',
    stock_insurance: 'страхование остатков',
    goods_transfer_between_ozon_warehouses: 'перемещение между складами',
    temporary_placement_agent: 'временное размещение',
    booking_space_and_staff_for_partial_shipment: 'бронирование места под поставку',
    decompensation_and_return_to_warehouse: 'декомпенсация и возврат на склад',
    partner_returns_cancellations_processing: 'обработка возвратов и отмен',
    drop_off_processing_by_partners: 'приём отгрузок в пунктах',
    ozon_warehouse_pickup: 'вывоз со склада Ozon',
    ozon_warehouse_pickup_assortment: 'вывоз со склада Ozon (ассортимент)',
    item_packing: 'упаковка',
    packing_by_agents: 'упаковка агентами',
    packing_package: 'упаковочный материал',
    product_disposal: 'утилизация',
    defect_fine_shipment_delay_rated: 'штраф за просрочку отгрузки',
    premium_subscription: 'подписка Premium',
    analytics_premium: 'Premium-аналитика',
    offsets: 'взаимозачёты',
    ozon_tech_offsets: 'взаимозачёты Ozon Технологии'
};

// ─── Начисления: отчёт ───────────────────────────────────────────────────────

/** Рубли из копеек, всегда два знака: «−633 448,88». */
const rubK = (k: number): string =>
    (k / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace('-', '−');

const pcs = (n: number): string => n.toLocaleString('ru-RU');

/** Потолок ответа. Кириллица в UTF-8 — два байта на букву, поэтому меряем байты, а не символы. */
const MAX_BYTES = 30_000;

/**
 * Страница строк таблицы в пределах offset/limit и потолка по размеру.
 * Если потолок наступил раньше limit, говорим, с какого offset продолжать.
 * Потолок делится между кабинетами: без cabinet ответ идёт по трём сразу.
 */
function pageRows(head: string, rows: string[], offset: number, limit: number, tail: string, maxBytes = MAX_BYTES): string {
    if (rows.length > 0 && offset >= rows.length) {
        return [head, `Строк после offset=${offset} нет: всего ${rows.length}.`, ...(tail ? ['', tail] : [])].join('\n');
    }
    const slice = rows.slice(offset, offset + limit);
    let used = Buffer.byteLength(head) + Buffer.byteLength(tail) + 300;
    const shown: string[] = [];
    for (const r of slice) {
        const b = Buffer.byteLength(r) + 1;
        if (used + b > maxBytes) break;
        used += b;
        shown.push(r);
    }
    const end = offset + shown.length;
    const more = end < rows.length;
    const nav =
        rows.length === 0
            ? 'Строк нет.'
            : shown.length === 0
              ? `Таблица (${rows.length} строк) не помещается в ответ — укажите cabinet или уменьшите limit.`
            : `Строки ${offset + 1}–${end} из ${rows.length}.` + (more ? ` Следующие: offset=${end}.` : '');
    return [head, ...shown, nav, ...(tail ? ['', tail] : [])].join('\n');
}

/** Сводка по статьям «3 Формы» — первым блоком в любом разрезе. */
function formsBlock(agg: AccrualAggregate): string[] {
    const by = new Map<FormLine, number>();
    let sold = 0;
    let returned = 0;
    for (const c of agg.cells) {
        const line = formLineOf(c.key);
        by.set(line, (by.get(line) ?? 0) + c.kop);
        if (c.key === SALE) sold += c.qty;
        if (c.key === RETURN) returned += c.qty;
    }
    const s = agg.salesSplit;
    const out = ['Статьи «3 Формы» (раскладка финансиста, см. описание инструмента):'];
    for (const line of FORM_LINES) {
        const v = by.get(line) ?? 0;
        if (v === 0 && line === 'Компенсации') continue;
        let extra = '';
        if (line === 'Выручка') extra = ` · ${pcs(sold - returned)} шт (продано ${pcs(sold)}, возвраты и отмены ${pcs(returned)})`;
        if (line === 'Компенсации') extra = ' · доход, в «прочие расходы» не входит';
        out.push(`  ${line.padEnd(15, '.')} ${rubK(v)} ₽${extra}`);
        if (line === 'Выручка') {
            out.push(
                `     из неё заплатили покупатели ${rubK(s.buyerKop)} · баллы Ozon за скидки ${rubK(s.pointsKop)} · партнёрские программы ${rubK(s.partnersKop)}`
            );
        }
    }
    out.push(`  ${'Итого'.padEnd(15, '.')} ${rubK(agg.totalKop)} ₽`);
    return out;
}

/** Порядок видов: продажи, возвраты, вознаграждение, дальше по сумме от крупных удержаний. */
function typeTotals(agg: AccrualAggregate): Array<{ key: string; kop: number; qty: number; rows: number; noSkuKop: number }> {
    const by = new Map<string, { key: string; kop: number; qty: number; rows: number; noSkuKop: number }>();
    for (const c of agg.cells) {
        const t = by.get(c.key) ?? { key: c.key, kop: 0, qty: 0, rows: 0, noSkuKop: 0 };
        t.kop += c.kop;
        t.qty += c.qty;
        t.rows += c.rows;
        if (c.sku === 0) t.noSkuKop += c.kop;
        by.set(c.key, t);
    }
    const head = [SALE, RETURN, '69'];
    return [...by.values()].sort((a, b) => {
        const ia = head.indexOf(a.key);
        const ib = head.indexOf(b.key);
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        return a.kop - b.kop;
    });
}

const typeLabel = (key: string, types: Map<number, AccrualType>): string => {
    const t = describeType(key, types);
    return `${t.name} [${t.code}]`;
};

function accrualsTypeRows(agg: AccrualAggregate, types: Map<number, AccrualType>): string[] {
    return typeTotals(agg).map(t => {
        const noSku = t.noSkuKop === 0 ? '' : t.noSkuKop === t.kop ? ' · без SKU' : ` · из них без SKU ${rubK(t.noSkuKop)}`;
        const qty = t.qty !== 0 ? ` · ${pcs(t.qty)} шт` : '';
        return `${formLineOf(t.key)} | ${typeLabel(t.key, types)} | ${rubK(t.kop)}${qty} · строк ${pcs(t.rows)}${noSku}`;
    });
}

/** Колонки разреза по SKU — те же статьи, что у финансиста. */
const SKU_COLUMNS: FormLine[] = ['Выручка', 'Комиссия', 'Эквайринг', 'Логистика'];

function accrualsSkuRows(agg: AccrualAggregate): string[] {
    const by = new Map<number, { cols: Map<FormLine, number>; other: number; total: number; net: number }>();
    for (const c of agg.cells) {
        if (c.sku === 0) continue;
        const s = by.get(c.sku) ?? { cols: new Map(), other: 0, total: 0, net: 0 };
        const line = formLineOf(c.key);
        if (SKU_COLUMNS.includes(line)) s.cols.set(line, (s.cols.get(line) ?? 0) + c.kop);
        else s.other += c.kop;
        s.total += c.kop;
        if (c.key === SALE) s.net += c.qty;
        if (c.key === RETURN) s.net -= c.qty;
        by.set(c.sku, s);
    }
    return [...by.entries()]
        .sort((a, b) => (b[1].cols.get('Выручка') ?? 0) - (a[1].cols.get('Выручка') ?? 0) || a[1].total - b[1].total)
        .map(([sku, s]) => {
            const info = agg.skus[String(sku)];
            const cols = SKU_COLUMNS.map(l => rubK(s.cols.get(l) ?? 0)).join(' | ');
            return `${info?.offerId || '?'} | ${sku} | ${pcs(s.net)} | ${cols} | ${rubK(s.other)} | ${rubK(s.total)}`;
        });
}

function accrualsTypeSkuRows(agg: AccrualAggregate, types: Map<number, AccrualType>): string[] {
    const order = new Map(typeTotals(agg).map((t, i) => [t.key, i]));
    return [...agg.cells]
        .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0) || Math.abs(b.kop) - Math.abs(a.kop))
        .map(c => {
            const t = describeType(c.key, types);
            const who = c.sku === 0 ? 'без SKU' : `${agg.skus[String(c.sku)]?.offerId || '?'} | ${c.sku}`;
            return `${t.code} | ${who} | ${rubK(c.kop)}${c.qty !== 0 ? ` | ${pcs(c.qty)} шт` : ''}`;
        });
}

/** Что без SKU — одной строкой по видам: реклама, хранение, обработка поставок. */
function noSkuLine(agg: AccrualAggregate, types: Map<number, AccrualType>): string {
    const parts = typeTotals(agg)
        .filter(t => t.noSkuKop !== 0)
        .map(t => `${describeType(t.key, types).name} ${rubK(t.noSkuKop)}`);
    const sum = agg.cells.filter(c => c.sku === 0).reduce((s, c) => s + c.kop, 0);
    return parts.length === 0 ? 'Начислений без SKU нет.' : `Без SKU (Ozon не раскладывает по товарам): ${rubK(sum)} ₽ — ${parts.join(' · ')}`;
}

// ─── Реклама по товарам ──────────────────────────────────────────────────────

/** Рубли со знаком минус: расход в разрезе SKU пишем как в начислениях. */
const spendK = (rub: number): string => rubK(-Math.round(rub * 100));

async function adsBySkuReport(cab: OzonCabinet, from: string, to: string, offset: number, limit: number, maxBytes: number): Promise<string> {
    const s = await adSpendBySku(cab, from, to);
    // Артикулы — из Seller API того же кабинета; без них SKU всё равно показана.
    const skus = await resolveSkus(cab, s.lines.map(l => Number(l.sku))).catch((): AccrualAggregate['skus'] => ({}));
    const click = s.lines.reduce((a, l) => a + l.click, 0);
    const order = s.lines.reduce((a, l) => a + l.order, 0);
    const loose = s.unallocated.reduce((a, u) => a + u.spent, 0);
    const head = [
        `━━ ${cab.slug} · ${from} — ${to} · расход по SKU ━━`,
        `Источник: отчёты рекламного кабинета Ozon (Performance API) — ` +
            (s.cachedAt ? `из кэша от ${new Date(s.cachedAt * 1000).toISOString().slice(0, 10)}` : `отчётов-заданий ${s.reports}`) +
            `, товаров ${s.lines.length}`,
        `Расход кампаний по дневной статистике: ${spendK(s.campaignSpent)} ₽`,
        `Разложено по SKU: ${spendK(click + order)} ₽ (оплата за клик ${spendK(click)} · оплата за заказ ${spendK(order)}) · не разложено: ${spendK(loose)} ₽`,
        'Знаки: расход с минусом, как в начислениях ozon_accruals. Суммы в ₽.',
        '',
        'артикул | SKU | оплата за клик | оплата за заказ | итого, ₽ | клики | заказы'
    ].join('\n');
    const rows = s.lines.map(
        l =>
            `${skus[l.sku]?.offerId || '?'} | ${l.sku} | ${spendK(l.click)} | ${spendK(l.order)} | ` +
            `${spendK(l.click + l.order)} | ${pcs(l.clicks)} | ${pcs(l.orders)}`
    );
    const tail = s.unallocated.length
        ? 'Не разложено по товарам:\n' + s.unallocated.map(u => `  ${u.title}: ${spendK(u.spent)} ₽ — ${u.reason}`).join('\n')
        : 'Весь расход разложен по товарам.';
    return pageRows(head, rows, offset, limit, tail, maxBytes);
}

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthLabel = (y: number, m: number): string => `${MONTHS[m - 1]} ${y}`;
const shiftMonth = (y: number, m: number, by: number): { year: number; month: number } => {
    const idx = y * 12 + (m - 1) + by;
    return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
};

export function registerOzonTools(server: McpServer, actor: Actor): void {
    if (allowedOzon(actor).length === 0) return;

    // Слаги называем прямо: без этого модель пишет harbez — имя кабинета
    // Wildberries — и получает отказ. Перечислены только кабинеты этого человека.
    const cabinetArg = z
        .string()
        .optional()
        .describe(`Кабинет Ozon, слаг с приставкой oz-: ${allowedOzon(actor).map(c => c.slug).join(', ')}. Не указан — по всем доступным.`);

    server.registerTool(
        'ozon_cabinets',
        {
            title: 'Ozon: кабинеты',
            description:
                'Какие кабинеты Ozon вам открыты. Кабинеты Ozon и Wildberries не связаны между собой, даже когда называются похоже: это разные площадки и разные люди.',
            inputSchema: {},
            annotations: { readOnlyHint: true }
        },
        guarded('ozon_cabinets', async (_args, extra) => {
            const list = allowedOzon(actorOf(extra));
            return text(
                list.length === 0
                    ? 'Кабинеты Ozon вам не открыты.'
                    : `Доступные кабинеты Ozon:\n${list.map(c => `   ${c.slug}`).join('\n')}\n\nОтзывы и вопросы через Ozon недоступны: они требуют подписки Premium Plus, а у кабинетов подключён Premium.`
            );
        })
    );

    server.registerTool(
        'ozon_products',
        {
            title: 'Ozon: товары с остатками и ценами',
            description:
                'Товары кабинета Ozon: артикул продавца, остатки по схемам FBO и FBS, текущая и старая цена. Можно сузить поиском по артикулу.',
            inputSchema: {
                cabinet: cabinetArg,
                search: z.string().optional().describe('Часть артикула продавца'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_products', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const want = args.limit ?? 20;
                const [stocks, prices] = await Promise.all([
                    getAllOzonStocks(cabinet),
                    getAllOzonPrices(cabinet)
                ]);

                const priceBy = new Map(prices.map(p => [p.offer_id, p]));
                let rows = stocks;
                const s = args.search?.trim().toLowerCase();
                if (s) rows = rows.filter(r => r.offer_id.toLowerCase().includes(s));
                if (rows.length === 0) return s ? `По артикулу «${args.search}» ничего не найдено.` : 'Товаров нет.';

                const lines = rows.slice(0, want).map((r, i) => {
                    const p = priceBy.get(r.offer_id)?.price;
                    const byType = (r.stocks ?? [])
                        .filter(x => (x.present ?? 0) > 0 || (x.reserved ?? 0) > 0)
                        .map(x => `${x.type ?? '?'}: ${x.present ?? 0}${x.reserved ? ` (в резерве ${x.reserved})` : ''}`);
                    const total = (r.stocks ?? []).reduce((sum, x) => sum + (x.present ?? 0), 0);
                    return [
                        `${i + 1}. ${r.offer_id}`,
                        // Здесь present — всё, что физически лежит на складе,
                        // вместе с резервом. В ozon_stocks показывается
                        // free_to_sell, то есть без резерва: числа законно
                        // разные, и без подписи их принимают за расхождение.
                        `   На складе с резервом: ${total} шт.${byType.length ? ` — ${byType.join(', ')}` : ''}`,
                        `   Цена в кабинете: ${rub(p?.price, p?.currency_code)}${p?.old_price && p.old_price !== '0' ? ` (зачёркнутая ${rub(p.old_price, p.currency_code)})` : ''}`
                    ].join('\n');
                });
                const tail = rows.length > want ? `\n\n… ещё товаров: ${rows.length - want}` : '';
                // Без этой строки модель принимает цену продавца за цену на сайте.
                // Ozon докрывает своими скидками больше половины цены, так что
                // разница огромная — 05.10.2026 на этом РОП строила контроль цен.
                const hint =
                    '\n\nЭто цена продавца. Покупатель платит меньше: Ozon даёт скидки за свой счёт. ' +
                    'Сколько покупатели платили на деле — ozon_buyer_prices.';
                return `Товаров: ${rows.length}\n\n${lines.join('\n')}${tail}${hint}`;
            })
        )
    );

    server.registerTool(
        'ozon_orders',
        {
            title: 'Ozon: заказы',
            description:
                'Заказы Ozon за период: со складов Ozon (FBO) и со склада продавца (FBS). Номер отправления, статус, состав, дата.',
            inputSchema: {
                cabinet: cabinetArg,
                dateFrom: z.string().describe('Начало периода, ISO-дата: 2026-08-01'),
                dateTo: z.string().describe('Конец периода, ISO-дата: 2026-09-01'),
                scheme: z.enum(['fbo', 'fbs']).optional().describe('Схема. Не указана — обе.'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_orders', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const since = `${args.dateFrom.slice(0, 10)}T00:00:00.000Z`;
                const to = `${args.dateTo.slice(0, 10)}T23:59:59.000Z`;
                const want = args.limit ?? 20;
                const blocks: string[] = [];

                if (args.scheme !== 'fbs') {
                    // Просим на один больше: иначе не отличить «столько и есть»
                    // от «столько поместилось».
                    const fboAll = (await listFboPostings(cabinet, since, to, want + 1)).result ?? [];
                    const fboMore = fboAll.length > want;
                    const fbo = fboMore ? fboAll.slice(0, want) : fboAll;
                    blocks.push(
                        fbo.length === 0
                            ? 'FBO (склады Ozon): заказов нет'
                            : `FBO (склады Ozon): ${fbo.length}${fboMore ? ' — показаны не все, за период их больше' : ''}\n${fmt(fbo)}`
                    );
                }
                if (args.scheme !== 'fbo') {
                    const fbsRes = (await listFbsPostings(cabinet, since, to, want + 1)).result;
                    const fbsAll = fbsRes?.postings ?? [];
                    // У FBS площадка вдобавок сама говорит, есть ли продолжение.
                    const fbsMore = fbsAll.length > want || fbsRes?.has_next === true;
                    const fbs = fbsAll.length > want ? fbsAll.slice(0, want) : fbsAll;
                    blocks.push(
                        fbs.length === 0
                            ? 'FBS (склад продавца): заказов нет'
                            : `FBS (склад продавца): ${fbs.length}${fbsMore ? ' — показаны не все, за период их больше' : ''}\n${fmt(fbs)}`
                    );
                }
                return blocks.join('\n\n');

                function fmt(list: Awaited<ReturnType<typeof listFboPostings>>['result']): string {
                    return list
                        .map((o, i) => {
                            const items = (o.products ?? [])
                                .map(p => `${p.name ?? p.offer_id ?? '?'}${p.quantity && p.quantity > 1 ? ` ×${p.quantity}` : ''}`)
                                .join('; ');
                            return `  ${i + 1}. ${o.posting_number} от ${day(o.created_at)} ${dash} ${o.status}${o.substatus ? ` / ${o.substatus}` : ''}\n     ${items || dash}`;
                        })
                        .join('\n');
                }
            })
        )
    );

    server.registerTool(
        'ozon_returns',
        {
            title: 'Ozon: возвраты',
            description: 'Возвраты товаров на Ozon: что вернули, по какой причине, в каком состоянии заявка и где находится товар.',
            inputSchema: {
                cabinet: cabinetArg,
                limit: z.number().int().min(1).max(200).optional().describe('Сколько показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_returns', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const page = await listOzonReturns(cabinet, args.limit ?? 20);
                if (page.returns.length === 0) return 'Возвратов нет.';
                const lines = page.returns.map((r, i) => {
                    const p = r.product;
                    return [
                        `${i + 1}. Возврат ${r.id} ${dash} ${r.visual?.status?.display_name ?? r.type ?? dash}`,
                        `   Товар: ${p?.name ?? dash}${p?.offer_id ? ` (${p.offer_id})` : ''}`,
                        `   Причина: ${r.return_reason_name ?? dash}`,
                        `   Заказ: ${r.order_number ?? dash}, отправление ${r.posting_number ?? dash}`,
                        p?.price?.price ? `   Сумма: ${rub(p.price.price, p.price.currency_code)}` : '',
                        r.place?.name ? `   Где товар: ${r.place.name}` : ''
                    ]
                        .filter(Boolean)
                        .join('\n');
                });
                return `Возвратов: ${page.returns.length}${page.has_next ? ' (есть ещё)' : ''}\n\n${lines.join('\n')}`;
            })
        )
    );

    server.registerTool(
        'ozon_chats',
        {
            title: 'Ozon: чаты с покупателями',
            description:
                'Список чатов Ozon: сколько непрочитанных, когда создан. ТОЛЬКО ЧТЕНИЕ — отправка сообщений в Ozon требует подписки Premium Plus и через коннектор недоступна.',
            inputSchema: {
                cabinet: cabinetArg,
                limit: z.number().int().min(1).max(200).optional().describe('Сколько показать, по умолчанию 30')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_chats', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const res = await listOzonChats(cabinet, args.limit ?? 30);
                const chats = res.chats ?? [];
                if (chats.length === 0) return 'Чатов нет.';
                const unread = chats.filter(c => (c.unread_count ?? 0) > 0);
                const lines = chats
                    .slice(0, args.limit ?? 30)
                    .map((c, i) => {
                        const id = c.chat?.chat_id ?? dash;
                        const n = c.unread_count ?? 0;
                        return `${i + 1}. ${id} ${dash} непрочитанных ${n}${c.chat?.chat_status ? `, ${c.chat.chat_status}` : ''}${c.chat?.created_at ? `, создан ${day(c.chat.created_at)}` : ''}`;
                    })
                    .join('\n');
                return `Чатов: ${chats.length}, с непрочитанными: ${unread.length}\n\n${lines}`;
            })
        )
    );

    server.registerTool(
        'ozon_analytics',
        {
            title: 'Ozon: продажи по товарам и дням',
            description:
                'Выручка и заказанные штуки за период — по товарам или по дням. ' +
                'Других показателей у Ozon больше нет: воронку (показы, корзины, конверсию) площадка убрала из API.',
            inputSchema: {
                cabinet: cabinetArg,
                dateFrom: dateArg('Начало периода: 2026-08-01'),
                dateTo: dateArg('Конец периода: 2026-09-01'),
                groupBy: z.enum(['товар', 'день']).optional().describe('Разрез. По умолчанию по товарам.'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько строк, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_analytics', async (args, extra) => {
            const byDay = args.groupBy === 'день';
            return overCabinetsInTurn(actorOf(extra), args.cabinet, async cabinet => {
                const a = await getOzonAnalytics(cabinet, {
                    dateFrom: args.dateFrom,
                    dateTo: args.dateTo,
                    dimension: byDay ? 'day' : 'sku',
                    limit: args.limit ?? 20
                });
                if (a.rows.length === 0) return 'За этот период данных нет.';
                const lines = a.rows.map(r => {
                    const label = byDay ? r.name || r.id : `${r.name.slice(0, 60)} (SKU ${r.id})`;
                    return `${label}\n   ${money(r.revenue)} · ${r.orderedUnits.toLocaleString('ru-RU')} шт`;
                });
                return (
                    `${args.dateFrom} — ${args.dateTo}\n` +
                    `Итого: ${money(a.totalRevenue)} · ${a.totalUnits.toLocaleString('ru-RU')} шт\n\n` +
                    lines.join('\n')
                );
            });
        })
    );

    server.registerTool(
        'ozon_stocks',
        {
            title: 'Ozon: остатки по складам',
            description:
                'Сколько товара лежит на каждом складе Ozon: свободно к продаже, в резерве, ожидается поставкой. ' +
                'Можно сузить поиском по артикулу или названию.',
            inputSchema: {
                cabinet: cabinetArg,
                search: z.string().optional().describe('Часть артикула продавца или названия'),
                limit: z.number().int().min(1).max(100).optional().describe('Сколько товаров показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_stocks', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const rows = await getOzonWarehouseStocks(cabinet);
                const needle = args.search?.trim().toLowerCase();
                const wanted = needle
                    ? rows.filter(r => r.offerId.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle))
                    : rows;
                if (wanted.length === 0) return needle ? `По запросу «${args.search}» ничего нет.` : 'Остатков нет.';

                // Строки приходят парами «товар × склад»; сводных строк здесь нет,
                // поэтому суммирование по товару честное.
                const byProduct = new Map<string, { name: string; free: number; reserved: number; promised: number; places: string[] }>();
                for (const r of wanted) {
                    const key = r.offerId || String(r.sku);
                    const acc = byProduct.get(key) ?? { name: r.name, free: 0, reserved: 0, promised: 0, places: [] };
                    acc.free += r.free;
                    acc.reserved += r.reserved;
                    acc.promised += r.promised;
                    if (r.free > 0 || r.reserved > 0) acc.places.push(`${r.warehouseName}: ${r.free}`);
                    byProduct.set(key, acc);
                }
                const list = [...byProduct.entries()]
                    .sort((a, b) => b[1].free - a[1].free)
                    .slice(0, args.limit ?? 20);
                const totalFree = [...byProduct.values()].reduce((s, p) => s + p.free, 0);

                return (
                    `Товаров: ${byProduct.size}, свободно к продаже всего: ${totalFree.toLocaleString('ru-RU')} шт ` +
                    `(без резерва; в ozon_products тот же остаток показан вместе с резервом)\n\n` +
                    list
                        .map(([code, p]) => {
                            const head = `${p.name.slice(0, 60)} (${code})`;
                            const nums = `   свободно ${p.free} · резерв ${p.reserved} · едет ${p.promised}`;
                            // Складов бывает два десятка; показываем шесть крупнейших,
                            // но обязательно говорим, сколько осталось за кадром —
                            // иначе перечисленные числа не сходятся с итогом по товару.
                            const top = [...p.places].sort((x, y) => Number(y.split(': ')[1]) - Number(x.split(': ')[1]));
                            const hidden = top.length - 6;
                            const where =
                                top.length > 0
                                    ? `\n   склады: ${top.slice(0, 6).join(', ')}` +
                                      (hidden > 0 ? ` и ещё ${hidden}` : '')
                                    : '';
                            return `${head}\n${nums}${where}`;
                        })
                        .join('\n')
                );
            })
        )
    );

    server.registerTool(
        'ozon_finance',
        {
            title: 'Ozon: расчёты с площадкой',
            description:
                'Расчёты с Ozon за период: продажи — с разбивкой, сколько заплатили покупатели и сколько ' +
                'докрыл Ozon своими скидками, — вознаграждение Ozon, возвраты, услуги по видам, начислено ' +
                'и выплачено, остаток на начало и конец. Период длиннее месяца собирается по частям.',
            inputSchema: {
                cabinet: cabinetArg,
                dateFrom: dateArg('Начало периода: 2026-08-01'),
                dateTo: dateArg('Конец периода: 2026-09-01')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_finance', async (args, extra) =>
            overCabinetsInTurn(actorOf(extra), args.cabinet, async cabinet => {
                const b = await getOzonBalance(cabinet, { from: args.dateFrom, to: args.dateTo });
                const line = (label: string, v: number): string => `${label.padEnd(34, '.')} ${money(v)}`;
                const servicesTotal = b.services.reduce((s, x) => s + x.amount, 0);
                // Услуги отсортированы от самых крупных удержаний; хвост сворачиваем.
                const top = b.services.filter(x => Math.round(x.amount) !== 0).slice(0, 8);
                const rest = b.services.length - top.length;
                const restSum = servicesTotal - top.reduce((s, x) => s + x.amount, 0);
                const paidShare = b.sales.amount > 0 ? Math.round((b.sales.revenue / b.sales.amount) * 100) : 0;
                return [
                    `${b.from} — ${b.to}`,
                    '',
                    line('Продажи по цене продавца', b.sales.amount),
                    line('   из них заплатили покупатели', b.sales.revenue),
                    line('   докрыл Ozon баллами за скидки', b.sales.points),
                    ...(Math.round(b.sales.partners) !== 0 ? [line('   партнёрские программы', b.sales.partners)] : []),
                    line('Вознаграждение Ozon', b.sales.fee),
                    line('Возвраты', b.returns.amount),
                    ...(Math.round(b.returns.fee) !== 0 ? [line('   вернулось вознаграждения', b.returns.fee)] : []),
                    line('Услуги и удержания', servicesTotal),
                    ...top.map(x => line(`   ${SERVICE_NAMES[x.name] ?? x.name}`, x.amount)),
                    ...(rest > 0 ? [line(`   прочие (${rest})`, restSum)] : []),
                    '',
                    line('Начислено за период', b.accrued),
                    line('Выплачено', b.paid),
                    `Остаток: на начало ${money(b.openingBalance)}, на конец ${money(b.closingBalance)}`,
                    '',
                    `Покупатели заплатили ${paidShare}% от цены продавца, остальное Ozon докрыл баллами за свои скидки.`
                ].join('\n');
            })
        )
    );

    server.registerTool(
        'ozon_accruals',
        {
            title: 'Ozon: начисления по видам и товарам',
            description:
                'Начисления Ozon детально — для отчёта «3 Формы» и разбора удержаний: сумма ₽ и штуки по КАЖДОМУ ' +
                'виду начисления и услуги, без свёртки в «прочие». Названия и коды видов — из справочника Ozon ' +
                '(/v1/finance/accrual/types, например «Логистика [Logistic]»); источник — /v1/finance/accrual/by-day, ' +
                'который заменил снятый Ozon /v3/finance/transaction/list. Сумма всех видов сверяется с ' +
                '/v1/finance/balance.\n' +
                'Знаки: поступления (продажи, возмещения) с плюсом, удержания и расходы с минусом. Выручка — ' +
                'продажи по цене продавца минус возвраты и отмены; штуки — продано минус возвращено.\n' +
                'Разрезы groupBy: type — по видам (по умолчанию); sku — по товарам: артикул продавца, SKU, штуки, ' +
                'выручка, комиссия, эквайринг, логистика, прочее, итого; type_sku — вид × товар. Начисления без ' +
                'товара (реклама, хранение, обработка поставок — Ozon их по SKU не раскладывает) идут отдельно, ' +
                'с пометкой «без SKU». Расход рекламы по SKU даёт ozon_ads с groupBy=sku.\n' +
                'Вверху всегда сводка по статьям «3 Формы» в раскладке финансиста (сверена с его файлом за август ' +
                '2026): Логистика = Логистика + Доставка до места выдачи + Обратная логистика + Обработка возвратов, ' +
                'отмен и невыкупов партнёрами; Хранение = Размещение товаров на складах Ozon; Реклама = Оплата за ' +
                'клик + Продвижение товара (оплата за заказ); Компенсации (возмещения Ozon за потерю и порчу) — ' +
                'доход, в расходы не входят; Прочие расходы — все остальные виды.\n' +
                'Даты: любой период до 12 месяцев, склеивается из окон по календарным месяцам; Ozon отдаёт ' +
                'начисления по дням. Закрытый месяц (прошло 10 дней после конца) берётся из кэша сервера, первый ' +
                'раз качается до минуты. Длинные таблицы — страницами: offset и limit (до 500).',
            inputSchema: {
                cabinet: cabinetArg,
                dateFrom: dateArg('Начало периода: 2026-08-01'),
                dateTo: dateArg('Конец периода включительно: 2026-08-31'),
                groupBy: z
                    .enum(['type', 'sku', 'type_sku'])
                    .optional()
                    .describe('Разрез: type — по видам начислений (по умолчанию), sku — по товарам, type_sku — вид × товар'),
                offset: z.number().int().min(0).optional().describe('С какой строки таблицы показывать, по умолчанию 0'),
                limit: z.number().int().min(1).max(500).optional().describe('Сколько строк таблицы, по умолчанию 200, не больше 500'),
                refresh: z
                    .boolean()
                    .optional()
                    .describe('Скачать заново мимо кэша закрытых месяцев. Нужно редко: если Ozon задним числом дописал начисления.')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_accruals', async (args, extra) => {
            const todayMsk = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
            const from = args.dateFrom;
            const to = args.dateTo > todayMsk ? todayMsk : args.dateTo;
            if (from > to) return text(`Начало периода ${from} позже конца ${to}.`);
            const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
            if (days > 366) return text('Период длиннее 12 месяцев. Возьмите год или меньше: отчёт «3 Формы» — помесячный.');
            const groupBy = args.groupBy ?? 'type';
            const offset = args.offset ?? 0;
            const limit = args.limit ?? 200;
            const budget = Math.floor(MAX_BYTES / resolve(actorOf(extra), args.cabinet).length);

            return overCabinetsInTurn(actorOf(extra), args.cabinet, async cabinet => {
                const [agg, types] = await Promise.all([
                    getOzonAccruals(cabinet, { from, to, refresh: args.refresh }),
                    getAccrualTypes(cabinet).catch(() => new Map<number, AccrualType>())
                ]);

                // Сверка с балансом — отдельный метод Ozon. Не сошлось — говорим прямо.
                let check: string;
                try {
                    const b = await getOzonBalance(cabinet, { from, to });
                    const diff = Math.round(b.accrued * 100) - agg.totalKop;
                    check =
                        diff === 0
                            ? `сверка с /v1/finance/balance: совпадает до копейки`
                            : `сверка с /v1/finance/balance: там ${rubK(Math.round(b.accrued * 100))} ₽, расхождение ${rubK(diff)} ₽`;
                } catch (e) {
                    check = `сверка с /v1/finance/balance не удалась: ${explainError(e)}`;
                }

                const cachedNote = agg.cached.length
                    ? `; из кэша: ${agg.cached.map(c => `${c.month} (скачан ${new Date(c.fetchedAt * 1000).toISOString().slice(0, 10)})`).join(', ')}`
                    : '';
                const head = [
                    `Начисления Ozon · ${cabinet.slug} · ${from} — ${to}${to !== args.dateTo ? ` (конец обрезан по сегодня)` : ''}`,
                    `Источник: /v1/finance/accrual/by-day — начислений ${pcs(agg.sourceRows)}, запросов к Ozon ${agg.requests}${cachedNote}`,
                    `Итого начислено: ${rubK(agg.totalKop)} ₽ · ${check}`,
                    'Знаки: поступления с плюсом, удержания и расходы с минусом. Суммы в ₽.',
                    ...(agg.unparsedRows > 0
                        ? [`ВНИМАНИЕ: ${agg.unparsedRows} начислений разобраны не полностью — остаток показан видом «Не разобрано». Нужна правка коннектора.`]
                        : []),
                    '',
                    ...formsBlock(agg),
                    ''
                ];

                if (groupBy === 'type') {
                    const rows = accrualsTypeRows(agg, types);
                    head.push(
                        `Виды начислений: ${rows.length} с ненулевой суммой (остальные виды справочника Ozon за период не начислялись).`,
                        'статья | вид [код Ozon] | сумма, ₽ · штуки · строк источника'
                    );
                    return pageRows(head.join('\n'), rows, offset, limit, noSkuLine(agg, types), budget);
                }
                if (groupBy === 'sku') {
                    const rows = accrualsSkuRows(agg);
                    head.push(
                        `Товаров с начислениями: ${rows.length}. Штуки — продано минус возвращено. «Прочее» — остальные виды по товару.`,
                        'артикул | SKU | шт | выручка | комиссия | эквайринг | логистика | прочее | итого, ₽'
                    );
                    return pageRows(head.join('\n'), rows, offset, limit, noSkuLine(agg, types), budget);
                }
                const rows = accrualsTypeSkuRows(agg, types);
                head.push(
                    `Строк «вид × товар»: ${rows.length}. Названия кодов — в разрезе type.`,
                    'код вида | артикул | SKU | сумма, ₽ | штуки'
                );
                return pageRows(head.join('\n'), rows, offset, limit, '', budget);
            });
        })
    );

    server.registerTool(
        'ozon_buyer_prices',
        {
            title: 'Ozon: цена, которую платит покупатель',
            description:
                'Сколько покупатели фактически платили за каждый товар — из отчёта о реализации Ozon за месяц: ' +
                'цена продавца, сколько заплатил покупатель и какую долю докрыл Ozon своими скидками. Ozon-аналог ' +
                'wb_buyer_prices. Берите его, а не ozon_products, когда нужна цена для покупателя: в API цен Ozon ' +
                'её больше нет, а скидки Ozon персональные — одной цены на сайте не существует. Отчёт выходит ' +
                'после закрытия месяца; по дням Ozon отдаёт его только на подписке Premium Plus.',
            inputSchema: {
                cabinet: cabinetArg,
                month: z
                    .string()
                    .regex(/^\d{4}-\d{2}$/, 'Месяц в виде 2026-09')
                    .optional()
                    .describe('Месяц отчёта, например 2026-09. По умолчанию — последний закрытый.'),
                search: z.string().optional().describe('Часть артикула продавца или названия товара'),
                limit: z.number().int().min(1).max(300).optional().describe('Сколько товаров показать, по умолчанию 50')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_buyer_prices', async (args, extra) =>
            overCabinetsInTurn(actorOf(extra), args.cabinet, async cabinet => {
                const nowMsk = new Date(Date.now() + 3 * 3_600_000);
                const asked = args.month
                    ? { year: Number(args.month.slice(0, 4)), month: Number(args.month.slice(5, 7)) }
                    : shiftMonth(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth() + 1, -1);

                let report = await getOzonRealization(cabinet, asked.year, asked.month);
                let note = '';
                // В первые дни месяца отчёт за прошлый ещё не готов — берём позапрошлый и говорим об этом.
                if (!report && !args.month) {
                    const earlier = shiftMonth(asked.year, asked.month, -1);
                    report = await getOzonRealization(cabinet, earlier.year, earlier.month);
                    if (report) note = `Отчёт за ${monthLabel(asked.year, asked.month)} Ozon ещё не выпустил — показан ${monthLabel(earlier.year, earlier.month)}.`;
                }
                if (!report) {
                    return `Отчёта о реализации за ${monthLabel(asked.year, asked.month)} нет: месяц ещё не закрыт или продаж не было.`;
                }

                const needle = args.search?.trim().toLowerCase();
                const items = needle
                    ? report.items.filter(i => i.offerId.toLowerCase().includes(needle) || i.name.toLowerCase().includes(needle))
                    : report.items;
                const label = monthLabel(report.year, report.month);
                if (items.length === 0) return `${note ? note + '\n' : ''}В отчёте за ${label} по запросу «${args.search}» продаж нет.`;

                const prices = await getAllOzonPrices(cabinet);
                const nowPrice = new Map(prices.map(p => [p.offer_id, p.price]));
                const rubN = (v: number): string => `${Math.round(v).toLocaleString('ru-RU')} \u20bd`;
                const shown = items.slice(0, args.limit ?? 50);
                const lines = shown.map(i => {
                    const share = i.sellerSum > 0 ? Math.round((1 - i.buyerSum / i.sellerSum) * 100) : 0;
                    const now = nowPrice.get(i.offerId)?.price;
                    return (
                        `${i.offerId} — покупатель платил в среднем ${rubN(i.buyerSum / i.qty)}` +
                        (Math.round(i.lowPrice) !== Math.round(i.highPrice) ? `, у 80% покупателей от ${rubN(i.lowPrice)} до ${rubN(i.highPrice)}` : '') +
                        ` (продано ${i.qty} шт.)` +
                        ` | цена продавца в среднем ${rubN(i.sellerSum / i.qty)}, скидка за счёт Ozon ${share}%` +
                        (now ? ` | сейчас в кабинете ${rub(now)}` : '')
                    );
                });

                // Доля по всему отчёту, а не по выборке: это фон для сравнения со свежей неделей.
                const all = report.items.reduce((s, i) => ({ seller: s.seller + i.sellerSum, buyer: s.buyer + i.buyerSum }), { seller: 0, buyer: 0 });
                const monthShare = all.seller > 0 ? Math.round((all.buyer / all.seller) * 100) : 0;
                const yesterday = new Date(nowMsk.getTime() - 86_400_000).toISOString().slice(0, 10);
                const weekAgo = new Date(nowMsk.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
                let fresh = '';
                try {
                    const b = await getOzonBalance(cabinet, { from: weekAgo, to: yesterday });
                    if (b.sales.amount > 0) {
                        fresh = `За последние 7 дней по кабинету покупатели заплатили ${Math.round((b.sales.revenue / b.sales.amount) * 100)}% от цены продавца (в отчётном месяце — ${monthShare}%).`;
                    }
                } catch {
                    /* свежая доля — подсказка, без неё отчёт всё равно верен */
                }

                return [
                    ...(note ? [note, ''] : []),
                    `Отчёт о реализации за ${label}: товаров с продажами ${items.length}` +
                        (items.length > shown.length ? ` — показано ${shown.length}, увеличьте limit` : ''),
                    '',
                    ...lines,
                    '',
                    'Цена покупателя — сколько люди фактически заплатили, по отчёту о реализации Ozon. Разница с ценой',
                    'продавца — скидки Ozon за его счёт: Ozon возвращает её продавцу баллами. Скидки персональные,',
                    'поэтому у разных покупателей цена разная и одной «цены на сайте» нет. «У 80% покупателей» —',
                    'без 10% самых дешёвых и 10% самых дорогих покупок: там бывают оплаты почти целиком баллами.',
                    ...(fresh ? [fresh] : [])
                ].join('\n');
            })
        )
    );

    server.registerTool(
        'ozon_chat_history',
        {
            title: 'Ozon: переписка в чате',
            description:
                'Что писали в конкретном чате: сообщения покупателя, наши ответы и служебные уведомления Ozon — раздельно. ' +
                'Номер чата берётся из ozon_chats. Отвечать через коннектор пока нельзя: ключ выпущен только на чтение.',
            inputSchema: {
                cabinet: cabinetArg,
                chatId: z.string().describe('Номер чата из ozon_chats'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько сообщений, по умолчанию 30'),
                withNotifications: z
                    .boolean()
                    .optional()
                    .describe('Показать и служебные уведомления Ozon. По умолчанию только живая переписка.')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_chat_history', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const all = await getOzonChatHistory(cabinet, args.chatId, args.limit ?? 30);
                if (all.length === 0) return 'В этом чате сообщений нет.';

                // Служебные рассылки Ozon идут тем же потоком, что и письма
                // покупателей. Если их не отделить, вопрос человека утонет
                // среди «заберите возвраты из точки выдачи».
                const isService = (m: { author: string }): boolean => /Notification|System/i.test(m.author);
                const talk = all.filter(m => !isService(m));
                const service = all.filter(isService);
                const shown = args.withNotifications ? all : talk;

                if (shown.length === 0) {
                    return (
                        `Живой переписки в этом чате нет: все ${all.length} сообщений — служебные ` +
                        `уведомления Ozon. Чтобы посмотреть их, вызовите ещё раз с withNotifications.`
                    );
                }

                const name = (author: string): string =>
                    /Seller/i.test(author) ? 'мы' : /Customer|Buyer/i.test(author) ? 'покупатель' : author;

                const lines = shown.map(m => {
                    const body = m.isImage && !m.text ? '(изображение)' : m.text.replace(/\s+/g, ' ').slice(0, 400);
                    return `[${name(m.author)}] ${m.createdAt.slice(0, 16).replace('T', ' ')}${m.isRead ? '' : ' • не прочитано'}\n   ${body}`;
                });

                const head =
                    `Сообщений: ${shown.length}` +
                    (!args.withNotifications && service.length > 0
                        ? ` (плюс ${service.length} служебных уведомлений Ozon — скрыты)`
                        : '');
                return `${head}\n\n${lines.join('\n')}`;
            })
        )
    );

    server.registerTool(
        'ozon_ads',
        {
            title: 'Ozon: реклама и окупаемость',
            description:
                'Рекламные кампании Ozon за период: расход, показы, клики, CTR, заказы и выручка от рекламы, ДРР. ' +
                'Это отдельный от Seller API рекламный кабинет — в обычной аналитике Ozon все рекламные показатели отключены.\n' +
                'groupBy=campaign (по умолчанию) — по кампаниям, расход положительным числом, как в кабинете. ' +
                'groupBy=sku — расход по товарам: артикул продавца, SKU, оплата за клик и оплата за заказ отдельно; ' +
                'здесь расход С МИНУСОМ, как в начислениях ozon_accruals, чтобы суммы сверялись напрямую. Разбивка ' +
                'строится отчётами рекламного кабинета (до минуты на кабинет в первый раз; период — до 62 дней на ' +
                'отчёт, длиннее склеивается); итог по товарам сверяется с расходом кампаний, и всё, что не разложилось ' +
                '(баннеры, расхождения), показано отдельной строкой с причиной. Закрытый период (прошло 10 дней) ' +
                'кэшируется на сервере. Длинный список — offset и limit.',
            inputSchema: {
                cabinet: z.string().optional().describe('Кабинет Ozon (oz-harbez). Не указан — по всем доступным.'),
                dateFrom: z.string().describe('Начало периода, ISO-дата: 2026-08-01'),
                dateTo: z.string().describe('Конец периода, ISO-дата: 2026-08-31'),
                groupBy: z
                    .enum(['campaign', 'sku'])
                    .optional()
                    .describe('campaign — по кампаниям (по умолчанию), sku — расход по товарам и инструменту'),
                offset: z.number().int().min(0).optional().describe('Для groupBy=sku: с какой строки показывать, по умолчанию 0'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(500)
                    .optional()
                    .describe('Сколько строк: кампаний (по умолчанию 15, не больше 100) или товаров при groupBy=sku (по умолчанию 200, не больше 500)')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_ads', async (args, extra) => {
            const cabs = resolve(actorOf(extra), args.cabinet);
            const withPerf = cabs.filter(hasPerf);
            if (withPerf.length === 0) {
                return text(
                    'Ни по одному доступному вам кабинету не заведены ключи рекламного кабинета. ' +
                        'Их выпускают отдельно от ключей продавца, в разделе продвижения.'
                );
            }

            const skipped = cabs.filter(c => !hasPerf(c)).map(c => c.slug);
            if (args.groupBy === 'sku') {
                // Кабинеты по очереди: Ozon строит одно задание на отчёт за раз.
                const out: string[] = [];
                let failed = 0;
                for (const cab of withPerf) {
                    try {
                        out.push(
                            await adsBySkuReport(cab, args.dateFrom.slice(0, 10), args.dateTo.slice(0, 10), args.offset ?? 0, args.limit ?? 200, Math.floor(MAX_BYTES / withPerf.length))
                        );
                    } catch (e) {
                        failed++;
                        logger.warn({ cabinet: cab.slug, err: e instanceof Error ? e.message.slice(0, 300) : String(e) }, 'cabinet failed');
                        out.push(`━━ ${cab.slug} · расход по SKU ━━\nОшибка: ${explainError(e)}`);
                    }
                }
                if (skipped.length > 0) out.push(`Без рекламных ключей, поэтому не вошли в отчёт: ${skipped.join(', ')}.`);
                return finish(out, failed === withPerf.length);
            }
            const top = Math.min(args.limit ?? 15, 100);
            const blocks: string[] = [];

            for (const cab of withPerf) {
                const [rows, campaigns] = await Promise.all([
                    dailyStats(cab, args.dateFrom, args.dateTo),
                    listCampaigns(cab).catch(() => [])
                ]);
                const { totals, campaigns: rolled } = rollUpByCampaign(rows);
                const stateOf = new Map(campaigns.map(c => [c.id, c.state.replace(/^CAMPAIGN_STATE_/, '').toLowerCase()]));

                const t = totals;
                const head = `━━ ${cab.slug} · ${args.dateFrom} — ${args.dateTo} ━━`;
                const lines = [
                    head,
                    `Расход: ${money(t.spent)}   ·   выручка от рекламы: ${money(t.ordersMoney)}   ·   заказов: ${t.orders}`,
                    `ДРР: ${pctOrDash(drr(t.spent, t.ordersMoney))}   ·   показов: ${t.views.toLocaleString('ru-RU')}   ·   кликов: ${t.clicks.toLocaleString('ru-RU')}   ·   CTR: ${pctOrDash(ctr(t.clicks, t.views))}`,
                    ''
                ];

                if (rolled.length === 0) {
                    lines.push('За период по этому кабинету рекламных данных нет.');
                } else {
                    // Показываем на строку больше, чем просили: иначе «кампаний N»
                    // не отличить от «их ровно N».
                    const shown = rolled.slice(0, top);
                    lines.push(`Кампании по расходу (всего ${rolled.length}):`);
                    for (const [i, c] of shown.entries()) {
                        const st = stateOf.get(c.id);
                        lines.push(
                            `  ${i + 1}. ${c.title}${st ? ` · ${st}` : ''}` +
                                `\n      расход ${money(c.spent)} · выручка ${money(c.ordersMoney)} · ДРР ${pctOrDash(drr(c.spent, c.ordersMoney))}` +
                                `\n      показов ${c.views.toLocaleString('ru-RU')} · кликов ${c.clicks} · CTR ${pctOrDash(ctr(c.clicks, c.views))} · заказов ${c.orders}`
                        );
                    }
                    if (rolled.length > shown.length) {
                        lines.push(`  … ещё кампаний: ${rolled.length - shown.length}`);
                    }
                }
                blocks.push(lines.filter(l => l !== undefined).join('\n'));
            }

            if (skipped.length > 0) {
                blocks.push(`Без рекламных ключей, поэтому не вошли в отчёт: ${skipped.join(', ')}.`);
            }
            return text(blocks.join('\n\n'));
        })
    );
}
