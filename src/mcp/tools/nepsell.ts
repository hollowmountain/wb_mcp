import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { canUseNepsell, config } from '../../config.js';
import type { Actor } from '../../auth/provider.js';
import { getAdMetrics, getFinances, listAdCampaigns, listNepsellClients } from '../../nepsell/client.js';
import { linkCabinets, summariseAds, summariseFinances } from '../../nepsell/economy.js';
import { actorOf, fail, guarded, text } from './common.js';

const money = (v: number): string => `${v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
const pct = (v: number | null): string => (v === null ? '—' : `${v}%`);

const dateArg = (what: string) => z.string().describe(`${what}, ISO-дата: 2026-08-01`);

const marketArg = z
    .enum(['wb', 'ozon'])
    .optional()
    .describe('Площадка. Не указана — покажет обе рядом, чтобы можно было сравнить.');

/**
 * Кабинеты Nepsell, доступные этому человеку. Область видимости та же, что у
 * WB: чужой кабинет для сотрудника не существует.
 */
async function resolveLinks(actor: Actor, slug: string | undefined) {
    const token = config.nepsell.token;
    const clients = (await listNepsellClients(token)).data;

    const links = linkCabinets(
        clients,
        config.cabinets.all().map(c => ({ slug: c.slug, orgId: c.info.orgId })),
        config.ozon.map(c => ({ slug: c.slug, clientId: c.clientId }))
    ).filter(l => actor.cabinets === null || actor.cabinets.includes(l.slug));

    if (slug) {
        const one = links.find(l => l.slug === slug.trim().toLowerCase());
        if (!one) throw new Error(`Кабинет «${slug}» вам не доступен или Nepsell его не знает.`);
        return [one];
    }
    return links;
}

/** Nepsell закрыт всем, кроме названных. Проверяем и здесь: список инструментов у клиента кэшируется. */
function denyIfNotAllowed(actor: Actor): string | null {
    if (canUseNepsell(actor.email)) return null;
    return 'Доступ к данным Nepsell для вашей учётной записи не открыт. Там себестоимость и экономика — обратитесь к администратору, если это нужно по работе.';
}

export function registerNepsellTools(server: McpServer, actor: Actor): void {
    if (!canUseNepsell(actor.email)) return;

    server.registerTool(
        'nep_cabinets',
        {
            title: 'Кабинеты в Nepsell',
            description:
                'Какие кабинеты видит Nepsell и как они соответствуют кабинетам Wildberries и Ozon. Вызовите первым, если не знаете, что доступно.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('nep_cabinets', async (_args, extra) => {
            const actorNow = actorOf(extra);
            const denied = denyIfNotAllowed(actorNow);
            if (denied) return fail(denied);

            const links = await resolveLinks(actorNow, undefined);
            const lines = links.map(l => {
                const parts = [
                    l.wb ? `Wildberries: ${l.wb.name} (${l.wb.client_id})` : 'Wildberries: не связан',
                    l.ozon ? `Ozon: ${l.ozon.name} (${l.ozon.client_id})` : 'Ozon: не связан'
                ];
                return `${l.slug}\n   ${parts.join('\n   ')}`;
            });
            return text(lines.join('\n\n') || 'Nepsell не знает ни одного из доступных вам кабинетов.');
        })
    );

    server.registerTool(
        'nep_economy',
        {
            title: 'Экономика: себестоимость и прибыль',
            description:
                'Настоящая экономика товаров за период: выручка, СЕБЕСТОИМОСТЬ, комиссия, логистика, реклама, налоги и прибыль. Себестоимости нет ни в API Wildberries, ни в API Ozon — она есть только здесь, поэтому маржу и прибыль считайте по этому инструменту, а не по данным площадок.',
            inputSchema: {
                cabinet: z.string().optional().describe('Кабинет. Не указан — по всем доступным.'),
                marketplace: marketArg,
                dateFrom: dateArg('Начало периода'),
                dateTo: dateArg('Конец периода'),
                topItems: z.number().int().min(0).max(50).optional().describe('Сколько товаров показать, по умолчанию 10')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('nep_economy', async (args, extra) => {
            const actorNow = actorOf(extra);
            const denied = denyIfNotAllowed(actorNow);
            if (denied) return fail(denied);

            const links = await resolveLinks(actorNow, args.cabinet);
            const top = args.topItems ?? 10;
            const blocks: string[] = [];

            for (const link of links) {
                for (const market of ['wb', 'ozon'] as const) {
                    if (args.marketplace && args.marketplace !== market) continue;
                    const client = market === 'wb' ? link.wb : link.ozon;
                    if (!client) continue;

                    const rows = (await getFinances(config.nepsell.token, client.client_id, args.dateFrom, args.dateTo)).data;
                    const { totals: t, items, skipped } = summariseFinances(rows);

                    const head = `━━ ${link.slug} · ${market === 'wb' ? 'Wildberries' : 'Ozon'} · ${args.dateFrom} — ${args.dateTo} ━━`;
                    const lines = [
                        head,
                        `Выручка: ${money(t.revenue)}   ·   продаж: ${t.salesCount}`,
                        `К получению от площадки: ${money(t.clientRevenue)}`,
                        `Себестоимость: ${money(t.cost)}`,
                        `Комиссия: ${money(t.commission)}   логистика: ${money(t.logistics)}   реклама: ${money(t.ads)}   налоги: ${money(t.taxes)}`,
                        t.expenses !== 0 ? `Прочие расходы: ${money(t.expenses)}` : '',
                        `Валовая прибыль: ${money(t.grossProfit)}`,
                        `ПРИБЫЛЬ: ${money(t.profit)}   ·   маржа ${pct(t.marginPercent)} от выручки`,
                        ''
                    ].filter(Boolean);

                    if (top > 0 && items.length > 0) {
                        lines.push(`Самые прибыльные (из ${items.length} товаров):`);
                        for (const [i, it] of items.slice(0, top).entries()) {
                            lines.push(
                                `  ${i + 1}. nmID ${it.nmId} — прибыль ${money(it.profit)}, выручка ${money(it.revenue)}, себестоимость ${money(it.cost)}, маржа ${pct(it.marginPercent)}, продаж ${it.salesCount}`
                            );
                        }
                        const losing = items.filter(i => i.profit < 0);
                        if (losing.length > 0) {
                            lines.push('', `Убыточные (${losing.length}):`);
                            for (const it of losing.slice(0, top)) {
                                lines.push(`  nmID ${it.nmId} — убыток ${money(it.profit)}, продаж ${it.salesCount}`);
                            }
                        }
                    }
                    if (skipped.length > 0) {
                        lines.push('', `Не суммировались (их складывать нельзя): ${skipped.join(', ')}. Маржа посчитана нами из итогов.`);
                    }
                    blocks.push(lines.join('\n'));
                }
            }

            return text(blocks.join('\n\n') || 'Данных за период нет.');
        })
    );

    server.registerTool(
        'nep_ads',
        {
            title: 'Реклама: окупаемость',
            description:
                'Рекламные кампании в связке с продажами: расход, ДРР, показы, клики, заказы прямые и по связанным товарам. API Wildberries отдаёт расход и продажи по отдельности и не связывает их между собой — эта связка есть только здесь.',
            inputSchema: {
                cabinet: z.string().optional().describe('Кабинет. Не указан — по всем доступным.'),
                marketplace: marketArg,
                dateFrom: dateArg('Начало периода'),
                dateTo: dateArg('Конец периода'),
                topCampaigns: z.number().int().min(0).max(50).optional().describe('Сколько кампаний показать, по умолчанию 10')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('nep_ads', async (args, extra) => {
            const actorNow = actorOf(extra);
            const denied = denyIfNotAllowed(actorNow);
            if (denied) return fail(denied);

            const links = await resolveLinks(actorNow, args.cabinet);
            const top = args.topCampaigns ?? 10;
            const blocks: string[] = [];

            for (const link of links) {
                for (const market of ['wb', 'ozon'] as const) {
                    if (args.marketplace && args.marketplace !== market) continue;
                    const client = market === 'wb' ? link.wb : link.ozon;
                    if (!client) continue;

                    const [metrics, list] = await Promise.all([
                        getAdMetrics(config.nepsell.token, client.client_id, args.dateFrom, args.dateTo),
                        listAdCampaigns(config.nepsell.token, client.client_id, args.dateFrom, args.dateTo)
                    ]);
                    const { totals: t, campaigns } = summariseAds(metrics.data, list.data);
                    if (campaigns.length === 0) continue;

                    const lines = [
                        `━━ ${link.slug} · ${market === 'wb' ? 'Wildberries' : 'Ozon'} · ${args.dateFrom} — ${args.dateTo} ━━`,
                        `Расход на рекламу: ${money(t.spend)}   ·   продажи по рекламе: ${money(t.salesSum)}`,
                        `ДРР: ${pct(t.drrPercent)}   ·   CTR: ${pct(t.ctrPercent)}   ·   цена клика: ${t.clickPrice === null ? '—' : money(t.clickPrice)}`,
                        `Показы: ${t.views}   клики: ${t.clicks}   корзины: ${t.carts}`,
                        `Заказы: ${t.orders} — из них прямых ${t.directOrders}, по связанным товарам ${t.assocOrders}`,
                        ''
                    ];

                    if (top > 0) {
                        lines.push(`Кампании (${campaigns.length}), по расходу:`);
                        for (const [i, c] of campaigns.slice(0, top).entries()) {
                            lines.push(
                                `  ${i + 1}. ${c.name}`,
                                `     расход ${money(c.spend)}, продажи ${money(c.salesSum)}, ДРР ${pct(c.drrPercent)}, заказов ${c.orders} (связанных ${c.assocOrders})`,
                                `     товаров в кампании: ${c.nmIds.length}, тянет за собой: ${c.assocNmIds.length}`
                            );
                        }
                    }
                    blocks.push(lines.join('\n'));
                }
            }

            return text(blocks.join('\n\n') || 'Рекламных кампаний за период нет.');
        })
    );
}
