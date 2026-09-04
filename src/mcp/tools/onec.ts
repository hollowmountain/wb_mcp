import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { config } from '../../config.js';
import { inArea } from '../../auth/provider.js';
import {
    ALLOWED_ENTITIES,
    countEntity,
    getOnecStock,
    getOnecStockValue,
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
    СуммаНДС?: number;
}

/**
 * Строка сдельного наряда. Поля называются иначе, чем в товарных документах:
 * не Количество и Сумма, а КоличествоФакт, Расценка и Стоимость. Вид работ
 * лежит в Операция_Key и ссылается на номенклатуру.
 */
interface PieceworkOp {
    Операция_Key?: string;
    Номенклатура_Key?: string;
    КоличествоПлан?: number;
    КоличествоФакт?: number;
    Расценка?: number;
    Стоимость?: number;
    Нормочасы?: number;
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
    // Просим на одну строку больше, чем покажем: так становится видно, что
    // за пределом выборки ещё что-то есть. Без этого сумма по показанным
    // документам выглядела как итог за период, хотя им не была.
    const fetched = await listEntity<DocRow>(config.onec, opts.entity, {
        top: opts.limit + 1,
        filter: `Date ge datetime'${from}' and Date le datetime'${to}' and DeletionMark eq false`,
        orderby: 'Date desc'
    });
    const truncated = fetched.length > opts.limit;
    const rows = truncated ? fetched.slice(0, opts.limit) : fetched;
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

    const head = truncated
        ? `Документов показано: ${rows.length}, но за период их больше` +
          (total > 0 ? `. Сумма ${money(total)} — только по показанным, не итог за период.` : '.') +
          '\nЧтобы увидеть всё, увеличьте limit или сузьте период.'
        : `Документов: ${rows.length}${total > 0 ? `, на сумму ${money(total)}` : ''}`;
    return text(`${head}\n\n${blocks.join('\n')}`);
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
                'onec_stock_value Запасы в деньгах: учётная себестоимость по складам.',
                'onec_specification Из чего сделана продукция: состав материалов и операции.',
                'onec_shipments   Расходные накладные: что и кому отгружено, с ценами.',
                'onec_receipts    Приходные накладные с ценами: что и почём поступило.',
                'onec_piecework   Сдельные наряды: кто из работников что сделал и на сколько.',
                'onec_reference   Эта справка.',
                '',
                '── ЧЕГО В БАЗЕ НЕТ ──',
                '',
                'Начисления зарплаты не ведутся — документ пуст. Но сдельные наряды есть,',
                'и в них видно, кто сколько заработал за день (onec_piecework).',
                'Денежная оценка запасов есть — onec_stock_value, регистр суммового учёта.',
                'Партионного учёта при этом нет, партии пусты.',
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

            const asked = args.limit ?? 20;
            const rows = await listEntity<Product>(config.onec, 'Catalog_Номенклатура', {
                top: asked,
                filter,
                select: 'Ref_Key,Code,Description,Артикул,DeletionMark,IsFolder',
                orderby: 'Description'
            });

            if (rows.length === 0) return text(s ? `По запросу «${s}» в 1С ничего не найдено.` : 'Номенклатура пуста.');
            const mayHaveMore = rows.length >= asked;
            const lines = rows.map(
                (r, i) => `${i + 1}. ${r.Description || dash}\n   код ${r.Code || dash}, артикул ${r.Артикул || dash}`
            );
            return text(
                `Показано: ${rows.length}${mayHaveMore ? ' (возможно, есть ещё — увеличьте limit)' : ''}\n\n${lines.join('\n')}`
            );
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
            const cut = rows.length >= (args.limit ?? 20);
            return text(
                `Показано: ${rows.length}${cut ? ' (возможно, есть ещё — увеличьте limit)' : ''}\n\n${lines.join('\n')}`
            );
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
            const asked = args.limit ?? 30;
            const got = await listEntity<SalesOrder>(config.onec, 'Document_ЗаказПокупателя', {
                top: asked + 1,
                filter: `Date ge datetime'${from}' and Date le datetime'${to}' and DeletionMark eq false`,
                select: 'Ref_Key,Number,Date,Posted,DeletionMark,СуммаДокумента,Контрагент_Key',
                orderby: 'Date desc'
            });

