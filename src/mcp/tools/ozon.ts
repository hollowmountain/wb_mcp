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
import { ctr, dailyStats, drr, hasPerf, listCampaigns, rollUpByCampaign } from '../../ozon/performance.js';
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
                'Это отдельный от Seller API рекламный кабинет — в обычной аналитике Ozon все рекламные показатели отключены.',
            inputSchema: {
                cabinet: z.string().optional().describe('Кабинет Ozon (oz-harbez). Не указан — по всем доступным.'),
                dateFrom: z.string().describe('Начало периода, ISO-дата: 2026-08-01'),
                dateTo: z.string().describe('Конец периода, ISO-дата: 2026-08-31'),
                limit: z.number().int().min(1).max(100).optional().describe('Сколько кампаний показать, по умолчанию 15')
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
            const top = args.limit ?? 15;
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
