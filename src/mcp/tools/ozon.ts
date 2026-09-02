import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { config } from '../../config.js';
import {
    getOzonPrices,
    getOzonStocks,
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
                    getOzonStocks(cabinet, { limit: 1000 }),
                    getOzonPrices(cabinet, { limit: 1000 })
                ]);

                const priceBy = new Map(prices.items.map(p => [p.offer_id, p]));
                let rows = stocks.items;
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
                        `   Остаток: ${total} шт.${byType.length ? ` — ${byType.join(', ')}` : ''}`,
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
                    const fbo = (await listFboPostings(cabinet, since, to, want)).result ?? [];
                    blocks.push(fbo.length === 0 ? 'FBO (склады Ozon): заказов нет' : `FBO (склады Ozon): ${fbo.length}\n${fmt(fbo)}`);
                }
                if (args.scheme !== 'fbo') {
                    const fbs = (await listFbsPostings(cabinet, since, to, want)).result?.postings ?? [];
                    blocks.push(fbs.length === 0 ? 'FBS (склад продавца): заказов нет' : `FBS (склад продавца): ${fbs.length}\n${fmt(fbs)}`);
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
}