            const cut = got.length > asked;
            const rows = cut ? got.slice(0, asked) : got;
            if (rows.length === 0) return text(`Заказов за ${args.dateFrom} — ${args.dateTo} не найдено.`);
            const total = rows.reduce((s, r) => s + (r.СуммаДокумента ?? 0), 0);
            const lines = rows.map(
                (r, i) =>
                    `${i + 1}. № ${r.Number || dash} от ${day(r.Date)} ${dash} ${money(r.СуммаДокумента)}${r.Posted ? '' : ' (не проведён)'}`
            );
            const head = cut
                ? `Показано заказов: ${rows.length}, но за период их больше. Сумма ${money(total)} — только по показанным.`
                : `Заказов: ${rows.length}, на сумму ${money(total)}`;
            return text(`${head}\n\n${lines.join('\n')}`);
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

            const rows = await getOnecStock(config.onec);
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
            // Общей суммы здесь намеренно нет: у номенклатуры разные единицы
            // измерения, и складывать штуки с килограммами и метрами
            // бессмысленно. Итог имеет смысл только внутри одной позиции.
            const shown = list.length < grouped.size ? ` (показаны ${list.length} с наибольшим остатком)` : '';
            return text(`Позиций с остатком: ${grouped.size}${shown}\n\n${lines.join('\n')}`);
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

