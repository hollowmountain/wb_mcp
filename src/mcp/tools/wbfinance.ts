/**
 * Финансы Wildberries для ежемесячного отчёта «3 Формы»: реализация, платное
 * хранение, реклама. Только чтение, область money.
 *
 * Ответы — агрегаты, а не строки: детализация за месяц — около ста тысяч
 * строк, а через Claude проходит только текст. Поэтому сервер сам выкачивает
 * всё и отдаёт таблицу до 30 КБ: вверху период, кабинет, сколько строк было в
 * источнике и итог, ниже разрез. Длинную таблицу листают offset/limit, и ответ
 * всегда говорит, какие строки показаны, — молча обрезанный хвост здесь хуже
 * отказа: по нему соберут P&L.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { hasAnyCabinet, resolveCabinets } from '../../access.js';
import type { Actor } from '../../auth/provider.js';
import { logger } from '../../logger.js';
import type { Cabinet } from '../../wb/cabinets.js';
import {
    addGroupMetrics,
    addGroupRaw,
    adSpendClosed,
    COUNT_METRICS,
    daysInclusive,
    emptyMetrics,
    FinanceLoading,
    loadAdSpend,
    loadPaidStorage,
    loadRealization,
    METRICS,
    mondayOf,
    realizationClosed,
    storageClosed,
    type FinanceSnapshot,
    type Metric,
    type Metrics,
    type AdSpendData,
    type RealizationData,
    type RealizationGroup,
    type StorageData
} from '../../wb/finance.js';
import { actorOf, explainError, fail, guarded, text, type ToolResult } from './common.js';

/** Предел ответа по ТЗ. Считаем в байтах UTF-8: кириллица — два байта. */
const MAX_BYTES = 30_000;
/** Сколько вызов ждёт загрузку, прежде чем ответить «ещё идёт». */
const WAIT_MS = 40_000;
/** Длиннее квартала не берём: месяц детализации — уже сто тысяч строк. */
const MAX_DAYS = 93;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateArg = (what: string) => z.string().regex(ISO_DATE, 'Дата в виде 2026-08-03').describe(what);

const cabinetArg = z
    .string()
    .optional()
    .describe('Кабинет Wildberries: harbez, pixeltap, beauty… Не указан — по всем доступным, каждый своим блоком.');

