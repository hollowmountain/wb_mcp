import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { allowedCabinets, hasAnyCabinet, resolveCabinets } from '../../access.js';
import type { Actor } from '../../auth/provider.js';
import { config } from '../../config.js';
import {
    mskDay,
    readSnapshot,
    snapshotDays,
    type OzonStockItem,
    type Snapshot,
    type SnapshotKind,
    type WbBalance,
    type WbStockItem
} from '../../snapshots.js';
import { actorOf, guarded, text } from './common.js';
import { resolve as resolveOzon } from './ozon.js';

/**
 * Снимки остатков и баланса на дату — для баланса в отчёте «3 Формы».
 * Сами снимки делает сервер каждую ночь, см. snapshots.ts.
 */

const MSK_MS = 3 * 60 * 60 * 1000;
const FIRST_DAY = '2026-10-31';

const n = (v: number): string => v.toLocaleString('ru-RU');
const rub = (v: number): string =>
    v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
const ru = (day: string): string => day.split('-').reverse().join('.');
const mskTime = (ms: number): string => {
    const iso = new Date(ms + MSK_MS).toISOString();
    return `${ru(iso.slice(0, 10))} ${iso.slice(11, 16)}`;
};

/**
 * Что значит снимок. Ночной снимок — это остаток на конец прошлого дня;
 * снятый днём (после перезапуска или самый первый) — только на момент снятия.
 * Путать их нельзя: на 1-е число баланс собирают именно по концу месяца.
 */
function meaning(s: Snapshot<unknown>): string {
    const takenDay = mskDay(new Date(s.takenAt));
    const minute = Math.floor(((s.takenAt + MSK_MS) % 86_400_000) / 60_000);
    if (takenDay === s.day && minute < 120) {
        const prev = mskDay(new Date(Date.parse(`${s.day}T12:00:00Z`) - 86_400_000));
        return `снят ${mskTime(s.takenAt)} по Москве — это остаток на конец ${ru(prev)}`;
    }
    return `снят ${mskTime(s.takenAt)} по Москве — остаток на этот момент, а не на начало дня`;
}

function missing(kind: SnapshotKind, cabinet: string, day: string): string {
    const days = snapshotDays(kind, cabinet);
    if (days.length === 0) return `Снимков по этому кабинету ещё нет: сервер делает их каждую ночь в 00:05 по Москве.`;
    return (
        `Снимка на ${ru(day)} нет. Есть с ${ru(days[0]!)} по ${ru(days[days.length - 1]!)} (${days.length} дн.). ` +
        (day < FIRST_DAY ? 'Раньше 31.10.2026 снимков нет и не будет: площадки не отдают остаток задним числом.' : '')
    );
}

const pageOf = <T>(rows: T[], offset: number, limit: number): { shown: T[]; tail: string } => {
    const shown = rows.slice(offset, offset + limit);
    const end = offset + shown.length;
    const tail =
        end < rows.length ? `\nПоказаны ${offset + 1}–${end} из ${rows.length}. Дальше: offset=${end}.` : '';
    return { shown, tail };
};

/** Подписи счётчиков Ozon. Код поля показываем всегда: смысл части полей Ozon не документирует внятно. */
const OZON_LABELS: Record<string, string> = {
    available_stock_count: 'доступно к продаже',
    transit_stock_count: 'в пути',
    return_from_customer_stock_count: 'возвращаются от покупателей',
    return_to_seller_stock_count: 'готовятся к вывозу продавцу',
    stock_defect_stock_count: 'брак на складе',
    transit_defect_stock_count: 'брак в пути',
    expiring_stock_count: 'истекает срок годности',
    excess_stock_count: 'излишки',
    waiting_docs_stock_count: 'ждут документов'
};
const OZON_COLUMNS = ['available_stock_count', 'transit_stock_count', 'return_from_customer_stock_count'] as const;

const dateArg = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
        'Дата снимка ГГГГ-ММ-ДД по Москве. Снимок на 2026-11-01 снят в начале суток — это остаток на конец 31.10. Не указана — сегодняшний.'
    );
const offsetArg = z.number().int().min(0).optional().describe('С какой строки показывать, по умолчанию 0');
const limitArg = z.number().int().min(1).max(500).optional().describe('Сколько строк на кабинет, по умолчанию 100');

