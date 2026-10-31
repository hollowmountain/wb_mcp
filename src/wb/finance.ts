/**
 * Финансы Wildberries для ежемесячного отчёта «3 Формы»: детализация
 * еженедельных отчётов о реализации, платное хранение и списания на рекламу.
 * Только чтение.
 *
 * Появились 31.10.2026 по ТЗ операционного директора: отчёт теперь собирает
 * Claude, а не внешний финансист, поэтому формулы метрик взяты буквально с
 * листа «База ВБ» финансиста, а цифры сверены с его файлом за август 2026.
 *
 * Все три выгрузки долгие. Детализация — до 100 тыс. строк за месяц при лимите
 * WB один запрос в минуту, хранение — задача на каждые восемь дней. Ждать этого
 * внутри вызова инструмента нельзя: Claude сотрудника бросит ждать раньше.
 * Поэтому загрузка идёт на сервере в фоне, а вызов ждёт её ограниченное время
 * и, если не дождался, честно говорит, сколько уже получено и когда повторить.
 *
 * Закрытый период лежит в SQLite (таблица wb_fin_cache) — агрегатом, а не
 * сырыми строками, и сжатым. Открытый держится в памяти недолго: он ещё меняется.
 */
import { deflateSync, inflateSync } from 'node:zlib';

import { db } from '../db/index.js';
import { logger } from '../logger.js';
import type { Cabinet } from './cabinets.js';
import { WbApiError, wbDataJson, wbJson, wbResponse, type WbCategory } from './client.js';
import { sleep } from './ratelimit.js';

// ─── Даты ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const MSK_MS = 3 * 3_600_000;

/** Сегодня по Москве: WB считает сутки по МСК, а сервер живёт в UTC. */
export const mskToday = (): string => new Date(Date.now() + MSK_MS).toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string =>
    new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Понедельник недели, в которую попадает дата. Неделя WB — с понедельника. */
export function mondayOf(iso: string): string {
    const dow = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
    return addDays(iso, -dow);
}

/** Дата по Москве из отметки времени с любым поясом. */
const mskDateOf = (stamp: string): string => new Date(Date.parse(stamp) + MSK_MS).toISOString().slice(0, 10);

/**
 * Настоящая ли это дата. Date.parse('2026-04-31') молча даёт 1 мая, и период
 * уехал бы на день без единого слова — поэтому сверяем дату с её же записью.
 */
