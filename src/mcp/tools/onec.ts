import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { canUseOnec, config } from '../../config.js';
import { ALLOWED_ENTITIES, countEntity, listEntity, type OnecEntity } from '../../onec/client.js';
import { actorOf, fail, guarded, text } from './common.js';

const dash = '—';

/** Экранирование строки для $filter: одинарная кавычка удваивается. */
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const money = (v: unknown): string =>
    typeof v === 'number' && Number.isFinite(v) ? `${v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽` : dash;

const day = (v: unknown): string => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : dash);

function denyIfNotAllowed(actor: Actor): string | null {
    if (canUseOnec(actor.email)) return null;
    return 'Доступ к 1С для вашей учётной записи не открыт. Обратитесь к администратору, если это нужно по работе.';
}

interface Product {
    Ref_Key: string;
    Code: string;
    Description: string;
    Артикул: string;
    DeletionMark: boolean;
    IsFolder: boolean;
}

interface Partner {
    Ref_Key: string;
    Code: string;
    Description: string;
    ИНН: string;
    DeletionMark: boolean;
    IsFolder: boolean;
}

interface SalesOrder {
    Ref_Key: string;
    Number: string;
    Date: string;
    Posted: boolean;
    DeletionMark: boolean;
    СуммаДокумента: number;
    Контрагент_Key: string;
}

export function registerOnecTools(server: McpServer, actor: Actor): void {
    if (!canUseOnec(actor.email)) return;

    server.registerTool(
        'onec_reference',
        {
            title: '1С: что доступно',
            description:
                'Какие разделы 1С открыты коннектору и сколько в них записей. Вызовите первым, чтобы понять, с чем вообще можно работать.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_reference', async (_args, extra) => {
            const denied = denyIfNotAllowed(actorOf(extra));
            if (denied) return fail(denied);

            const lines = ['Коннектору открыты только эти разделы 1С, остальное для него не существует:', ''];
            for (const entity of ALLOWED_ENTITIES) {
                try {
                    lines.push(`   ${entity} ${dash} записей: ${await countEntity(config.onec, entity)}`);
                } catch (e) {
                    lines.push(`   ${entity} ${dash} недоступен: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            lines.push('', 'Только чтение: изменить что-либо в 1С через коннектор нельзя.');
            return text(lines.join('\n'));
        })
    );

    server.registerTool(
        'onec_products',
        {
            title: '1С: номенклатура',
            description:
                'Товары в 1С: поиск по названию или артикулу. Это учётная номенклатура предприятия — она может отличаться от карточек на маркетплейсах, там своя. Для карточек Wildberries есть wb_product.',
            inputSchema: {
                search: z.string().optional().describe('Часть названия или артикула'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_products', async (args, extra) => {
            const denied = denyIfNotAllowed(actorOf(extra));
            if (denied) return fail(denied);

            const s = args.search?.trim();
            const filter = [
                'DeletionMark eq false',
                'IsFolder eq false',
                s ? `(substringof(${q(s)}, Description) or substringof(${q(s)}, Артикул))` : ''
            ]
                .filter(Boolean)
                .join(' and ');

            const rows = await listEntity<Product>(config.onec, 'Catalog_Номенклатура', {
                top: args.limit ?? 20,
                filter,
                select: 'Ref_Key,Code,Description,Артикул,DeletionMark,IsFolder',
                orderby: 'Description'
            });

            if (rows.length === 0) return text(s ? `По запросу «${s}» в 1С ничего не найдено.` : 'Номенклатура пуста.');
            const lines = rows.map(
                (r, i) => `${i + 1}. ${r.Description || dash}\n   код ${r.Code || dash}, артикул ${r.Артикул || dash}`
            );
            return text(`Найдено: ${rows.length}\n\n${lines.join('\n')}`);
        })
    );

    server.registerTool(
        'onec_partners',
        {
            title: '1С: контрагенты',
            description: 'Контрагенты предприятия: поиск по названию или ИНН. Поставщики, покупатели, прочие.',
            inputSchema: {
                search: z.string().optional().describe('Часть названия или ИНН'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_partners', async (args, extra) => {
            const denied = denyIfNotAllowed(actorOf(extra));
            if (denied) return fail(denied);

            const s = args.search?.trim();
            const filter = [
                'DeletionMark eq false',
                'IsFolder eq false',
                s ? `(substringof(${q(s)}, Description) or substringof(${q(s)}, ИНН))` : ''
            ]
                .filter(Boolean)
                .join(' and ');

            const rows = await listEntity<Partner>(config.onec, 'Catalog_Контрагенты', {
                top: args.limit ?? 20,
                filter,
                select: 'Ref_Key,Code,Description,ИНН,DeletionMark,IsFolder',
                orderby: 'Description'
            });

            if (rows.length === 0) return text(s ? `По запросу «${s}» контрагентов не найдено.` : 'Контрагентов нет.');
            const lines = rows.map((r, i) => `${i + 1}. ${r.Description || dash}\n   код ${r.Code || dash}, ИНН ${r.ИНН || dash}`);
            return text(`Найдено: ${rows.length}\n\n${lines.join('\n')}`);
        })
    );

    server.registerTool(
        'onec_orders',
        {
            title: '1С: заказы покупателей',
            description:
                'Заказы покупателей в 1С за период: номер, дата, сумма, проведён или нет. Это учётные заказы предприятия, не заказы маркетплейса — для тех есть wb_orders.',
            inputSchema: {
                dateFrom: z.string().describe('Начало периода, ISO-дата: 2026-08-01'),
                dateTo: z.string().describe('Конец периода, ISO-дата: 2026-08-31'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько показать, по умолчанию 30')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_orders', async (args, extra) => {
            const denied = denyIfNotAllowed(actorOf(extra));
            if (denied) return fail(denied);

            // 1С ждёт дату без часового пояса, в формате ISO.
            const from = `${args.dateFrom.slice(0, 10)}T00:00:00`;
            const to = `${args.dateTo.slice(0, 10)}T23:59:59`;
            const rows = await listEntity<SalesOrder>(config.onec, 'Document_ЗаказПокупателя', {
                top: args.limit ?? 30,
                filter: `Date ge datetime'${from}' and Date le datetime'${to}' and DeletionMark eq false`,
                select: 'Ref_Key,Number,Date,Posted,DeletionMark,СуммаДокумента,Контрагент_Key',
                orderby: 'Date desc'
            });

            if (rows.length === 0) return text(`Заказов за ${args.dateFrom} — ${args.dateTo} не найдено.`);
            const total = rows.reduce((s, r) => s + (r.СуммаДокумента ?? 0), 0);
            const lines = rows.map(
                (r, i) =>
                    `${i + 1}. № ${r.Number || dash} от ${day(r.Date)} ${dash} ${money(r.СуммаДокумента)}${r.Posted ? '' : ' (не проведён)'}`
            );
            return text(`Заказов: ${rows.length}, на сумму ${money(total)}\n\n${lines.join('\n')}`);
        })
    );
}

export type { OnecEntity };