const offsetArg = z.number().int().min(0).optional().describe('С какой строки таблицы показывать, по умолчанию 0');
const limitArg = z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Сколько строк таблицы показать, по умолчанию ${DEFAULT_LIMIT}, максимум ${MAX_LIMIT}. Итоги — всегда по всем строкам.`);

// ─── Оформление ──────────────────────────────────────────────────────────────

/**
 * Рубли с двумя знаками, точка — десятичный разделитель: так их без ошибок
 * переносят в таблицу. Ноль — просто «0»: в широких таблицах их большинство,
 * и «0.00» съедало бы место, отведённое под строки.
 */
function money(v: number): string {
    const r = Math.round(v * 100) / 100;
    return r === 0 ? '0' : r.toFixed(2);
}

const count = (v: number): string => String(Math.round(v));

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

const mskStamp = (ms: number): string => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

function originLine(snap: FinanceSnapshot<unknown>, closed: boolean): string {
    const age = Math.round((Date.now() - snap.fetchedAt) / 60_000);
    const when =
        snap.origin === 'cache'
            ? `из кэша сервера, выгружено с WB ${mskStamp(snap.fetchedAt)} по Москве`
            : age === 0
              ? 'выгружено с WB только что'
              : `выгружено с WB ${age} мин назад`;
    return closed ? `Данные: ${when}. Период закрыт.` : `Данные: ${when}. Период ещё открыт — WB может дописать строки.`;
}

/**
 * Таблица в пределах бюджета байт. Строки с offset, не больше limit и пока
 * влезает в бюджет. Подвал говорит, какие строки показаны и как взять остальные.
 */
function table(head: string[], rows: string[][], offset: number, limit: number, budget: number): string {
    const lines = [head.join(' | ')];
    let used = bytes(lines[0]!) + 1;
    const reserve = 200; // на подвал
    let shown = 0;
    for (let i = offset; i < rows.length && shown < limit; i++) {
        const line = rows[i]!.join(' | ');
        const size = bytes(line) + 1;
        if (used + size + reserve > budget && shown > 0) break;
        lines.push(line);
        used += size;
        shown++;
    }
    const end = offset + shown;
    if (rows.length === 0) lines.push('(строк нет)');
    else if (offset >= rows.length) lines.push(`(offset ${offset} за концом таблицы: в ней ${rows.length} строк)`);
    else if (end < rows.length || offset > 0) {
        const more = end < rows.length ? ` Следующие: offset=${end}.` : '';
        lines.push(`Показаны строки ${offset + 1}–${end} из ${rows.length}.${more}`);
    } else lines.push(`Строк в таблице: ${rows.length}, показаны все.`);
    return lines.join('\n');
}

/** Ответ «загрузка ещё идёт»: не ошибка, а честное «сколько уже есть и когда повторить». */
function loadingText(e: FinanceLoading, what: string, retry: string): string {
    const minutes = Math.max(1, Math.round((Date.now() - e.startedAt) / 60_000));
    return [
        `${what}: данные ещё загружаются с WB (идёт ${minutes} мин): ${e.progress}.`,
        'Загрузка продолжается на сервере. Повторите этот же вызов ' + retry + ' — ответ придёт из готовых данных.',
        'Цифр по неполной выгрузке не показываю: итог был бы занижен.'
    ].join('\n');
}

function checkPeriod(from: string, to: string): string | null {
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return 'Не удалось разобрать даты периода.';
    if (from > to) return `Начало периода ${from} позже конца ${to}.`;
    const days = daysInclusive(from, to);
    if (days > MAX_DAYS) return `Период ${days} дн. — длиннее ${MAX_DAYS}. Запросите по месяцам.`;
    return null;
}

/**
 * Прогон по кабинетам. Кабинеты — разные продавцы с отдельными лимитами WB,
 * поэтому параллельно. Бюджет ответа делим поровну, чтобы итог не превысил 30 КБ.
 */
async function overCabinets(
    actor: Actor,
    slug: string | undefined,
    run: (cabinet: Cabinet, budget: number) => Promise<string>
): Promise<ToolResult> {
    const cabinets = resolveCabinets(actor, slug);
    const budget = Math.floor(MAX_BYTES / cabinets.length) - 100;
    let failed = 0;
    const blocks = await Promise.all(
        cabinets.map(async cabinet => {
            const head = cabinets.length === 1 ? '' : `━━ Кабинет ${cabinet.slug} (${cabinet.label}) ━━\n`;
            try {
                return head + (await run(cabinet, budget));
            } catch (e) {
                failed++;
                logger.warn({ cabinet: cabinet.slug, err: e instanceof Error ? e.message.slice(0, 300) : String(e) }, 'cabinet failed');
                return `${head}Ошибка: ${explainError(e)}`;
            }
        })
    );
    const result = text(blocks.join('\n\n'));
    return failed === cabinets.length ? { ...result, isError: true, sourceFailed: true } : result;
}

// ─── Реализация ──────────────────────────────────────────────────────────────

/** Подписи метрик для шапки: имя как в ТЗ — по нему Claude сверяет формулы. */
const METRIC_NOTES: Record<Metric, string> = {
    revenue: 'выручка',
    price_after_spp: 'после СПП',
    for_pay: 'к перечислению за товар',
    commission: 'комиссия',
    acquiring: 'эквайринг',
    logistics: 'логистика',
    penalties: 'штрафы',
    storage_fee: 'хранение',
    deduction: 'удержания',
    acceptance: 'платная приёмка',
    additional_payment: 'доплаты',
    rebill_logistic_cost: 'возмещение издержек по перевозке',
    cashback_amount: 'баллы лояльности',
    cashback_discount: 'компенсация скидки лояльности',
    cashback_commission_change: 'стоимость участия в лояльности',
    installment_cofinancing: 'софинансирование рассрочки',
    sales_cnt: 'продажи, шт',
    deliveries_cnt: 'доставок, шт',
    deliveries_to_client_cnt: 'к клиенту, шт'
};

const fmtMetric = (m: Metric, v: number): string => (COUNT_METRICS.has(m) ? count(v) : money(v));

const REPORT_TYPES: Record<number, string> = { 1: 'основной', 2: 'выкуп' };

const SIGNS_NOTE =
    'Знаки: доход «+», расходы «−» (commission, acquiring, logistics, penalties). ' +
    'storage_fee, deduction, acceptance, additional_payment, rebill_logistic_cost и поля лояльности — как в отчёте WB: ' +
    'удержание положительным числом, в P&L его вычитают.';

type GroupBy = 'report' | 'sku' | 'report_sku' | 'operation' | 'deduction';

function summarize(groups: RealizationGroup[], fields: string[]): Metrics {
    const total = emptyMetrics();
    for (const g of groups) addGroupMetrics(total, g, fields);
    return total;
}

function realizationText(
    cabinet: Cabinet,
    from: string,
    to: string,
    snap: FinanceSnapshot<RealizationData>,
    args: { groupBy: GroupBy; mode: 'metrics' | 'raw'; offset: number; limit: number },
    budget: number
): string {
    const { fields, reports, groups } = snap.data;
    const closed = realizationClosed(to);
    const reportById = new Map(reports.map(r => [r.id, r]));
    const total = summarize(groups, fields);

    const kinds = new Map<number, number>();
    for (const r of reports) kinds.set(r.type, (kinds.get(r.type) ?? 0) + 1);
    const kindsText = [...kinds.entries()].map(([t, n]) => `${REPORT_TYPES[t] ?? `тип ${t}`} ${n}`).join(', ');

    const head: string[] = [
        `Отчёты WB о реализации — кабинет ${cabinet.slug} (${cabinet.label}), строки с датой ${from} — ${to}`,
        `Источник: ${reports.length} отч.${kindsText ? ` (${kindsText})` : ''}, ${snap.sourceRows} строк детализации. ${originLine(snap, closed)}`
    ];

    // Отчёт, чья неделя вылезает за период, попал не целиком: WB режет по дате строки.
    const partial = reports.filter(r => r.dateFrom < from || r.dateTo > to);
    if (partial.length > 0) {
        head.push(
            `⚠ Неделя этих отчётов выходит за период, они вошли частично: ${partial.map(r => `${r.id} (${r.dateFrom}—${r.dateTo})`).join(', ')}. ` +
                'Чтобы брать отчёты целиком, задавайте период по неделям пн–вс.'
        );
    }

    const shownMetrics = METRICS.filter(m => Math.round(total[m] * 100) !== 0);

    if (args.mode === 'raw') {
        // Суммы всех числовых полей по типу документа × обоснованию — для сверок
        // и чтобы заметить новые поля WB. Имена полей — как в API WB.
        const byOp = new Map<string, { docType: string; oper: string; rows: number; sums: Map<string, number> }>();
        for (const g of groups) {
            const key = `${g.docType}\u0001${g.oper}`;
            let cur = byOp.get(key);
            if (!cur) {
                cur = { docType: g.docType, oper: g.oper, rows: 0, sums: new Map() };
                byOp.set(key, cur);
            }
            cur.rows += g.rows;
            addGroupRaw(cur.sums, g, fields);
        }
        const ops = [...byOp.values()].sort((a, b) => b.rows - a.rows);
        head.push(`Режим raw: суммы всех числовых полей отчёта (имена как в API WB) по типу документа × обоснованию оплаты; групп: ${ops.length}.`);
        const rows = ops.map(o => [
            `${o.docType || '(без типа)'} · ${o.oper || '(без обоснования)'}`,
            `строк ${o.rows}`,
            [...o.sums.entries()]
                .filter(([, v]) => Math.round(v * 100) !== 0)
                .map(([k, v]) => `${k}=${money(v)}`)
                .join(', ')
        ]);
        const headText = head.join('\n') + '\n\n';
        return headText + table(['тип документа · обоснование', 'строк', 'суммы полей'], rows, args.offset, args.limit, budget - bytes(headText));
    }

    head.push('Итог за период: ' + shownMetrics.map(m => `${m} ${fmtMetric(m, total[m])}`).join(' | '));
    head.push('Метрики: ' + shownMetrics.map(m => `${m} — ${METRIC_NOTES[m]}`).join('; ') + '.');

    let columns: string[];
    let rows: string[][];

    if (args.groupBy === 'deduction') {
        // Удержания по основанию: у строк «Удержание» основание лежит в bonusTypeName.
        const byReason = new Map<string, { report: number; reason: string; amount: number; rows: number }>();
        const reasonTotals = new Map<string, number>();
        for (const g of groups) {
            const i = fields.indexOf('deduction');
            const amount = i < 0 ? 0 : (g.sums[i] ?? 0);
            if (amount === 0) continue;
            const reason = g.bonus || g.oper || '(основание не указано)';
            const key = `${g.report}\u0001${reason}`;
            const cur = byReason.get(key) ?? { report: g.report, reason, amount: 0, rows: 0 };
            cur.amount += amount;
            cur.rows += g.rows;
            byReason.set(key, cur);
            reasonTotals.set(reason, (reasonTotals.get(reason) ?? 0) + amount);
        }
        head.push(
            'Удержания по основаниям за период: ' +
                ([...reasonTotals.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([reason, v]) => `${reason} ${money(v)}`)
                    .join(' | ') || 'нет')
        );
        columns = ['report_id', 'date_from', 'date_to', 'основание', 'deduction', 'строк'];
        rows = [...byReason.values()]
            .sort((a, b) => {
                const ra = reportById.get(a.report)?.dateFrom ?? '';
                const rb = reportById.get(b.report)?.dateFrom ?? '';
                return ra.localeCompare(rb) || a.report - b.report || b.amount - a.amount;
            })
            .map(d => {
                const r = reportById.get(d.report);
                return [String(d.report), r?.dateFrom ?? '', r?.dateTo ?? '', d.reason, money(d.amount), String(d.rows)];
            });
        head.push('deduction — как в отчёте WB: удержание положительным числом.');
    } else {
        // Свод метрик по ключу разреза.
        const keyOf = (g: RealizationGroup): string => {
            switch (args.groupBy) {
                case 'report':
                    return String(g.report);
                case 'sku':
                    return `${g.nmId}\u0001${g.article}`;
                case 'report_sku':
                    return `${g.report}\u0001${g.nmId}\u0001${g.article}`;
                case 'operation':
                    return `${g.docType}\u0001${g.oper}`;
                default:
                    return '';
            }
        };
        const acc = new Map<string, { sample: RealizationGroup; metrics: Metrics; rows: number }>();
        for (const g of groups) {
            const key = keyOf(g);
            let cur = acc.get(key);
            if (!cur) {
                cur = { sample: g, metrics: emptyMetrics(), rows: 0 };
                acc.set(key, cur);
            }
            addGroupMetrics(cur.metrics, g, fields);
            cur.rows += g.rows;
        }
        const list = [...acc.values()];
        const metricCells = (m: Metrics): string[] => shownMetrics.map(x => fmtMetric(x, m[x]));
        const article = (g: RealizationGroup): string => (g.nmId === 0 ? '(без товара)' : g.article || '—');

        switch (args.groupBy) {
            case 'report':
                list.sort((a, b) => {
                    const ra = reportById.get(a.sample.report);
                    const rb = reportById.get(b.sample.report);
                    return (ra?.dateFrom ?? '').localeCompare(rb?.dateFrom ?? '') || a.sample.report - b.sample.report;
                });
                columns = ['report_id', 'date_from', 'date_to', 'create_dt', 'тип', 'строк', ...shownMetrics];
                rows = list.map(x => {
                    const r = reportById.get(x.sample.report);
                    return [
                        String(x.sample.report),
                        r?.dateFrom ?? '',
                        r?.dateTo ?? '',
                        r?.createDate ?? '',
                        REPORT_TYPES[r?.type ?? 0] ?? String(r?.type ?? ''),
                        String(x.rows),
                        ...metricCells(x.metrics)
                    ];
                });
                break;
            case 'sku':
                list.sort((a, b) => b.metrics.revenue - a.metrics.revenue || a.sample.nmId - b.sample.nmId);
                columns = ['nmId', 'артикул', ...shownMetrics];
                rows = list.map(x => [String(x.sample.nmId || '—'), article(x.sample), ...metricCells(x.metrics)]);
                break;
            case 'report_sku':
                list.sort((a, b) => {
                    const ra = reportById.get(a.sample.report)?.dateFrom ?? '';
                    const rb = reportById.get(b.sample.report)?.dateFrom ?? '';
                    return ra.localeCompare(rb) || a.sample.report - b.sample.report || b.metrics.revenue - a.metrics.revenue;
                });
                columns = ['report_id', 'date_from', 'nmId', 'артикул', ...shownMetrics];
                rows = list.map(x => [
                    String(x.sample.report),
                    reportById.get(x.sample.report)?.dateFrom ?? '',
                    String(x.sample.nmId || '—'),
                    article(x.sample),
                    ...metricCells(x.metrics)
                ]);
                break;
            default:
                list.sort((a, b) => b.rows - a.rows);
                columns = ['тип документа', 'обоснование', 'строк', ...shownMetrics];
                rows = list.map(x => [x.sample.docType || '(без типа)', x.sample.oper || '(без обоснования)', String(x.rows), ...metricCells(x.metrics)]);
        }
        head.push(SIGNS_NOTE);
    }

    const headText = head.join('\n') + '\n\n';
    return headText + table(columns, rows, args.offset, args.limit, budget - bytes(headText));
}

// ─── Платное хранение ────────────────────────────────────────────────────────

function storageText(
    cabinet: Cabinet,
    from: string,
    to: string,
    snap: FinanceSnapshot<StorageData>,
    args: { groupBy: 'day' | 'week' | 'sku'; offset: number; limit: number },
    budget: number
): string {
    const entries = snap.data.entries;
    // В отчёте WB хранение — положительная сумма, сторно — отрицательная.
    // Для P&L это расход, поэтому отдаём с минусом.
    const total = -entries.reduce((s, e) => s + e[3], 0);
    const head = [
        `Платное хранение WB — кабинет ${cabinet.slug} (${cabinet.label}), ${from} — ${to}`,
        `Источник: ${snap.sourceRows} строк отчёта о платном хранении (товар × склад × день), окна по 8 дней склеены. ${originLine(snap, storageClosed(to))}`,
        `Итог: хранение ${money(total)} ₽ (расход — с минусом; сторно хранения уже учтено).`
    ];

    const acc = new Map<string, { key: string[]; amount: number; days: Set<string> }>();
    for (const [date, nmId, article, amount] of entries) {
        let key: string[];
        if (args.groupBy === 'day') key = [date];
        else if (args.groupBy === 'week') key = [mondayOf(date)];
        else key = [String(nmId || '—'), nmId === 0 ? '(без товара)' : article || '—'];
        const id = key.join('\u0001');
        let cur = acc.get(id);
        if (!cur) {
            cur = { key, amount: 0, days: new Set() };
            acc.set(id, cur);
        }
        cur.amount -= amount;
        cur.days.add(date);
    }
    const list = [...acc.values()];
    let columns: string[];
    if (args.groupBy === 'sku') {
        list.sort((a, b) => a.amount - b.amount);
        columns = ['nmId', 'артикул', 'хранение', 'дней'];
    } else {
        list.sort((a, b) => a.key[0]!.localeCompare(b.key[0]!));
        columns = args.groupBy === 'week' ? ['неделя с', 'дней в периоде', 'хранение'] : ['дата', 'хранение'];
    }
    const rows = list.map(x => {
        if (args.groupBy === 'sku') return [...x.key, money(x.amount), String(x.days.size)];
        if (args.groupBy === 'week') return [x.key[0]!, String(x.days.size), money(x.amount)];
        return [x.key[0]!, money(x.amount)];
    });
    if (args.groupBy === 'week') head.push('Неделя — с понедельника; крайние недели могут быть неполными, см. «дней в периоде».');
    const headText = head.join('\n') + '\n\n';
    return headText + table(columns, rows, args.offset, args.limit, budget - bytes(headText));
}

// ─── Реклама ─────────────────────────────────────────────────────────────────

function adSpendText(
    cabinet: Cabinet,
    from: string,
    to: string,
    snap: FinanceSnapshot<AdSpendData>,
    args: { groupBy: 'day' | 'campaign' | 'sku'; offset: number; limit: number },
    budget: number
): string {
    const { charges, campaigns } = snap.data;
    const byId = new Map(campaigns.map(c => [c.id, c]));
    // Списание — расход, поэтому с минусом.
    const total = -charges.reduce((s, c) => s + c[2], 0);
    const bySource = new Map<string, number>();
    for (const c of charges) bySource.set(c[3] || '—', (bySource.get(c[3] || '—') ?? 0) - c[2]);
    const sourcesText = (m: Map<string, number>): string =>
        [...m.entries()]
            .sort((a, b) => a[1] - b[1])
            .map(([k, v]) => `${k} ${money(v)}`)
            .join('; ');

    const head = [
        `Реклама WB, списания — кабинет ${cabinet.slug} (${cabinet.label}), даты списаний ${from} — ${to} по Москве`,
        `Источник: ${snap.sourceRows} списаний из истории затрат WB, кампаний ${campaigns.length}. ${originLine(snap, adSpendClosed(to))}`,
        `Итог: списано ${money(total)} ₽ (расход — с минусом). По источнику списания: ${sourcesText(bySource) || 'нет'}`
    ];

    let columns: string[];
    let rows: string[][];
    if (args.groupBy === 'day') {
        const acc = new Map<string, { amount: number; sources: Map<string, number> }>();
        for (const [date, , amount, source] of charges) {
            const cur = acc.get(date) ?? { amount: 0, sources: new Map<string, number>() };
            cur.amount -= amount;
            cur.sources.set(source || '—', (cur.sources.get(source || '—') ?? 0) - amount);
            acc.set(date, cur);
        }
        columns = ['дата', 'списано', 'по источникам'];
        rows = [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, x]) => [d, money(x.amount), sourcesText(x.sources)]);
    } else if (args.groupBy === 'campaign') {
        const acc = new Map<number, { amount: number; sources: Map<string, number>; days: Set<string> }>();
        for (const [date, id, amount, source] of charges) {
            const cur = acc.get(id) ?? { amount: 0, sources: new Map<string, number>(), days: new Set<string>() };
            cur.amount -= amount;
            cur.sources.set(source || '—', (cur.sources.get(source || '—') ?? 0) - amount);
            cur.days.add(date);
            acc.set(id, cur);
        }
        columns = ['кампания', 'название', 'nmId', 'оплата', 'списано', 'дней со списаниями', 'по источникам'];
        rows = [...acc.entries()]
            .sort((a, b) => a[1].amount - b[1].amount)
            .map(([id, x]) => {
                const c = byId.get(id);
                const nms = c?.missing ? 'неизвестно (кампании нет в списке WB)' : c?.nmIds.join(', ') || '—';
                return [String(id), c?.name ?? '', nms, c?.paymentType || '—', money(x.amount), String(x.days.size), sourcesText(x.sources)];
            });
    } else {
        // По товарам. WB списывает деньги на кампанию, а не на товар: у кампании
        // с одним nmId списание целиком его, а у кампании с несколькими разбивки
        // в истории затрат нет. Делить её пропорцией молча не будем — такая
        // кампания идёт отдельной строкой со списком своих nmId.
        const acc = new Map<string, { nm: string; amount: number; campaigns: Set<number>; shared: boolean }>();
        for (const [, id, amount] of charges) {
            const nms = byId.get(id)?.nmIds ?? [];
            const shared = nms.length !== 1;
            const nm = nms.length === 1 ? String(nms[0]) : nms.length === 0 ? `неизвестно (кампания ${id})` : `несколько: ${nms.join(', ')}`;
            const key = shared ? `c${id}` : nm;
            const cur = acc.get(key) ?? { nm, amount: 0, campaigns: new Set<number>(), shared };
            cur.amount -= amount;
            cur.campaigns.add(id);
            acc.set(key, cur);
        }
        const list = [...acc.values()].sort((a, b) => a.amount - b.amount);
        const shared = list.filter(x => x.shared);
        head.push(
            shared.length === 0
                ? 'У всех кампаний периода по одному nmId — списание отнесено на товар целиком.'
                : `⚠ ${shared.length} строк — кампании с несколькими nmId или без известного состава, всего ${money(shared.reduce((s, x) => s + x.amount, 0))} ₽. ` +
                      'WB не даёт разбивки списания кампании по товарам, поэтому сумма не поделена — она стоит отдельной строкой со списком nmId.'
        );
        columns = ['nmId', 'списано', 'кампании'];
        rows = list.map(x => [x.nm, money(x.amount), [...x.campaigns].join(', ')]);
    }
    head.push('Состав кампаний (nmId) — текущий по данным WB: истории состава WB не отдаёт.');
    const headText = head.join('\n') + '\n\n';
    return headText + table(columns, rows, args.offset, args.limit, budget - bytes(headText));
}

export function registerWbFinanceTools(server: McpServer, actor: Actor): void {
    if (!hasAnyCabinet(actor)) return;

    server.registerTool(
        'wb_realization',
        {
            title: 'WB: отчёты о реализации',
            description:
                'Детализация еженедельных отчётов Wildberries о реализации за период — то, из чего собираются строки ВБ в P&L. ' +
                'Сервер сам выкачивает все строки (за месяц до 100 тыс.) и отдаёт суммы в разрезе groupBy: ' +
                'report — по отчётам (report_id, date_from, date_to, create_dt); sku — по товарам (nmId + артикул); report_sku; ' +
                'operation — по типу документа и обоснованию оплаты; deduction — удержания по основанию и отчёту ' +
                '(ВБ.Продвижение, Джем, утилизация, отзывы…). ' +
                'Метрики (mode=metrics) — формулы финансиста, s = −1 для «Возврат», иначе 1: revenue = s × retail_price_withdisc_rub; ' +
                'price_after_spp = s × retail_amount; for_pay = s × ppvz_for_pay (к перечислению за товар); ' +
                'commission = −s × (retail_price_withdisc_rub − ppvz_for_pay) + acquiring_fee; acquiring = −acquiring_fee; ' +
                'logistics = −delivery_rub (у «Логистика сторно» с плюсом); penalties = −penalty; ' +
                'sales_cnt: +1 продажа, −1 возврат, 0 для частичной компенсации брака; deliveries_cnt — строк с логистикой, ' +
                'deliveries_to_client_cnt — из них «К клиенту при продаже/отмене». Доход с плюсом, расходы с минусом; ' +
                'storage_fee, deduction, acceptance, additional_payment и поля лояльности и кешбэка — как в отчёте WB (удержание положительным). ' +
                'mode=raw — суммы всех числовых полей отчёта по типу документа × обоснованию, для сверок. ' +
                'Период — по дате строки отчёта, как фильтрует WB; отчёты недельные пн–вс, поэтому для месяца берите недели целиком: ' +
                'август 2026 — 2026-08-03 … 2026-08-30. До 93 дней. WB отдаёт детализацию раз в минуту и медленно: если данные ' +
                'не готовы, инструмент скажет, когда повторить. Закрытый период хранится на сервере и второй раз не качается.',
            inputSchema: {
                cabinet: cabinetArg,
                dateFrom: dateArg('Начало периода, дата строки отчёта: 2026-08-03 (понедельник)'),
                dateTo: dateArg('Конец периода включительно: 2026-08-30 (воскресенье)'),
                groupBy: z
                    .enum(['report', 'sku', 'report_sku', 'operation', 'deduction'])
                    .optional()
                    .describe('Разрез: report (по умолчанию), sku, report_sku, operation, deduction'),
                mode: z.enum(['metrics', 'raw']).optional().describe('metrics (по умолчанию) — метрики финансиста; raw — суммы всех полей WB'),
                offset: offsetArg,
                limit: limitArg
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_realization', async (args, extra) => {
            const problem = checkPeriod(args.dateFrom, args.dateTo);
            if (problem) return fail(problem);
            const opts = {
                groupBy: (args.groupBy ?? 'report') as GroupBy,
                mode: args.mode ?? 'metrics',
                offset: args.offset ?? 0,
                limit: args.limit ?? DEFAULT_LIMIT
            };
            return overCabinets(actorOf(extra), args.cabinet, async (cabinet, budget) => {
                try {
                    const snap = await loadRealization(cabinet, args.dateFrom, args.dateTo, WAIT_MS);
                    return realizationText(cabinet, args.dateFrom, args.dateTo, snap, opts, budget);
                } catch (e) {
                    if (e instanceof FinanceLoading) {
                        return loadingText(e, `Отчёты о реализации ${cabinet.slug}`, 'через 2–3 минуты');
                    }
                    throw e;
                }
            });
        })
    );

    server.registerTool(
        'wb_paid_storage',
        {
            title: 'WB: платное хранение',
            description:
                'Платное хранение на складах Wildberries за период, ₽, из отчёта WB о платном хранении (товар × склад × день). ' +
                'Сервер сам режет период на окна по 8 дней (так требует WB), ждёт подготовки каждого и склеивает. ' +
                'groupBy: day — по дням; week — по неделям с понедельника; sku — по товарам (nmId + артикул). ' +
                'Хранение — расход, отдаётся с минусом; сторно хранения уже учтено. Период — по дате начисления, ' +
                'для месяца — с 1-го по последнее число. До 93 дней. Подготовка у WB долгая: если данные не готовы, ' +
                'инструмент скажет, когда повторить. Закрытый период хранится на сервере.',
            inputSchema: {
                cabinet: cabinetArg,
                dateFrom: dateArg('Начало периода: 2026-08-01'),
                dateTo: dateArg('Конец периода включительно: 2026-08-31'),
                groupBy: z.enum(['day', 'week', 'sku']).optional().describe('Разрез: day (по умолчанию), week, sku'),
                offset: offsetArg,
                limit: limitArg
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_paid_storage', async (args, extra) => {
            const problem = checkPeriod(args.dateFrom, args.dateTo);
            if (problem) return fail(problem);
            const opts = { groupBy: args.groupBy ?? 'day', offset: args.offset ?? 0, limit: args.limit ?? DEFAULT_LIMIT };
            return overCabinets(actorOf(extra), args.cabinet, async (cabinet, budget) => {
                try {
                    const snap = await loadPaidStorage(cabinet, args.dateFrom, args.dateTo, WAIT_MS);
                    return storageText(cabinet, args.dateFrom, args.dateTo, snap, opts, budget);
                } catch (e) {
                    if (e instanceof FinanceLoading) return loadingText(e, `Платное хранение ${cabinet.slug}`, 'через 1–2 минуты');
                    throw e;
                }
            });
        })
    );

    server.registerTool(
        'wb_ad_spend',
        {
            title: 'WB: списания на рекламу',
            description:
                'Списания на рекламу Wildberries за период, ₽, из истории затрат продвижения: дата, кампания, её nmId ' +
                '(если товаров несколько — списком), источник списания (баланс, счёт, кэшбэк…). ' +
                'groupBy: day — по дням; campaign — по кампаниям; sku — по товарам. Расход отдаётся с минусом. ' +
                'Период — по дате списания по Москве (WB сам режет по UTC, сервер это выравнивает). Финансист берёт те же ' +
                'недели, что и отчёты о реализации: для августа 2026 — 2026-08-03 … 2026-08-30. До 93 дней. ' +
                'При groupBy=sku кампания с одним nmId относится на него целиком; разбивки списания кампании с несколькими ' +
                'nmId WB не даёт — такая кампания идёт отдельной строкой со списком nmId, без выдуманных долей. ' +
                'Состав кампаний — текущий: истории состава WB не хранит.',
            inputSchema: {
                cabinet: cabinetArg,
                dateFrom: dateArg('Начало периода, дата списания: 2026-08-03'),
                dateTo: dateArg('Конец периода включительно: 2026-08-30'),
                groupBy: z.enum(['day', 'campaign', 'sku']).optional().describe('Разрез: day (по умолчанию), campaign, sku'),
                offset: offsetArg,
                limit: limitArg
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_ad_spend', async (args, extra) => {
            const problem = checkPeriod(args.dateFrom, args.dateTo);
            if (problem) return fail(problem);
            const opts = { groupBy: args.groupBy ?? 'day', offset: args.offset ?? 0, limit: args.limit ?? DEFAULT_LIMIT };
            return overCabinets(actorOf(extra), args.cabinet, async (cabinet, budget) => {
                try {
                    const snap = await loadAdSpend(cabinet, args.dateFrom, args.dateTo, WAIT_MS);
                    return adSpendText(cabinet, args.dateFrom, args.dateTo, snap, opts, budget);
                } catch (e) {
                    if (e instanceof FinanceLoading) return loadingText(e, `Реклама ${cabinet.slug}`, 'через минуту');
                    throw e;
                }
            });
        })
    );
}
