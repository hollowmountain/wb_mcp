import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { config } from '../../config.js';
import {
    getOzonAnalytics,
    getOzonFinanceTotals,
    getAllOzonPrices,
    getAllOzonStocks,
    getOzonWarehouseStocks,
    listFboPostings,
    listFbsPostings,
    listOzonChats,
    listOzonProducts,
    listOzonReturns,
    type OzonCabinet
} from '../../ozon/client.js';
import { actorOf, guarded, text, type ToolResult } from './common.js';

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

function resolve(actor: Actor, slug?: string): OzonCabinet[] {
    const allowed = allowedOzon(actor);
    if (allowed.length === 0) {
        throw new Error('Кабинеты Ozon вам не открыты. Обратитесь к администратору.');
    }
    if (!slug) return allowed;
    const wanted = slug.trim().toLowerCase();
    const one = allowed.find(c => c.slug === wanted);
    if (!one) {
        throw new Error(`Кабинет «${slug}» вам не доступен. Доступны: ${allowed.map(c => c.slug).join(', ')}`);
    }
    return [one];
}

const cabinetArg = z.string().optional().describe('Кабинет Ozon. Не указан — по всем доступным.');

const heading = (cabinet: OzonCabinet, total: number): string =>
    total === 1 ? '' : `━━ ${cabinet.slug} ━━\n`;

async function overCabinets(
    actor: Actor,
    slug: string | undefined,
    run: (cabinet: OzonCabinet) => Promise<string>
): Promise<ToolResult> {
    const cabinets = resolve(actor, slug);
    const blocks = await Promise.all(
        cabinets.map(async c => {
            try {
                return heading(c, cabinets.length) + (await run(c));
            } catch (e) {
                return `${heading(c, cabinets.length)}Ошибка: ${e instanceof Error ? e.message : String(e)}`;
            }
        })
    );
    return text(blocks.join('\n\n'));
}

const rub = (v: string | undefined, cur?: string): string =>
    v === undefined || v === '' ? dash : `${Number(v).toLocaleString('ru-RU')} ${cur ?? '₽'}`.trim();

const day = (v: string | undefined): string => (v ? v.slice(0, 10) : dash);

const money = (n: number): string =>
    `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} \u20bd`;

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
    for (const c of cabinets) {
        try {
            blocks.push(heading(c, cabinets.length) + (await run(c)));
        } catch (e) {
            blocks.push(`${heading(c, cabinets.length)}Ошибка: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return text(blocks.join('\n\n'));
}

export function registerOzonTools(server: McpServer, actor: Actor): void {
    if (allowedOzon(actor).length === 0) return;

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
                        `   Цена: ${rub(p?.price, p?.currency_code)}${p?.old_price && p.old_price !== '0' ? ` (до скидки ${rub(p.old_price, p.currency_code)})` : ''}`
                    ].join('\n');
                });
                const tail = rows.length > want ? `\n\n… ещё товаров: ${rows.length - want}` : '';
                return `Товаров: ${rows.length}\n\n${lines.join('\n')}${tail}`;
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
                'Что Ozon начислил и что удержал за период: продажи, комиссия, логистика и обработка, ' +
                'возвраты, услуги, компенсации. Внизу — сколько остаётся продавцу.',
            inputSchema: {
                cabinet: cabinetArg,
                dateFrom: dateArg('Начало периода: 2026-08-01'),
                dateTo: dateArg('Конец периода: 2026-09-01')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('ozon_finance', async (args, extra) =>
            overCabinetsInTurn(actorOf(extra), args.cabinet, async cabinet => {
                const f = await getOzonFinanceTotals(cabinet, { from: args.dateFrom, to: args.dateTo });
                const share = f.accrualsForSale > 0 ? Math.round((f.net / f.accrualsForSale) * 100) : 0;
                const line = (label: string, v: number): string => `${label.padEnd(26, '.')} ${money(v)}`;
                return [
                    `${args.dateFrom} — ${args.dateTo}`,
                    '',
                    line('Начислено за продажи', f.accrualsForSale),
                    line('Комиссия площадки', f.saleCommission),
                    line('Обработка и доставка', f.processingAndDelivery),
                    line('Возвраты и отмены', f.refundsAndCancellations),
                    line('Услуги', f.servicesAmount),
                    line('Компенсации', f.compensationAmount),
                    line('Прочее', f.othersAmount),
                    '',
                    `К перечислению: ${money(f.net)} — это ${share}% от начисленного`
                ].join('\n');
            })
        )
    );
}