export function registerSnapshotTools(server: McpServer, actor: Actor): void {
    // Описание собирается при подключении каждого человека, и allowedCabinets
    // бросает, если кабинетов WB у него нет — тогда WB-инструменты просто не нужны.
    if (hasAnyCabinet(actor)) registerWbSnapshotTools(server, actor);
    registerOzonSnapshotTool(server, actor);
}

function registerWbSnapshotTools(server: McpServer, actor: Actor): void {
    server.registerTool(
        'wb_stock_snapshot',
        {
            title: 'WB: остатки на дату (снимок)',
            description:
                'Остатки Wildberries на дату из ночного снимка сервера: по артикулу — на складах WB, в пути до получателей, ' +
                'в пути возвраты на склад, шт. Для баланса «3 Формы» на 1-е число бери снимок с датой 1-го: он снят в 00:05 ' +
                'и равен остатку на конец прошлого месяца. Снимки ведутся с 31.10.2026, раньше данных нет — WB не отдаёт остаток задним числом. ' +
                `Кабинеты: ${allowedCabinets(actor).map(c => c.slug).join(', ')}.`,
            inputSchema: {
                cabinet: z.string().optional().describe('Кабинет WB. Не указан — по всем доступным'),
                date: dateArg,
                groupBy: z
                    .enum(['article', 'size'])
                    .optional()
                    .describe('article — по артикулу, размеры сложены (по умолчанию); size — каждый размер отдельной строкой'),
                offset: offsetArg,
                limit: limitArg
            },
            annotations: { readOnlyHint: true }
        },
        guarded('wb_stock_snapshot', async (args, extra) => {
            const day = args.date ?? mskDay();
            const blocks = resolveCabinets(actorOf(extra), args.cabinet).map(cabinet => {
                const head = `━━ ${cabinet.slug} · ${cabinet.label} ━━`;
                const snap = readSnapshot<WbStockItem[]>('wb_stock', cabinet.slug, day);
                if (!snap) return `${head}\n${missing('wb_stock', cabinet.slug, day)}`;

                let rows = snap.data;
                if ((args.groupBy ?? 'article') === 'article') {
                    const by = new Map<number, WbStockItem>();
                    for (const r of rows) {
                        const acc = by.get(r.nmId);
                        if (!acc) by.set(r.nmId, { ...r, size: '', barcode: '', warehouses: [] });
                        else {
                            acc.onHand += r.onHand;
                            acc.toCustomers += r.toCustomers;
                            acc.returning += r.returning;
                        }
                    }
                    rows = [...by.values()];
                }
                rows = rows
                    .filter(r => r.onHand || r.toCustomers || r.returning)
                    .sort((a, b) => b.onHand + b.toCustomers - (a.onHand + a.toCustomers));
                const sum = (f: (r: WbStockItem) => number) => snap.data.reduce((s, r) => s + f(r), 0);
                const { shown, tail } = pageOf(rows, args.offset ?? 0, args.limit ?? 100);
                const lines = shown.map(
                    r =>
                        `${r.article || '—'}${r.size && r.size !== '0' ? ` (${r.size})` : ''} | ${r.nmId} | ${n(r.onHand)} | ${n(r.toCustomers)} | ${n(r.returning)}`
                );
                return [
                    head,
                    `Снимок на ${ru(snap.day)}, ${meaning(snap)}.`,
                    `Строк в снимке: ${snap.rows}, с ненулевым остатком: ${rows.length}.`,
                    `Итого: на складах ${n(sum(r => r.onHand))} шт · в пути до получателей ${n(sum(r => r.toCustomers))} · в пути возвраты ${n(sum(r => r.returning))}`,
                    '',
                    'Артикул продавца | nmId | на складах | в пути до получателей | в пути возвраты',
                    ...lines
                ].join('\n') + tail;
            });
            return text(blocks.join('\n\n'));
        })
    );

    server.registerTool(
        'wb_balance_snapshot',
        {
            title: 'WB: баланс на дату (снимок)',
            description:
                'Баланс продавца Wildberries и сумма к выводу на дату из ночного снимка сервера, ₽. Для «Не выведено с МП» ' +
                'на 1-е число бери снимок с датой 1-го: он снят в 00:05 — это баланс на конец прошлого месяца. Снимки с 31.10.2026.',
            inputSchema: {
                cabinet: z.string().optional().describe('Кабинет WB. Не указан — по всем доступным'),
                date: dateArg
            },
            annotations: { readOnlyHint: true }
        },
        guarded('wb_balance_snapshot', async (args, extra) => {
            const day = args.date ?? mskDay();
            const lines = resolveCabinets(actorOf(extra), args.cabinet).map(cabinet => {
                const snap = readSnapshot<WbBalance>('wb_balance', cabinet.slug, day);
                if (!snap) return `${cabinet.slug} · ${cabinet.label}: ${missing('wb_balance', cabinet.slug, day)}`;
                const b = snap.data;
                return (
                    `${cabinet.slug} · ${cabinet.label}: баланс ${rub(b.current)}, к выводу ${rub(b.forWithdraw)}` +
                    `${b.currency !== 'RUB' ? ` (валюта ${b.currency})` : ''} — ${meaning(snap)}`
                );
            });
            return text(`Баланс WB на ${ru(day)}\n\n${lines.join('\n')}`);
        })
    );
}

