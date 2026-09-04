import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { config } from '../../config.js';
import { inArea } from '../../auth/provider.js';
import {
    ALLOWED_ENTITIES,
    countEntity,
    getOnecStock,
    listEntity,
    resolveNames,
    type OnecEntity
} from '../../onec/client.js';
import { actorOf, fail, guarded, text } from './common.js';

const dash = '—';

/** Экранирование строки для $filter: одинарная кавычка удваивается. */
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const money = (v: unknown): string =>
    typeof v === 'number' && Number.isFinite(v) ? `${v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽` : dash;

const day = (v: unknown): string => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : dash);

/**
 * 1С разграничивается теми же областями, что и площадки: номенклатура — это
 * catalog, заказы и контрагенты — orders. Отдельного списка почт больше нет,
 * иначе на каждый новый источник заводился бы свой замок.
 */
const onecReady = (): boolean => Boolean(config.onec.baseUrl && config.onec.user);

const anyOnec = (actor: Actor): boolean => onecReady() && inArea(actor, 'erp');

function denyUnless(actor: Actor, _area: 'catalog' | 'orders'): string | null {
    if (anyOnec(actor)) return null;
    return 'Учётная система 1С вам не открыта: нужна область «erp». Обратитесь к администратору.';
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


/**
 * Табличные части в 1С OData лежат внутри самого документа отдельными
 * массивами: у заказа покупателя это «Запасы», у прочих обычно «Товары» или
 * «Запасы». Отдельными сущностями вида Document_X_Товары они НЕ публикуются —
 * такой запрос вернёт «сущность не найдена».
 */
const ITEM_SECTIONS = ['Запасы', 'Товары', 'Материалы', 'Продукция'] as const;

interface DocRow {
    Ref_Key: string;
    Number?: string;
    Date?: string;
    Posted?: boolean;
    СуммаДокумента?: number;
    Контрагент_Key?: string;
    [key: string]: unknown;
}

interface DocItem {
    Номенклатура?: string;
    Номенклатура_Key?: string;
    Количество?: number;
    Цена?: number;
    Сумма?: number;
}

const itemsOf = (doc: DocRow): DocItem[] => {
    for (const section of ITEM_SECTIONS) {
        const v = doc[section];
        if (Array.isArray(v) && v.length > 0) return v as DocItem[];
    }
    return [];
};

/**
 * Единая отрисовка журнала документов: они устроены одинаково, отличаются
 * только именем сущности и тем, есть ли у них контрагент.
 */
async function renderDocuments(opts: {
    entity: OnecEntity;
    dateFrom: string;
    dateTo: string;
    limit: number;
    withItems: boolean;
    partnerField?: string;
    empty: string;
}) {
    const from = `${opts.dateFrom.slice(0, 10)}T00:00:00`;
    const to = `${opts.dateTo.slice(0, 10)}T23:59:59`;

    // $select здесь намеренно не задаётся. Состав документа лежит в самом
    // документе, так что при withItems он и так нужен целиком. А без select
    // не приходится знать заранее, какие поля у документа есть: у заказа
    // на производство и у перемещения запасов нет СуммаДокумента, и запрос
    // с ней падал с «Сегмент пути СуммаДокумента не найден». Документов
    // берём немного, лишние байты дешевле лишней хрупкости.
    const rows = await listEntity<DocRow>(config.onec, opts.entity, {
        top: opts.limit,
        filter: `Date ge datetime'${from}' and Date le datetime'${to}' and DeletionMark eq false`,
        orderby: 'Date desc'
    });
    if (rows.length === 0) return text(opts.empty);

    const partners = opts.partnerField
        ? await resolveNames(
              config.onec,
              'Catalog_Контрагенты',
              rows.map(r => String(r[opts.partnerField as string] ?? ''))
          )
        : new Map<string, string>();

    const productKeys = opts.withItems
        ? rows.flatMap(r => itemsOf(r).map(i => String(i.Номенклатура ?? i.Номенклатура_Key ?? '')))
        : [];
    const products = productKeys.length > 0
        ? await resolveNames(config.onec, 'Catalog_Номенклатура', productKeys)
        : new Map<string, string>();

    const total = rows.reduce((s, r) => s + (r.СуммаДокумента ?? 0), 0);
    const blocks = rows.map((r, i) => {
        const who = opts.partnerField ? partners.get(String(r[opts.partnerField as string] ?? '')) : undefined;
        const head =
            `${i + 1}. № ${r.Number || dash} от ${day(r.Date)}` +
            (who ? ` ${dash} ${who}` : '') +
            (r.СуммаДокумента ? ` ${dash} ${money(r.СуммаДокумента)}` : '') +
            (r.Posted === false ? ' (не проведён)' : '');
        if (!opts.withItems) return head;
        const items = itemsOf(r);
        if (items.length === 0) return `${head}\n   состав пуст`;
        const lines = items.slice(0, 20).map(it => {
            const key = String(it.Номенклатура ?? it.Номенклатура_Key ?? '');
            const name = products.get(key) || '(без названия)';
            const qty = typeof it.Количество === 'number' ? it.Количество.toLocaleString('ru-RU') : dash;
            return `   ${name} ${dash} ${qty}${it.Сумма ? ` на ${money(it.Сумма)}` : ''}`;
        });
        const more = items.length > 20 ? `\n   и ещё ${items.length - 20} строк` : '';
        return `${head}\n${lines.join('\n')}${more}`;
    });

    return text(
        `Документов: ${rows.length}${total > 0 ? `, на сумму ${money(total)}` : ''}\n\n${blocks.join('\n')}`
    );
}

export function registerOnecTools(server: McpServer, actor: Actor): void {
    if (!anyOnec(actor)) return;

    server.registerTool(
        'onec_reference',
        {
            title: '1С: что доступно',
            description:
                'С чего начать работу с 1С: какие инструменты есть, какие данные они дают и чего в базе нет. ' +
                'Вызовите первым, если не знаете, что можно спросить.',
            inputSchema: {
                counts: z
                    .boolean()
                    .optional()
                    .describe('Посчитать записи в каждом разделе. Медленно, по умолчанию нет.')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_reference', async (args, extra) => {
            const denied = anyOnec(actorOf(extra)) ? null : 'Доступ к 1С вам не открыт.';
            if (denied) return fail(denied);

            const lines = [
                'РАБОТА С 1С ЧЕРЕЗ КОННЕКТОР',
                '',
                'База: 1С:Управление нашей фирмой. Коннектор ходит в неё ТОЛЬКО НА ЧТЕНИЕ —',
                'создать, изменить или провести документ через него невозможно.',
                '',
                '── ИНСТРУМЕНТЫ ──',
                '',
                'onec_stock       Остатки на складах: сколько чего лежит и где.',
                '                 Это учётный остаток предприятия, не остаток маркетплейса.',
                'onec_products    Номенклатура: поиск товара по названию, артикулу или коду.',
                'onec_partners    Контрагенты: поставщики и покупатели, поиск по названию или ИНН.',
                'onec_orders      Заказы покупателей за период: номер, дата, сумма, проведён ли.',
                'onec_purchases   Заказы поставщикам: что заказано, у кого, на какую сумму,',
                '                 с составом заказа по строкам.',
                'onec_production  Заказы на производство: что и сколько запущено в работу.',
                'onec_warehouse   Движения склада: перемещения, списания, оприходования,',
                '                 инвентаризации за период.',
                'onec_reference   Эта справка.',
                '',
                '── ЧЕГО В БАЗЕ НЕТ ──',
                '',
                'Зарплаты и кадровых данных нет: соответствующие документы пусты.',
                'Отзывов, вопросов и переписки с покупателями в 1С нет — это площадки,',
                'смотрите инструменты wb_* и ozon_*.',
                'Себестоимости в разрезе товара маркетплейса тут тоже нет — она в nep_economy.',
                '',
                '── ЧЕГО НЕТ У КОННЕКТОРА ──',
                '',
                'В базе опубликовано больше полутора тысяч сущностей, включая справочники',
                'физических лиц и сотрудников. Коннектору из них открыт короткий список,',
                'всё остальное для него не существует и вернёт отказ:',
                ''
            ];

            for (const entity of ALLOWED_ENTITIES) {
                if (args.counts) {
                    try {
                        lines.push(`   ${entity} ${dash} записей: ${await countEntity(config.onec, entity)}`);
                    } catch (e) {
                        lines.push(`   ${entity} ${dash} недоступен: ${e instanceof Error ? e.message : String(e)}`);
                    }
                } else {
                    lines.push(`   ${entity}`);
                }
            }

            lines.push(
                '',
                'Если для работы нужен раздел, которого здесь нет, — скажите администратору,',
                'какой именно и зачем. Список расширяется, но осознанно.'
            );
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
            const denied = denyUnless(actorOf(extra), 'catalog');
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
            const denied = denyUnless(actorOf(extra), 'orders');
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
            const denied = denyUnless(actorOf(extra), 'orders');
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

    server.registerTool(
        'onec_stock',
        {
            title: '1С: остатки на складах',
            description:
                'Учётные остатки предприятия: сколько чего лежит и на каком складе. ' +
                'Это остаток по данным 1С, а не остаток на складах маркетплейса — для тех есть wb_stocks и ozon_stocks.',
            inputSchema: {
                search: z.string().optional().describe('Часть названия товара'),
                warehouse: z.string().optional().describe('Часть названия склада'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько товаров показать, по умолчанию 30')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_stock', async (args, extra) => {
            const denied = denyUnless(actorOf(extra), 'catalog');
            if (denied) return fail(denied);

            const rows = await getOnecStock(config.onec, { top: 1000 });
            const byProduct = args.search?.trim().toLowerCase();
            const byPlace = args.warehouse?.trim().toLowerCase();
            const wanted = rows.filter(
                r =>
                    (!byProduct || r.product.toLowerCase().includes(byProduct)) &&
                    (!byPlace || r.warehouse.toLowerCase().includes(byPlace))
            );
            if (wanted.length === 0) return text('Ненулевых остатков по такому запросу нет.');

            // Строка регистра — это остаток товара на одном складе; сводных
            // строк здесь нет, поэтому складывать можно прямо.
            const grouped = new Map<string, { total: number; places: Array<{ name: string; qty: number }> }>();
            for (const r of wanted) {
                const acc = grouped.get(r.product) ?? { total: 0, places: [] };
                acc.total += r.quantity;
                acc.places.push({ name: r.warehouse, qty: r.quantity });
                grouped.set(r.product, acc);
            }
            const list = [...grouped.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, args.limit ?? 30);
            const total = [...grouped.values()].reduce((s, g) => s + g.total, 0);

            const lines = list.map(([name, g]) => {
                const places = g.places
                    .sort((a, b) => b.qty - a.qty)
                    .slice(0, 5)
                    .map(pl => `${pl.name}: ${pl.qty.toLocaleString('ru-RU')}`);
                const hidden = g.places.length - 5;
                return (
                    `${name}\n   всего ${g.total.toLocaleString('ru-RU')}` +
                    `\n   ${places.join(', ')}${hidden > 0 ? ` и ещё ${hidden}` : ''}`
                );
            });
            return text(
                `Позиций с остатком: ${grouped.size}, всего единиц: ${total.toLocaleString('ru-RU')}\n\n${lines.join('\n')}`
            );
        })
    );

    server.registerTool(
        'onec_purchases',
        {
            title: '1С: заказы поставщикам',
            description:
                'Что заказано у поставщиков за период: номер, дата, поставщик, сумма и состав заказа по строкам.',
            inputSchema: {
                dateFrom: z.string().describe('Начало периода, ISO-дата: 2026-08-01'),
                dateTo: z.string().describe('Конец периода, ISO-дата: 2026-08-31'),
                withItems: z.boolean().optional().describe('Показать состав заказов. По умолчанию нет.'),
                limit: z.number().int().min(1).max(100).optional().describe('Сколько показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_purchases', async (args, extra) => {
            const denied = denyUnless(actorOf(extra), 'orders');
            if (denied) return fail(denied);
            return renderDocuments({
                entity: 'Document_ЗаказПоставщику',
                dateFrom: args.dateFrom,
                dateTo: args.dateTo,
                limit: args.limit ?? 20,
                withItems: args.withItems === true,
                partnerField: 'Контрагент_Key',
                empty: 'Заказов поставщикам за этот период нет.'
            });
        })
    );

    server.registerTool(
        'onec_production',
        {
            title: '1С: заказы на производство',
            description: 'Что и сколько запущено в производство за период: номер, дата, состояние, состав заказа.',
            inputSchema: {
                dateFrom: z.string().describe('Начало периода, ISO-дата: 2026-08-01'),
                dateTo: z.string().describe('Конец периода, ISO-дата: 2026-08-31'),
                withItems: z.boolean().optional().describe('Показать состав заказов. По умолчанию нет.'),
                limit: z.number().int().min(1).max(100).optional().describe('Сколько показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_production', async (args, extra) => {
            const denied = denyUnless(actorOf(extra), 'orders');
            if (denied) return fail(denied);
            return renderDocuments({
                entity: 'Document_ЗаказНаПроизводство',
                dateFrom: args.dateFrom,
                dateTo: args.dateTo,
                limit: args.limit ?? 20,
                withItems: args.withItems === true,
                empty: 'Заказов на производство за этот период нет.'
            });
        })
    );

    server.registerTool(
        'onec_warehouse',
        {
            title: '1С: движения склада',
            description:
                'Складские операции за период: перемещения между складами, списания, оприходования, инвентаризации.',
            inputSchema: {
                kind: z
                    .enum(['перемещения', 'списания', 'оприходования', 'инвентаризации'])
                    .describe('Какие документы показать'),
                dateFrom: z.string().describe('Начало периода, ISO-дата: 2026-08-01'),
                dateTo: z.string().describe('Конец периода, ISO-дата: 2026-08-31'),
                withItems: z.boolean().optional().describe('Показать состав документов. По умолчанию нет.'),
                limit: z.number().int().min(1).max(100).optional().describe('Сколько показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_warehouse', async (args, extra) => {
            const denied = denyUnless(actorOf(extra), 'orders');
            if (denied) return fail(denied);
            const map = {
                перемещения: 'Document_ПеремещениеЗапасов',
                списания: 'Document_СписаниеЗапасов',
                оприходования: 'Document_ОприходованиеЗапасов',
                инвентаризации: 'Document_ИнвентаризацияЗапасов'
            } as const;
            return renderDocuments({
                entity: map[args.kind],
                dateFrom: args.dateFrom,
                dateTo: args.dateTo,
                limit: args.limit ?? 20,
                withItems: args.withItems === true,
                empty: `Документов «${args.kind}» за этот период нет.`
            });
        })
    );
}

export type { OnecEntity };