    server.registerTool(
        'onec_piecework',
        {
            title: '1С: сдельные наряды',
            description:
                'Сдельные наряды за период: кто из работников что сделал и на какую сумму. ' +
                'По умолчанию за сегодня. Внизу — свод по исполнителям.',
            inputSchema: {
                dateFrom: z.string().optional().describe('Начало периода, ISO-дата. Не указано — сегодня.'),
                dateTo: z.string().optional().describe('Конец периода, ISO-дата. Не указано — то же, что начало.'),
                executor: z.string().optional().describe('Часть фамилии исполнителя'),
                withOperations: z.boolean().optional().describe('Показать операции внутри нарядов'),
                limit: z.number().int().min(1).max(300).optional().describe('Сколько нарядов показать, по умолчанию 50')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_piecework', async (args, extra) => {
            const actor = actorOf(extra);
            if (!onecReady() || !inArea(actor, 'payroll')) {
                return fail('Область «сдельная оплата труда» вам не открыта. Обратитесь к администратору.');
            }
            const today = new Date().toISOString().slice(0, 10);
            const from = (args.dateFrom ?? today).slice(0, 10);
            const to = (args.dateTo ?? args.dateFrom ?? today).slice(0, 10);

            const askedFor = args.limit ?? 50;
            const fetched = await listEntity<DocRow & { Исполнитель?: string; Закрыт?: boolean }>(
                config.onec,
                'Document_СдельныйНаряд',
                {
                    // На одну больше, чем покажем: иначе свод по исполнителям и
                    // сумма посчитались бы по обрезанной выборке и выглядели бы
                    // как итог за период. Для проверки зарплаты это опасно.
                    top: askedFor + 1,
                    filter: `Date ge datetime'${from}T00:00:00' and Date le datetime'${to}T23:59:59' and DeletionMark eq false`,
                    orderby: 'Date desc'
                }
            );
            const truncated = fetched.length > askedFor;
            const rows = truncated ? fetched.slice(0, askedFor) : fetched;
            if (rows.length === 0) return text(`Сдельных нарядов за ${from}${to === from ? '' : ` — ${to}`} нет.`);

            const people = await resolveNames(
                config.onec,
                'Catalog_Сотрудники',
                rows.map(r => String(r.Исполнитель ?? ''))
            );
            const needle = args.executor?.trim().toLowerCase();
            const wanted = needle
                ? rows.filter(r => (people.get(String(r.Исполнитель ?? '')) ?? '').toLowerCase().includes(needle))
                : rows;
            if (wanted.length === 0) return text(`Нарядов по запросу «${args.executor}» нет.`);

            const opsOf = (r: DocRow): PieceworkOp[] => (Array.isArray(r.Операции) ? (r.Операции as PieceworkOp[]) : []);
            const products = args.withOperations
                ? await resolveNames(
                      config.onec,
                      'Catalog_Номенклатура',
                      wanted.flatMap(r => opsOf(r).flatMap(o => [String(o.Операция_Key ?? ''), String(o.Номенклатура_Key ?? '')]))
                  )
                : new Map<string, string>();

            const byPerson = new Map<string, { sum: number; count: number }>();
            for (const r of wanted) {
                const who = people.get(String(r.Исполнитель ?? '')) || '(без исполнителя)';
                const acc = byPerson.get(who) ?? { sum: 0, count: 0 };
                acc.sum += r.СуммаДокумента ?? 0;
                acc.count += 1;
                byPerson.set(who, acc);
            }
            const total = wanted.reduce((s, r) => s + (r.СуммаДокумента ?? 0), 0);
            const notPosted = wanted.filter(r => r.Posted === false).length;

            const svod = [...byPerson.entries()]
                .sort((a, b) => b[1].sum - a[1].sum)
                .map(([who, v]) => `   ${who} ${dash} ${money(v.sum)} (нарядов: ${v.count})`);

            const list = wanted.map(r => {
                const who = people.get(String(r.Исполнитель ?? '')) || '(без исполнителя)';
                const head =
                    `№ ${r.Number || dash} от ${day(r.Date)} ${dash} ${who} ${dash} ${money(r.СуммаДокумента)}` +
                    (r.Posted === false ? ' (не проведён)' : '') +
                    (r.Закрыт === false ? ' (не закрыт)' : '');
                if (!args.withOperations) return head;
                const ops = opsOf(r);
                if (ops.length === 0) return `${head}\n   операций нет`;
                return (
                    head +
                    '\n' +
                    ops
                        .slice(0, 20)
                        .map(o => {
                            const what =
                                products.get(String(o.Операция_Key ?? '')) ||
                                products.get(String(o.Номенклатура_Key ?? '')) ||
                                '(вид работ не указан)';
                            const qty = typeof o.КоличествоФакт === 'number' ? o.КоличествоФакт.toLocaleString('ru-RU') : dash;
                            // Расценку показываем, только если она заполнена: у части
                            // нарядов сумма проставлена напрямую, и «× 0 ₽» читалось бы
                            // как ошибка расчёта, а не как незаполненное поле.
                            const rate = typeof o.Расценка === 'number' && o.Расценка !== 0 ? ` × ${money(o.Расценка)}` : '';
                            const cost = typeof o.Стоимость === 'number' ? ` = ${money(o.Стоимость)}` : '';
                            return `   ${what} ${dash} ${qty}${rate}${cost}`;
                        })
                        .join('\n')
                );
            });

            return text(
                [
                    truncated
                        ? `${from}${to === from ? '' : ` — ${to}`}: показано ${wanted.length} нарядов, но за период их больше.` +
                          `\nСумма ${money(total)} и свод ниже — только по показанным, НЕ итог за период.` +
                          `\nДля полной картины увеличьте limit или возьмите период короче.`
                        : `${from}${to === from ? '' : ` — ${to}`}: нарядов ${wanted.length}, на сумму ${money(total)}` +
                          (notPosted > 0 ? `, из них не проведено ${notPosted}` : ''),
                    '',
                    'По исполнителям:',
                    ...svod,
                    '',
                    ...list
                ].join('\n')
            );
        })
    );