function registerOzonSnapshotTool(server: McpServer, actor: Actor): void {
    if (config.ozon.length === 0) return;
    try {
        resolveOzon(actor);
    } catch {
        return;
    }

    server.registerTool(
        'ozon_stock_snapshot',
        {
            title: 'Ozon: остатки на дату (снимок)',
            description:
                'Остатки Ozon на дату из ночного снимка сервера: по артикулу/SKU — доступно к продаже на складах Ozon, в пути, ' +
                'возвращаются от покупателей, шт; в шапке — итоги по всем счётчикам Ozon с их кодами. Для баланса на 1-е число бери ' +
                'снимок с датой 1-го (снят в 00:05 — остаток на конец прошлого месяца). Снимки с 31.10.2026. Кабинеты с приставкой oz-.',
            inputSchema: {
                cabinet: z.string().optional().describe('Кабинет Ozon: oz-harbez, oz-pixeltap, oz-beauty. Не указан — по всем доступным'),
                date: dateArg,
                groupBy: z
                    .enum(['sku', 'warehouse'])
                    .optional()
                    .describe('sku — по товару, склады сложены (по умолчанию); warehouse — товар × склад'),
                offset: offsetArg,
                limit: limitArg
            },
            annotations: { readOnlyHint: true }
        },
        guarded('ozon_stock_snapshot', async (args, extra) => {
            const day = args.date ?? mskDay();
            const blocks = resolveOzon(actorOf(extra), args.cabinet).map(cabinet => {
                const head = `━━ ${cabinet.slug} ━━`;
                const snap = readSnapshot<OzonStockItem[]>('ozon_stock', cabinet.slug, day);
                if (!snap) return `${head}\n${missing('ozon_stock', cabinet.slug, day)}`;

                const totals: Record<string, number> = {};
                for (const r of snap.data) for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] ?? 0) + v;

                let rows = snap.data;
                if ((args.groupBy ?? 'sku') === 'sku') {
                    const by = new Map<number, OzonStockItem>();
                    for (const r of rows) {
                        const acc = by.get(r.sku);
                        if (!acc) by.set(r.sku, { ...r, warehouse: '', cluster: '', counts: { ...r.counts } });
                        else for (const [k, v] of Object.entries(r.counts)) acc.counts[k] = (acc.counts[k] ?? 0) + v;
                    }
                    rows = [...by.values()];
                }
                const main = (r: OzonStockItem) => OZON_COLUMNS.reduce((s, k) => s + (r.counts[k] ?? 0), 0);
                rows = rows.filter(r => main(r) > 0).sort((a, b) => main(b) - main(a));
                const { shown, tail } = pageOf(rows, args.offset ?? 0, args.limit ?? 100);
                const lines = shown.map(
                    r =>
                        `${r.article || '—'} | ${r.sku}${r.warehouse ? ` | ${r.warehouse}` : ''} | ` +
                        OZON_COLUMNS.map(k => n(r.counts[k] ?? 0)).join(' | ')
                );
                const totalLines = Object.entries(totals)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => `   ${OZON_LABELS[k] ? `${OZON_LABELS[k]} (${k})` : k}: ${n(v)}`);
                return [
                    head,
                    `Снимок на ${ru(snap.day)}, ${meaning(snap)}.`,
                    `Строк «товар × склад» в снимке: ${snap.rows}. Итоги по всем счётчикам Ozon, шт:`,
                    ...totalLines,
                    '',
                    `Артикул | SKU${(args.groupBy ?? 'sku') === 'warehouse' ? ' | склад' : ''} | доступно к продаже | в пути | возвращаются от покупателей`,
                    ...lines
                ].join('\n') + tail;
            });
            return text(blocks.join('\n\n'));
        })
    );
}