export function isRealDate(iso: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const t = Date.parse(`${iso}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso;
}

export const daysInclusive = (from: string, to: string): number =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/**
 * Режет период на куски не длиннее size дней, концы включительно. overlap —
 * на сколько дней следующий кусок заходит на предыдущий: там, где источник
 * режет даты не так, как мы (реклама — по UTC), стык окон не теряет строк,
 * а повторы потом убираются.
 */
function windows(from: string, to: string, size: number, overlap = 0): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (let start = from; ; start = addDays(start, size - overlap)) {
        const end = addDays(start, size - 1);
        out.push([start, end < to ? end : to]);
        if (end >= to) break;
    }
    return out;
}

/** Недели пн–вс, которые задевает период: [понедельник, воскресенье]. */
export function weeksOf(from: string, to: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (let monday = mondayOf(from); monday <= to; monday = addDays(monday, 7)) out.push([monday, addDays(monday, 6)]);
    return out;
}

// ─── Потоковый разбор JSON-массива ───────────────────────────────────────────

/**
 * Отдаёт объекты верхнего уровня JSON-массива по одному, как только каждый
 * пришёл целиком. Страница детализации — до 100 тыс. строк и сотни мегабайт:
 * целиком строкой в память её не берём. А если связь оборвалась посреди тела,
 * всё, что успело прийти, уже обработано — продолжать можно с последней строки.
 */
async function eachJsonObject(
    res: Response,
    category: WbCategory,
    onObject: (obj: Record<string, unknown>) => void
): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let pos = 0;
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    // Что лежит на верхнем уровне: '[' — массив строк, '{' — объект (ошибка или конверт).
    let top = '';

    try {
        await readAll();
    } catch (e) {
        // Бросили разбор посреди тела (строки не по порядку, битый JSON) — закрываем
        // поток, иначе соединение висело бы до часового таймаута запроса.
        await reader.cancel().catch(() => undefined);
        throw e;
    }

    if (top && top !== '[') {
        buf += decoder.decode();
        throw new WbApiError(`WB ответил не списком строк: ${buf.slice(0, 300)}`, res.status, category, new URL(res.url).pathname);
    }

    async function readAll(): Promise<void> {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buf += decoder.decode(value, { stream: true });

            if (!top) {
                const first = buf.trimStart()[0];
                if (!first) continue;
                top = first;
            }
            if (top !== '[') continue; // не массив — дочитаем целиком и разберём ниже

            for (; pos < buf.length; pos++) {
                const ch = buf[pos];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (ch === '\\') escaped = true;
                    else if (ch === '"') inString = false;
                    continue;
                }
                if (ch === '"') inString = true;
                else if (ch === '{') {
                    if (depth === 0) start = pos;
                    depth++;
                } else if (ch === '}') {
                    depth--;
                    if (depth === 0 && start >= 0) {
                        onObject(JSON.parse(buf.slice(start, pos + 1)) as Record<string, unknown>);
                        start = -1;
                    }
                }
            }
            // Разобранное выбрасываем, недоразобранный объект оставляем в начале буфера.
            const cut = start >= 0 ? start : pos;
            buf = buf.slice(cut);
            pos -= cut;
            if (start >= 0) start = 0;
        }
    }
}

// ─── Кэш и фоновая загрузка ──────────────────────────────────────────────────

export type FinanceKind = 'realization' | 'storage' | 'ads';

export interface FinanceSnapshot<T> {
    data: T;
    /** Строк в источнике — показываем в шапке ответа. */
    sourceRows: number;
    fetchedAt: number;
    /** Откуда взято: из базы (закрытый период), из памяти или только что с WB. */
    origin: 'cache' | 'memory' | 'wb';
    /**
     * Период закрыт и данные полны — лежат в базе и больше не перекачиваются.
     * false — открытый период или неполная выгрузка: держится в памяти недолго.
     */
    final: boolean;
}

export interface LoadOptions {
    /** Сколько вызов ждёт загрузку, прежде чем ответить «ещё идёт». */
    waitMs: number;
    /** Перекачать мимо кэша и перезаписать его: если WB задним числом поправил отчёт. */
    refresh?: boolean;
}

/**
 * Версия формата записи в wb_fin_cache. Агрегаты лежат позиционными массивами
 * (PackedGroup, StorageEntry, AdCharge), и правка их состава без смены версии
 * читала бы старые записи со сдвигом полей — молча и правдоподобно. Меняли
 * состав любого из них — поднимите число: старые записи перекачаются сами.
 *   1 — первая выкладка 31.10.2026, записи без версии;
 *   2 — версия в записи, у хранения появились пустые окна (emptyWindows).
 */
const CACHE_FORMAT = 2;

/**
 * Загрузка не уложилась в ожидание вызова и продолжается на сервере.
 * Это не ошибка: инструмент отвечает человеку, сколько уже получено.
 */
export class FinanceLoading extends Error {
    constructor(
        readonly progress: string,
        readonly startedAt: number
    ) {
        super('Загрузка ещё идёт');
        this.name = 'FinanceLoading';
    }
}

/** Открытый период держим недолго: WB дописывает в него новые строки. */
const OPEN_TTL_MS = 15 * 60_000;
/** Ошибку фоновой загрузки помним, пока её не увидит следующий вызов, но не вечно. */
const FAILURE_TTL_MS = 30 * 60_000;

interface Job {
    promise: Promise<FinanceSnapshot<unknown>>;
    progress: string;
    startedAt: number;
}

const memoryCache = new Map<string, FinanceSnapshot<unknown>>();
const jobs = new Map<string, Job>();
const failures = new Map<string, { at: number; error: unknown }>();

const readCache = db.prepare(
    'SELECT fetched_at, source_rows, payload FROM wb_fin_cache WHERE cabinet = ? AND kind = ? AND date_from = ? AND date_to = ?'
);
const writeCache = db.prepare(
    `INSERT INTO wb_fin_cache (cabinet, kind, date_from, date_to, fetched_at, source_rows, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cabinet, kind, date_from, date_to) DO UPDATE SET
       fetched_at = excluded.fetched_at, source_rows = excluded.source_rows, payload = excluded.payload`
);

function fromDb<T>(cabinet: Cabinet, kind: FinanceKind, from: string, to: string): FinanceSnapshot<T> | undefined {
    const row = readCache.get(cabinet.slug, kind, from, to) as
        | { fetched_at: number; source_rows: number; payload: Buffer }
        | undefined;
    if (!row) return undefined;
    try {
        const stored = JSON.parse(inflateSync(row.payload).toString('utf8')) as { v?: number; data?: T };
        if (stored?.v !== CACHE_FORMAT || stored.data === undefined) {
            // Запись старого формата: читать её со сдвигом полей нельзя — перекачаем.
            logger.info({ cabinet: cabinet.slug, kind, from, to, v: stored?.v ?? 1 }, 'wb_fin_cache: запись старого формата');
            return undefined;
        }
        return { data: stored.data, sourceRows: row.source_rows, fetchedAt: row.fetched_at, origin: 'cache', final: true };
    } catch (e) {
        // Битая запись не повод падать: скачаем заново и перезапишем.
        logger.warn({ cabinet: cabinet.slug, kind, from, to, err: (e as Error).message }, 'wb_fin_cache: запись не читается');
        return undefined;
    }
}

/**
 * Данные за период: из кэша, если они там есть, иначе — загрузка в фоне.
 * Вызов ждёт её не дольше waitMs; не дождался — FinanceLoading с прогрессом,
 * а загрузка продолжается, и следующий вызов подхватит её же или готовый кэш.
 *
 * closed — по датам период закрыт и больше не изменится. В SQLite навсегда
 * результат ложится, только если ещё и complete(data) — выгрузка полна:
 * WB мог не успеть сформировать отчёт, и тогда «навсегда» запомнилась бы дыра.
 * Всё остальное живёт в памяти OPEN_TTL_MS. refresh — мимо кэша, с перезаписью.
 */
export async function loadFinance<T>(
    kind: FinanceKind,
    cabinet: Cabinet,
    from: string,
    to: string,
    closed: boolean,
    fetcher: (report: (progress: string) => void) => Promise<{ data: T; sourceRows: number }>,
    opts: LoadOptions,
    complete: (data: T) => boolean = () => true
): Promise<FinanceSnapshot<T>> {
    const key = `${kind}:${cabinet.slug}:${from}:${to}`;

    if (!opts.refresh) {
        if (closed) {
            const stored = fromDb<T>(cabinet, kind, from, to);
            if (stored) return stored;
        }
        const hit = memoryCache.get(key);
        if (hit && Date.now() - hit.fetchedAt < OPEN_TTL_MS) return { ...(hit as FinanceSnapshot<T>), origin: 'memory' };
        if (hit) memoryCache.delete(key);
    }

    // Фоновая загрузка упала, когда её никто не ждал, — сначала скажем об этом.
    const failed = failures.get(key);
    if (failed) {
        failures.delete(key);
        if (Date.now() - failed.at < FAILURE_TTL_MS && !jobs.has(key)) throw failed.error;
    }

    // Идущая загрузка и так свежая — refresh к ней просто присоединяется.
    let job = jobs.get(key);
    if (!job) {
        const fresh: Job = { promise: undefined as never, progress: 'запрос отправлен в WB', startedAt: Date.now() };
        fresh.promise = fetcher(p => {
            fresh.progress = p;
        })
            .then(({ data, sourceRows }) => {
                const final = closed && complete(data);
                const snap: FinanceSnapshot<T> = { data, sourceRows, fetchedAt: Date.now(), origin: 'wb', final };
                memoryCache.delete(key);
                if (final) {
                    try {
                        const payload = deflateSync(Buffer.from(JSON.stringify({ v: CACHE_FORMAT, data }), 'utf8'));
                        writeCache.run(cabinet.slug, kind, from, to, snap.fetchedAt, sourceRows, payload);
                        logger.info({ cabinet: cabinet.slug, kind, from, to, sourceRows, bytes: payload.length }, 'wb_fin_cache: период сохранён');
                        return snap as FinanceSnapshot<unknown>;
                    } catch (e) {
                        // Не записалось (диск сервера тесный) — данные всё равно отдаём,
                        // а подержим их в памяти, как открытый период.
                        logger.warn({ cabinet: cabinet.slug, kind, from, to, err: (e as Error).message }, 'wb_fin_cache: не удалось сохранить');
                    }
                }
                // Заодно выметаем протухшее: периоды бывают любые, и без этого
                // память копила бы каждый когда-то спрошенный.
                for (const [k, v] of memoryCache) if (Date.now() - v.fetchedAt >= OPEN_TTL_MS) memoryCache.delete(k);
                memoryCache.set(key, snap);
                return snap as FinanceSnapshot<unknown>;
            })
            .finally(() => jobs.delete(key));
        // Если ждавший вызов уже ушёл, ошибку некому показать — сохраним до следующего.
        fresh.promise.catch(error => {
            failures.set(key, { at: Date.now(), error });
            logger.warn({ cabinet: cabinet.slug, kind, from, to, err: (error as Error)?.message }, 'wb finance: загрузка не удалась');
        });
        jobs.set(key, fresh);
        job = fresh;
    }

    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<'wait'>(resolve => {
        timer = setTimeout(() => resolve('wait'), opts.waitMs);
    });
    try {
        const result = await Promise.race([job.promise, waited]);
        if (result === 'wait') throw new FinanceLoading(job.progress, job.startedAt);
        return result as FinanceSnapshot<T>;
    } catch (e) {
        // Ошибку получил сам ждавший — повторять её следующему вызову незачем.
        if (!(e instanceof FinanceLoading)) failures.delete(key);
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ─── Детализация отчётов о реализации ────────────────────────────────────────
//
// POST finance-api /api/finance/v1/sales-reports/detailed — с 15.04.2026 на
// смену statistics-api /api/v5/supplier/reportDetailByPeriod, который с 15.07
// отвечает 404. Поля переименованы в camelCase, суммы стали строками:
//   realizationreport_id → reportId     supplier_oper_name → sellerOperName
//   create_dt → createDate              retail_price_withdisc_rub → retailPriceWithDisc
//   ppvz_for_pay → forPay               delivery_rub → deliveryService
//   storage_fee → paidStorage           acceptance → paidAcceptance
//   sa_name → vendorCode                rr_dt → rrDate
// Пустые поля WB иногда не присылает вовсе (bonusTypeName, kiz), поэтому
// каждое поле читается как необязательное.
//
// Листаем по rrdId — идентификатору последней полученной строки, строки идут
// по возрастанию rrdId (проверено 31.10.2026). Конец — пустой ответ или 204.
// Последнюю неполную страницу концом не считаем: если WB однажды начнёт
// отдавать меньше limit посреди выгрузки, мы молча потеряли бы хвост.

const REALIZATION_PATH = '/api/finance/v1/sales-reports/detailed';
/** Больше WB не отдаёт. Страница разбирается потоком, так что память не страдает. */
const REALIZATION_PAGE = 100_000;
/** Сколько раз подряд можно оборваться, не получив ни строки, прежде чем сдаться. */
const REALIZATION_MAX_EMPTY_BREAKS = 3;

/**
 * Поля, которые не суммируются: идентификаторы, проценты, коэффициенты.
 * Все прочие числовые поля, включая новые, о которых мы ещё не знаем,
 * суммируются — так режим raw покажет, если WB добавит в отчёт деньги.
 */
const NOT_SUMMED = new Set([
    // идентификаторы
    'reportId',
    'reportType',
    'rrdId',
    'giId',
    'nmId',
    'shkId',
    'ppvzOfficeId',
    'orderId',
    'sellerPromoId',
    'loyaltyId',
    // строки из цифр, но не суммы: штрихкод, размер, номера документов
    'sku',
    'techSize',
    'stickerId',
    'trbxId',
    'declarationNumber',
    'b2bCustomerTin',
    'ppvzSupplierInn',
    'utdUcdNumber',
    'buyerTaxRegistrationReasonCode',
    'assemblyId',
    // идентификаторы, которые бывают то буквенными, то из одних цифр: srid у
    // части строк — число, и без этого режим raw сложил его как сумму
    'srid',
    'orderUid',
    'articleSubstitution',
    'kiz',
    'uuidPromocode',
    // проценты и коэффициенты
    'dlvPrc',
    'salePercent',
    'commissionPercent',
    'productDiscountForReport',
    'sellerPromo',
    'spp',
    'kvwBase',
    'kvw',
    'supRatingUp',
    'isKgvpV2',
    'acquiringPercent',
    'wibesDiscountPercent',
    'sellerPromoDiscount',
    'salePricePromocodeDiscountPrc',
    'salePriceAffiliatedDiscountPrc',
    'salePriceWholesaleDiscountPrc',
    'warehouseLogisticsCoeff'
]);

const NUMERIC = /^-?\d+(\.\d+)?$/;

function numberOf(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && NUMERIC.test(v)) return Number(v);
    return null;
}

const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** s из формул финансиста: −1 для возврата, иначе 1. */
const signOf = (docType: string): number => (lower(docType) === 'возврат' ? -1 : 1);

const PARTIAL_DEFECT = 'частичная компенсация брака';
const STORNO_LOGISTICS = 'логистика сторно';
const TO_CLIENT = new Set(['к клиенту при продаже', 'к клиенту при отмене']);

export interface RealizationReport {
    id: number;
    dateFrom: string;
    dateTo: string;
    createDate: string;
    /** 1 — основной отчёт, 2 — отчёт по выкупам. */
    type: number;
    rows: number;
}

/**
 * Строки детализации, сложенные по ключу «отчёт × nmId × артикул × тип
 * документа × обоснование × вид логистики/основание удержания». Этого ключа
 * хватает на все разрезы и все формулы: знак s зависит от типа документа,
 * сторно логистики — от обоснования, «к клиенту» — от вида логистики, а
 * штучные счётчики посчитаны построчно при сложении.
 */
export interface RealizationGroup {
    report: number;
    nmId: number;
    article: string;
    docType: string;
    oper: string;
    /** bonusTypeName: вид логистики, а у удержаний — их основание. */
    bonus: string;
    rows: number;
    /** sales_cnt по формуле финансиста, сложенный построчно. */
    sales: number;
    /** deliveries_cnt: строк с ненулевой логистикой. */
    deliveries: number;
    /** Суммы числовых полей в порядке RealizationData.fields. */
    sums: number[];
}

export interface RealizationData {
    fields: string[];
    reports: RealizationReport[];
    groups: RealizationGroup[];
}

/** Компактная запись группы для кэша: массив вместо объекта с именами полей. */
type PackedGroup = [number, number, string, string, string, string, number, number, number, ...number[]];

interface PackedRealization {
    fields: string[];
    reports: RealizationReport[];
    groups: PackedGroup[];
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

function packRealization(d: RealizationData): PackedRealization {
    return {
        fields: d.fields,
        reports: d.reports,
        groups: d.groups.map(
            g =>
                [g.report, g.nmId, g.article, g.docType, g.oper, g.bonus, g.rows, g.sales, g.deliveries, ...g.sums.map(round6)] as PackedGroup
        )
    };
}

function unpackRealization(p: PackedRealization): RealizationData {
    return {
        fields: p.fields,
        reports: p.reports,
        groups: p.groups.map(([report, nmId, article, docType, oper, bonus, rows, sales, deliveries, ...sums]) => ({
            report,
            nmId,
            article,
            docType,
            oper,
            bonus,
            rows,
            sales,
            deliveries,
            sums
        }))
    };
}

class RealizationAccumulator {
    readonly fields: string[] = [];
    private readonly fieldIndex = new Map<string, number>();
    private readonly groups = new Map<string, RealizationGroup>();
    private readonly reports = new Map<number, RealizationReport>();
    rows = 0;

    add(row: Record<string, unknown>): void {
        this.rows++;
        const reportId = Number(row.reportId) || 0;
        let report = this.reports.get(reportId);
        if (!report) {
            report = {
                id: reportId,
                dateFrom: String(row.dateFrom ?? ''),
                dateTo: String(row.dateTo ?? ''),
                createDate: String(row.createDate ?? ''),
                type: Number(row.reportType) || 0,
                rows: 0
            };
            this.reports.set(reportId, report);
        }
        report.rows++;

        const nmId = Number(row.nmId) || 0;
        const article = typeof row.vendorCode === 'string' ? row.vendorCode : '';
        const docType = typeof row.docTypeName === 'string' ? row.docTypeName : '';
        const oper = typeof row.sellerOperName === 'string' ? row.sellerOperName : '';
        const bonus = typeof row.bonusTypeName === 'string' ? row.bonusTypeName : '';
        const key = `${reportId}\u0001${nmId}\u0001${article}\u0001${docType}\u0001${oper}\u0001${bonus}`;

        let group = this.groups.get(key);
        if (!group) {
            group = { report: reportId, nmId, article, docType, oper, bonus, rows: 0, sales: 0, deliveries: 0, sums: [] };
            this.groups.set(key, group);
        }
        group.rows++;

        for (const [field, raw] of Object.entries(row)) {
            if (NOT_SUMMED.has(field)) continue;
            const v = numberOf(raw);
            if (v === null || v === 0) continue;
            let idx = this.fieldIndex.get(field);
            if (idx === undefined) {
                idx = this.fields.length;
                this.fields.push(field);
                this.fieldIndex.set(field, idx);
            }
            group.sums[idx] = (group.sums[idx] ?? 0) + v;
        }

        // Штучные счётчики — только построчно: из сумм их не восстановить.
        const s = signOf(docType);
        const revenue = s * (numberOf(row.retailPriceWithDisc) ?? 0);
        if (lower(oper) !== PARTIAL_DEFECT) {
            if (revenue > 0.1) group.sales += 1;
            else if (revenue < 0) group.sales -= 1;
        }
        if ((numberOf(row.deliveryService) ?? 0) !== 0) group.deliveries += 1;
    }

    result(): RealizationData {
        const width = this.fields.length;
        const groups = [...this.groups.values()].map(g => ({
            ...g,
            sums: Array.from({ length: width }, (_, i) => g.sums[i] ?? 0)
        }));
        const reports = [...this.reports.values()].sort((a, b) => a.dateFrom.localeCompare(b.dateFrom) || a.id - b.id);
        return { fields: [...this.fields], reports, groups };
    }
}

async function fetchRealization(
    cabinet: Cabinet,
    from: string,
    to: string,
    report: (progress: string) => void
): Promise<{ data: PackedRealization; sourceRows: number }> {
    const acc = new RealizationAccumulator();
    let rrdId = 0;
    let requests = 0;
    let emptyBreaks = 0;

    for (;;) {
        requests++;
        report(`запрос ${requests} к WB, получено строк: ${acc.rows}`);
        const res = await wbResponse(cabinet, 'finreports', {
            method: 'POST',
            path: REALIZATION_PATH,
            json: { dateFrom: from, dateTo: to, limit: REALIZATION_PAGE, rrdId, period: 'weekly' },
            // Сто тысяч строк — это сотни мегабайт; минуты по умолчанию не хватит.
            timeoutMs: 60 * 60_000
        });

        let got = 0;
        let broken: unknown;
        if (res.status !== 204) {
            try {
                await eachJsonObject(res, 'finreports', row => {
                    const id = Number(row.rrdId);
                    if (!(id > rrdId)) {
                        // Без возрастания rrdId продолжение с последней строки теряло бы
                        // или дублировало строки. Пусть лучше упадёт громко.
                        throw new WbApiError(
                            `WB прислал строки детализации не по порядку rrdId (${id} после ${rrdId}) — выгрузку не доверяем`,
                            500,
                            'finreports',
                            REALIZATION_PATH
                        );
                    }
                    acc.add(row);
                    rrdId = id;
                    got++;
                    if (got % 1000 === 0) report(`запрос ${requests} к WB, получено строк: ${acc.rows}`);
                });
            } catch (e) {
                if (e instanceof WbApiError) throw e;
                broken = e;
            }
        }

        if (broken !== undefined) {
            // Связь оборвалась посреди страницы. Принятое уже сложено, продолжаем
            // с последней целой строки; сдаёмся, только если обрывы идут вхолостую.
            emptyBreaks = got === 0 ? emptyBreaks + 1 : 0;
            logger.warn({ cabinet: cabinet.slug, got, total: acc.rows, err: (broken as Error)?.message }, 'детализация WB: обрыв, продолжаю');
            if (emptyBreaks >= REALIZATION_MAX_EMPTY_BREAKS) {
                throw new WbApiError(
                    `Связь с WB рвётся при выгрузке детализации: получено ${acc.rows} строк, дальше не идёт. Повторите позже.`,
                    0,
                    'finreports',
                    REALIZATION_PATH
                );
            }
            continue;
        }
        if (got === 0) break;
    }

    report(`получено строк: ${acc.rows}, сворачиваю`);
    return { data: packRealization(acc.result()), sourceRows: acc.rows };
}

/**
 * Период детализации закрыт, когда по всем его неделям отчёты уже сформированы
 * и больше не меняются. WB формирует отчёт в понедельник после недели, иногда
 * с задержкой на день-два; неделя запаса сверху — чтобы не закрыть раньше времени.
 */
export function realizationClosed(to: string): boolean {
    const weekEnd = addDays(mondayOf(to), 6);
    return mskToday() > addDays(weekEnd, 7);
}

/**
 * Недели периода, по которым нет ни одного отчёта. У живого кабинета отчёт
 * есть каждую неделю, так что пустая неделя — почти всегда отчёт, который WB
 * ещё не сформировал или переформировывает. Такой период закрытым не считаем.
 */
export function missingWeeks(reports: Array<Pick<RealizationReport, 'dateFrom' | 'dateTo'>>, from: string, to: string): string[] {
    return weeksOf(from, to)
        .filter(([monday, sunday]) => !reports.some(r => r.dateFrom <= sunday && r.dateTo >= monday))
        .map(([monday, sunday]) => `${monday} — ${sunday}`);
}

export async function loadRealization(
    cabinet: Cabinet,
    from: string,
    to: string,
    opts: LoadOptions
): Promise<FinanceSnapshot<RealizationData>> {
    const snap = await loadFinance<PackedRealization>(
        'realization',
        cabinet,
        from,
        to,
        realizationClosed(to),
        report => fetchRealization(cabinet, from, to, report),
        opts,
        data => missingWeeks(data.reports, from, to).length === 0
    );
    return { ...snap, data: unpackRealization(snap.data) };
}

// ─── Метрики по формулам финансиста ──────────────────────────────────────────

/**
 * Метрики с листа «База ВБ» финансиста. Считаются по строке и складываются
 * в разрезе; s = −1, если тип документа «Возврат», иначе 1. Сравнения текста
 * без учёта регистра.
 */
export const METRICS = [
    'revenue',
    'price_after_spp',
    'for_pay',
    'commission',
    'acquiring',
    'logistics',
    'penalties',
    'storage_fee',
    'deduction',
    'acceptance',
    'additional_payment',
    'rebill_logistic_cost',
    'cashback_amount',
    'cashback_discount',
    'cashback_commission_change',
    'installment_cofinancing',
    'sales_cnt',
    'deliveries_cnt',
    'deliveries_to_client_cnt'
] as const;

export type Metric = (typeof METRICS)[number];
export type Metrics = Record<Metric, number>;

/** Метрики, которые штуки, а не рубли. */
export const COUNT_METRICS: ReadonlySet<Metric> = new Set<Metric>(['sales_cnt', 'deliveries_cnt', 'deliveries_to_client_cnt']);

/**
 * Поля, которые по ТЗ идут «как есть» — с тем знаком, что в отчёте WB.
 * loyaltyDiscount и sellerPromoDiscount сюда не входят: в новом API деньги —
 * строки, а эти два — числа, то есть проценты. В режиме raw они видны.
 */
const AS_IS: Array<[Metric, string]> = [
    ['storage_fee', 'paidStorage'],
    ['deduction', 'deduction'],
    ['acceptance', 'paidAcceptance'],
    ['additional_payment', 'additionalPayment'],
    ['rebill_logistic_cost', 'rebillLogisticCost'],
    ['cashback_amount', 'cashbackAmount'],
    ['cashback_discount', 'cashbackDiscount'],
    ['cashback_commission_change', 'cashbackCommissionChange'],
    ['installment_cofinancing', 'installmentCofinancingAmount']
];

export const emptyMetrics = (): Metrics => Object.fromEntries(METRICS.map(m => [m, 0])) as Metrics;

/** Добавляет к acc метрики одной группы. */
export function addGroupMetrics(acc: Metrics, g: RealizationGroup, fields: string[]): void {
    const at = (field: string): number => {
        const i = fields.indexOf(field);
        return i < 0 ? 0 : (g.sums[i] ?? 0);
    };
    const s = signOf(g.docType);
    const retail = at('retailPriceWithDisc');
    const forPay = at('forPay');
    const acquiringFee = at('acquiringFee');
    const delivery = at('deliveryService');

    acc.revenue += s * retail;
    acc.price_after_spp += s * at('retailAmount');
    acc.for_pay += s * forPay;
    acc.acquiring += -acquiringFee;
    acc.commission += -s * (retail - forPay) + acquiringFee;
    acc.logistics += lower(g.oper) === STORNO_LOGISTICS ? delivery : -delivery;
    acc.penalties += -at('penalty');
    for (const [metric, field] of AS_IS) acc[metric] += at(field);
    acc.sales_cnt += g.sales;
    acc.deliveries_cnt += g.deliveries;
    if (TO_CLIENT.has(lower(g.bonus))) acc.deliveries_to_client_cnt += g.deliveries;
}

/** Суммы всех числовых полей группы — для режима raw. */
export function addGroupRaw(acc: Map<string, number>, g: RealizationGroup, fields: string[]): void {
    fields.forEach((field, i) => {
        const v = g.sums[i] ?? 0;
        if (v !== 0) acc.set(field, (acc.get(field) ?? 0) + v);
    });
}

// ─── Платное хранение ────────────────────────────────────────────────────────
//
// seller-analytics-api /api/v1/paid_storage: создать задачу на окно не длиннее
// восьми дней → ждать статуса done → скачать. Окна склеиваем сами. Строка —
// товар × склад × день, сумма в warehousePrice. Бывают строки сторно хранения
// с отрицательной суммой — складываем как есть.

const STORAGE_WINDOW_DAYS = 8;
/** Сколько ждать, пока WB подготовит одно окно. */
const STORAGE_TASK_MAX_MS = 10 * 60_000;
/**
 * Скачивание окна рвётся: 31.10.2026 из Бишкека окно в 2–3 МБ шло по 4–6 минут
 * и обрывалось через 20–190 секунд в половине попыток. Продолжить с места WB
 * не даёт, поэтому окно качается заново; лимит на скачивание — раз в минуту.
 */
const STORAGE_DOWNLOAD_ATTEMPTS = 5;

/** Хранение за день по товару: [дата, nmId, артикул, сумма ₽, строк]. */
export type StorageEntry = [string, number, string, number, number];

export interface StorageData {
    entries: StorageEntry[];
    /** Окна, по которым WB не прислал ни строки, — «2026-08-03 — 2026-08-10». */
    emptyWindows: string[];
}

async function storageTask(cabinet: Cabinet, from: string, to: string): Promise<string> {
    const res = await wbDataJson<{ taskId: string }>(cabinet, 'analytics', {
        path: '/api/v1/paid_storage',
        query: { dateFrom: from, dateTo: to }
    });
    if (!res?.taskId) throw new Error('WB не вернул идентификатор задачи для отчёта о платном хранении');
    return res.taskId;
}

async function waitStorageTask(cabinet: Cabinet, taskId: string): Promise<void> {
    const started = Date.now();
    for (;;) {
        await sleep(5000);
        const res = await wbDataJson<{ id: string; status: string }>(cabinet, 'analytics', {
            path: `/api/v1/paid_storage/tasks/${taskId}/status`
        });
        const status = res?.status ?? 'unknown';
        if (status === 'done') return;
        if (status === 'purged' || status === 'canceled') {
            throw new Error(`WB прекратил подготовку отчёта о платном хранении (статус «${status}»)`);
        }
        if (Date.now() - started > STORAGE_TASK_MAX_MS) {
            throw new Error('WB не подготовил отчёт о платном хранении за десять минут. Повторите позже.');
        }
    }
}

async function fetchPaidStorage(
    cabinet: Cabinet,
    from: string,
    to: string,
    report: (progress: string) => void
): Promise<{ data: StorageData; sourceRows: number }> {
    const parts = windows(from, to, STORAGE_WINDOW_DAYS);
    const total = new Map<string, StorageEntry>();
    const emptyWindows: string[] = [];
    let sourceRows = 0;

    for (const [i, [a, b]] of parts.entries()) {
        report(`окно ${i + 1} из ${parts.length} (${a} — ${b}), строк до него: ${sourceRows}`);
        const taskId = await storageTask(cabinet, a, b);
        await waitStorageTask(cabinet, taskId);

        // Окно собираем отдельно: оборвись скачивание на середине, половина окна
        // не должна попасть в итог. Скачиваем заново, задача на WB живёт дольше.
        for (let attempt = 1; ; attempt++) {
            const part = new Map<string, StorageEntry>();
            let rows = 0;
            try {
                const res = await wbResponse(cabinet, 'analytics', {
                    path: `/api/v1/paid_storage/tasks/${taskId}/download`,
                    timeoutMs: 30 * 60_000
                });
                await eachJsonObject(res, 'analytics', row => {
                    rows++;
                    const date = String(row.date ?? '').slice(0, 10);
                    const nmId = Number(row.nmId) || 0;
                    const article = typeof row.vendorCode === 'string' ? row.vendorCode : '';
                    const amount = numberOf(row.warehousePrice) ?? 0;
                    const key = `${date}\u0001${nmId}\u0001${article}`;
                    const cur = part.get(key);
                    if (cur) {
                        cur[3] += amount;
                        cur[4] += 1;
                    } else {
                        part.set(key, [date, nmId, article, amount, 1]);
                    }
                });
            } catch (e) {
                if (e instanceof WbApiError || attempt >= STORAGE_DOWNLOAD_ATTEMPTS) throw e;
                logger.warn({ cabinet: cabinet.slug, window: `${a}..${b}`, attempt, err: (e as Error).message }, 'платное хранение WB: обрыв, качаю окно заново');
                continue;
            }
            sourceRows += rows;
            if (rows === 0) emptyWindows.push(`${a} — ${b}`);
            for (const [key, entry] of part) {
                // Окна не пересекаются, но строки дня попадают в окно по своей дате —
                // на всякий случай складываем, а не перезаписываем.
                const cur = total.get(key);
                if (cur) {
                    cur[3] += entry[3];
                    cur[4] += entry[4];
                } else {
                    total.set(key, entry);
                }
            }
            break;
        }
    }

    const entries = [...total.values()]
        .filter(e => e[0] >= from && e[0] <= to)
        .map(e => [e[0], e[1], e[2], round6(e[3]), e[4]] as StorageEntry)
        .sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1]);
    return { data: { entries, emptyWindows }, sourceRows };
}

/** Хранение за день WB досчитывает на следующие сутки; два дня запаса. */
export const storageClosed = (to: string): boolean => mskToday() > addDays(to, 2);

export async function loadPaidStorage(
    cabinet: Cabinet,
    from: string,
    to: string,
    opts: LoadOptions
): Promise<FinanceSnapshot<StorageData>> {
    return loadFinance<StorageData>(
        'storage',
        cabinet,
        from,
        to,
        storageClosed(to),
        report => fetchPaidStorage(cabinet, from, to, report),
        opts,
        // Пустое окно у кабинета с товаром на складах — скорее недосчитанный
        // WB отчёт, чем правда; навсегда такое не запоминаем.
        data => data.emptyWindows.length === 0
    );
}

// ─── Списания на рекламу ─────────────────────────────────────────────────────
//
// advert-api /adv/v1/upd — история затрат: каждое списание с датой, суммой,
// кампанией и источником (баланс, счёт, кэшбэк). Период запроса — до 31 дня.
// WB режет его по датам UTC: запрос с 01.08 по 31.08 вернул списание
// 01.09 02:36 МСК. Финансист же считает по дате МСК — так сошлось до рубля
// за август. Поэтому запрашиваем на день шире с обеих сторон и режем сами.
//
// nmId кампании — из /api/advert/v2/adverts (до 50 кампаний за запрос). Это
// ТЕКУЩИЙ состав кампании: истории состава WB не отдаёт, и у кампаний, где
// товары меняли, список может не совпасть с тем, что крутилось в периоде.

const UPD_WINDOW_DAYS = 30;
const ADVERTS_BATCH = 50;

interface UpdRow {
    updNum: number;
    updTime: string;
    updSum: number;
    advertId: number;
    campName: string;
    advertType: number;
    paymentType: string;
    advertStatus: number;
}

interface AdvertV2 {
    id: number;
    settings?: { name?: string; payment_type?: string };
    nm_settings?: Array<{ nm_id: number }>;
    status?: number;
}

/** Списание: [дата МСК, кампания, сумма ₽, источник, номер документа]. */
export type AdCharge = [string, number, number, string, number];

export interface AdCampaign {
    id: number;
    name: string;
    nmIds: number[];
    /** cpm — за показы, cpc — за клики; как отдаёт WB. */
    paymentType: string;
    /** Кампании нет в списке WB — удалена давно; состав неизвестен. */
    missing?: boolean;
}

export interface AdSpendData {
    charges: AdCharge[];
    campaigns: AdCampaign[];
}

async function fetchAdSpend(
    cabinet: Cabinet,
    from: string,
    to: string,
    report: (progress: string) => void
): Promise<{ data: AdSpendData; sourceRows: number }> {
    // Соседние окна заходят друг на друга на сутки: как бы WB ни резал стык
    // (по UTC, по МСК, включительно или нет), списание на стыке придёт хотя бы
    // в одном окне. Повтор из обоих окон убираем по ключу списания. Номер
    // документа updNum сам по себе не уникален — один документ на неделю и все
    // кампании, а у кэшбэка он 0, — поэтому ключ — документ, кампания, момент,
    // источник и сумма: два списания, совпавшие во всём этом, — одно и то же.
    const byKey = new Map<string, UpdRow>();
    const parts = windows(addDays(from, -1), addDays(to, 1), UPD_WINDOW_DAYS, 1);
    for (const [i, [a, b]] of parts.entries()) {
        report(`история затрат: окно ${i + 1} из ${parts.length}`);
        const part = await wbJson<UpdRow[] | null>(cabinet, 'promotion', { path: '/adv/v1/upd', query: { from: a, to: b } });
        for (const r of Array.isArray(part) ? part : []) {
            byKey.set(`${r.updNum}\u0001${r.advertId}\u0001${r.updTime}\u0001${r.paymentType}\u0001${r.updSum}`, r);
        }
    }
    const rows = [...byKey.values()];

    const picked = rows.filter(r => {
        const d = mskDateOf(r.updTime);
        return d >= from && d <= to;
    });
    const charges: AdCharge[] = picked
        .map(r => [mskDateOf(r.updTime), r.advertId, Number(r.updSum) || 0, r.paymentType || '', r.updNum] as AdCharge)
        .sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1]);

    const names = new Map<number, string>();
    for (const r of picked) if (!names.has(r.advertId)) names.set(r.advertId, r.campName);
    const ids = [...names.keys()];
    const campaigns = new Map<number, AdCampaign>();
    for (let i = 0; i < ids.length; i += ADVERTS_BATCH) {
        report(`состав кампаний: ${i} из ${ids.length}`);
        const chunk = ids.slice(i, i + ADVERTS_BATCH);
        const res = await wbJson<{ adverts?: AdvertV2[] } | null>(cabinet, 'promotion', {
            path: '/api/advert/v2/adverts',
            query: { ids: chunk.join(',') }
        });
        for (const a of res?.adverts ?? []) {
            campaigns.set(a.id, {
                id: a.id,
                name: a.settings?.name || names.get(a.id) || '',
                nmIds: [...new Set((a.nm_settings ?? []).map(n => n.nm_id))].sort((x, y) => x - y),
                paymentType: a.settings?.payment_type ?? ''
            });
        }
    }
    for (const id of ids) {
        if (!campaigns.has(id)) campaigns.set(id, { id, name: names.get(id) ?? '', nmIds: [], paymentType: '', missing: true });
    }
    return { data: { charges, campaigns: [...campaigns.values()] }, sourceRows: picked.length };
}

/** Списания за день приходят до конца следующих суток по МСК; день запаса. */
export const adSpendClosed = (to: string): boolean => mskToday() > addDays(to, 1);

export async function loadAdSpend(
    cabinet: Cabinet,
    from: string,
    to: string,
    opts: LoadOptions
): Promise<FinanceSnapshot<AdSpendData>> {
    return loadFinance<AdSpendData>(
        'ads',
        cabinet,
        from,
        to,
        adSpendClosed(to),
        report => fetchAdSpend(cabinet, from, to, report),
        opts
    );
}