    server.registerTool(
        'onec_receipts',
        {
            title: '1С: приходные накладные с ценами',
            description:
                'Что и почём поступило на склад за период: поставщик, номенклатура, количество, цена и сумма по строкам. ' +
                'Партионный учёт в базе не ведётся, поэтому денежную оценку запасов собирают именно отсюда.',
            inputSchema: {
                dateFrom: z.string().describe('Начало периода, ISO-дата: 2026-08-01'),
                dateTo: z.string().describe('Конец периода, ISO-дата: 2026-08-31'),
                search: z.string().optional().describe('Часть названия номенклатуры'),
                limit: z.number().int().min(1).max(100).optional().describe('Сколько накладных показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_receipts', async (args, extra) => {
            const actor = actorOf(extra);
            if (!onecReady() || !inArea(actor, 'supply')) {
                return fail('Область «поставщики и закупочные цены» вам не открыта. Обратитесь к администратору.');
            }
            const from = args.dateFrom.slice(0, 10);
            const to = args.dateTo.slice(0, 10);
            const asked = args.limit ?? 20;
            const got = await listEntity<DocRow>(config.onec, 'Document_ПриходнаяНакладная', {
                top: asked + 1,
                filter: `Date ge datetime'${from}T00:00:00' and Date le datetime'${to}T23:59:59' and DeletionMark eq false and Posted eq true`,
                orderby: 'Date desc'
            });
            const cut = got.length > asked;
            const rows = cut ? got.slice(0, asked) : got;
            if (rows.length === 0) return text(`Проведённых приходных накладных за ${from} — ${to} нет.`);

            const partners = await resolveNames(
                config.onec,
                'Catalog_Контрагенты',
                rows.map(r => String(r.Контрагент_Key ?? ''))
            );
            const products = await resolveNames(
                config.onec,
                'Catalog_Номенклатура',
                rows.flatMap(r => itemsOf(r).map(i => String(i.Номенклатура_Key ?? '')))
            );
            const needle = args.search?.trim().toLowerCase();

            const blocks: string[] = [];
            let shown = 0;
            for (const r of rows) {
                const items = itemsOf(r).filter(i => {
                    if (!needle) return true;
                    const n = products.get(String(i.Номенклатура_Key ?? '')) ?? '';
                    return n.toLowerCase().includes(needle);
                });
                if (needle && items.length === 0) continue;
                shown += 1;
                const who = partners.get(String(r.Контрагент_Key ?? ''));
                const head =
                    `№ ${r.Number || dash} от ${day(r.Date)}` +
                    (who ? ` ${dash} ${who}` : '') +
                    ` ${dash} ${money(r.СуммаДокумента)}`;
                const lines = items.slice(0, 20).map(i => {
                    const name = products.get(String(i.Номенклатура_Key ?? '')) || '(без названия)';
                    const qty = typeof i.Количество === 'number' ? i.Количество.toLocaleString('ru-RU') : dash;
                    const price = typeof i.Цена === 'number' ? `${money(i.Цена)} за ед.` : dash;
                    return `   ${name} ${dash} ${qty} × ${price} = ${money(i.Сумма)}`;
                });
                const more = items.length > 20 ? `\n   и ещё ${items.length - 20} строк` : '';
                blocks.push(`${head}\n${lines.join('\n')}${more}`);
            }
            if (blocks.length === 0) return text(`По запросу «${args.search}» поступлений не найдено.`);
            const total = rows.reduce((s, r) => s + (r.СуммаДокумента ?? 0), 0);
            const head = cut
                ? `Показано накладных: ${shown}, но за период их больше` +
                  (needle ? '.' : `. Сумма ${money(total)} — только по показанным.`)
                : `Накладных: ${shown}${needle ? '' : `, на сумму ${money(total)}`}`;
            return text(`${head}\n\n${blocks.join('\n\n')}`);
        })
    );

    server.registerTool(
        'onec_stock_value',
        {
            title: '1С: запасы в деньгах',
            description:
                'Денежная оценка запасов из регистра суммового учёта: сколько лежит на своих складах и ' +
                'сколько передано контрагентам, с НДС и без. Это учётная себестоимость предприятия.',
            inputSchema: {
                search: z.string().optional().describe('Часть названия номенклатуры'),
                where: z
                    .enum(['свои склады', 'у контрагентов', 'везде'])
                    .optional()
                    .describe('Что показать. По умолчанию свои склады.'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько позиций показать, по умолчанию 25')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_stock_value', async (args, extra) => {
            const actor = actorOf(extra);
            if (!onecReady() || !inArea(actor, 'money')) {
                return fail('Область «себестоимость, прибыль, реклама» вам не открыта. Обратитесь к администратору.');
            }
            const rows = await getOnecStockValue(config.onec);
            if (rows.length === 0) return text('Регистр суммового учёта запасов пуст.');

            const own = rows.filter(r => !r.atPartner);
            const atPartners = rows.filter(r => r.atPartner);
            const totals = (list: typeof rows) => ({
                sum: list.reduce((s, r) => s + r.sum, 0),
                noVat: list.reduce((s, r) => s + r.sumNoVat, 0),
                positions: new Set(list.map(r => r.productKey)).size
            });
            const o = totals(own);
            const p = totals(atPartners);

            const where = args.where ?? 'свои склады';
            const chosen = where === 'у контрагентов' ? atPartners : where === 'везде' ? rows : own;
            const needle = args.search?.trim().toLowerCase();
            const wanted = needle ? chosen.filter(r => r.product.toLowerCase().includes(needle)) : chosen;

            const byProduct = new Map<string, { name: string; qty: number; sum: number; noVat: number }>();
            for (const r of wanted) {
                const acc = byProduct.get(r.productKey) ?? { name: r.product, qty: 0, sum: 0, noVat: 0 };
                acc.qty += r.quantity;
                acc.sum += r.sum;
                acc.noVat += r.sumNoVat;
                byProduct.set(r.productKey, acc);
            }
            const list = [...byProduct.values()].sort((a, b) => b.sum - a.sum).slice(0, args.limit ?? 25);

            const negatives = rows.filter(r => r.sum < 0);
            const head = [
                `ЗАПАСЫ В ДЕНЬГАХ (учётная себестоимость)`,
                '',
                `Свои склады:     ${money(o.sum)}   без НДС ${money(o.noVat)}   позиций ${o.positions}`,
                `У контрагентов:  ${money(p.sum)}   без НДС ${money(p.noVat)}   позиций ${p.positions}`
            ];
            // Складывать эти две части в одно число нельзя, пока по второй
            // сумма без НДС больше суммы с НДС: итог получился бы обманчивым.
            if (p.noVat > p.sum) {
                head.push(
                    '',
                    'Внимание: по запасам у контрагентов сумма без НДС больше суммы с НДС,',
                    'чего быть не может. Общий итог не показываю — сначала стоит разобраться',
                    'в учёте этой части. По своим складам расхождения нет.'
                );
            } else {
                head.push('', `Всего: ${money(o.sum + p.sum)}   без НДС ${money(o.noVat + p.noVat)}`);
            }
            if (negatives.length > 0) {
                head.push(
                    '',
                    `Строк с отрицательной суммой: ${negatives.length} на ${money(negatives.reduce((s, r) => s + r.sum, 0))}.`
                );
            }

            if (list.length === 0) return text([...head, '', `По запросу «${args.search}» ничего нет.`].join('\n'));
            const body = list.map(
                v => `${v.name}\n   ${v.qty.toLocaleString('ru-RU')} ед. на ${money(v.sum)} (без НДС ${money(v.noVat)})`
            );
            return text(
                [...head, '', `── ${where}, самые дорогие ──`, '', ...body].join('\n')
            );
        })
    );

    server.registerTool(
        'onec_shipments',
        {
            title: '1С: расходные накладные',
            description:
                'Что и кому отгружено за период: покупатель, номенклатура, количество, цена и сумма по строкам. ' +
                'Это учётные отгрузки предприятия, не заказы маркетплейса.',
            inputSchema: {
                dateFrom: z.string().describe('Начало периода, ISO-дата: 2026-08-01'),
                dateTo: z.string().describe('Конец периода, ISO-дата: 2026-08-31'),
                withItems: z.boolean().optional().describe('Показать состав отгрузок'),
                limit: z.number().int().min(1).max(100).optional().describe('Сколько показать, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_shipments', async (args, extra) => {
            const denied = denyUnless(actorOf(extra), 'orders');
            if (denied) return fail(denied);
            return renderDocuments({
                entity: 'Document_РасходнаяНакладная',
                dateFrom: args.dateFrom,
                dateTo: args.dateTo,
                limit: args.limit ?? 20,
                withItems: args.withItems === true,
                partnerField: 'Контрагент_Key',
                empty: 'Расходных накладных за этот период нет.'
            });
        })
    );

    server.registerTool(
        'onec_specification',
        {
            title: '1С: спецификации продукции',
            description:
                'Из чего сделана готовая продукция: состав материалов с количествами и операции с нормами времени. ' +
                'Нужна, чтобы посчитать материальную себестоимость изделия.',
            inputSchema: {
                search: z.string().optional().describe('Часть названия спецификации или продукции'),
                withOperations: z.boolean().optional().describe('Показать ещё и операции с нормами времени'),
                limit: z.number().int().min(1).max(50).optional().describe('Сколько спецификаций показать, по умолчанию 10')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('onec_specification', async (args, extra) => {
            const denied = denyUnless(actorOf(extra), 'catalog');
            if (denied) return fail(denied);

            const needle = args.search?.trim().toLowerCase();
            const specs = await listEntity<{
                Ref_Key: string;
                Description?: string;
                Owner_Key?: string;
                Недействителен?: boolean;
                Состав?: Array<{
                    ТипСтрокиСостава?: string;
                    Номенклатура_Key?: string;
                    Количество?: number;
                    КоличествоПродукции?: number;
                }>;
                Операции?: Array<{
                    Операция_Key?: string;
                    Количество?: number;
                    НормаВремени?: number;
                    Описание?: string;
                }>;
            }>(config.onec, 'Catalog_Спецификации', {
                top: needle ? 200 : (args.limit ?? 10),
                filter: 'DeletionMark eq false',
                orderby: 'Description'
            });

            const wanted = (needle ? specs.filter(s => (s.Description ?? '').toLowerCase().includes(needle)) : specs).slice(
                0,
                args.limit ?? 10
            );
            if (wanted.length === 0) {
                return text(needle ? `Спецификаций по запросу «${args.search}» нет.` : 'Спецификаций нет.');
            }

            const names = await resolveNames(
                config.onec,
                'Catalog_Номенклатура',
                wanted.flatMap(s => [
                    String(s.Owner_Key ?? ''),
                    ...(s.Состав ?? []).map(i => String(i.Номенклатура_Key ?? '')),
                    ...(args.withOperations ? (s.Операции ?? []).map(o => String(o.Операция_Key ?? '')) : [])
                ])
            );

            const blocks = wanted.map(s => {
                const product = names.get(String(s.Owner_Key ?? '')) || '';
                const head =
                    `${s.Description || '(без названия)'}` +
                    (product ? `\n   продукция: ${product}` : '') +
                    (s.Недействителен ? '   (недействительна)' : '');
                const rows = (s.Состав ?? []).slice(0, 30).map(i => {
                    const what = names.get(String(i.Номенклатура_Key ?? '')) || '(без названия)';
                    const qty = typeof i.Количество === 'number' ? i.Количество.toLocaleString('ru-RU') : dash;
                    const per = typeof i.КоличествоПродукции === 'number' && i.КоличествоПродукции !== 1
                        ? ` на ${i.КоличествоПродукции.toLocaleString('ru-RU')} ед. продукции`
                        : '';
                    const kind = i.ТипСтрокиСостава && i.ТипСтрокиСостава !== 'Материал' ? ` [${i.ТипСтрокиСостава}]` : '';
                    return `   ${what}${kind} ${dash} ${qty}${per}`;
                });
                const more = (s.Состав ?? []).length > 30 ? `\n   и ещё ${(s.Состав ?? []).length - 30} строк` : '';
                const body = rows.length > 0 ? `${head}\n${rows.join('\n')}${more}` : `${head}\n   состав пуст`;
                if (!args.withOperations) return body;
                const ops = s.Операции ?? [];
                if (ops.length === 0) return `${body}\n   операций не задано`;
                const opLines = ops.slice(0, 20).map(o => {
                    const what = names.get(String(o.Операция_Key ?? '')) || o.Описание || '(операция не указана)';
                    const qty = typeof o.Количество === 'number' ? ` ${dash} ${o.Количество.toLocaleString('ru-RU')}` : '';
                    const norm =
                        typeof o.НормаВремени === 'number' && o.НормаВремени !== 0
                            ? `, норма времени ${o.НормаВремени.toLocaleString('ru-RU')}`
                            : '';
                    return `   ${what}${qty}${norm}`;
                });
                return `${body}\n   ── операции ──\n${opLines.join('\n')}`;
            });

            return text(`Спецификаций: ${wanted.length}\n\n${blocks.join('\n\n')}`);
        })
    );
}

export type { OnecEntity };
