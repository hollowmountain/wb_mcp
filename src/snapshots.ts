/**
 * Ночные снимки остатков и баланса.
 *
 * Для отчёта «3 Формы» нужен остаток товара на площадках и баланс WB на
 * 1-е число, а задним числом их не отдаёт ни Wildberries, ни Ozon: и отчёт
 * об остатках, и баланс показывают только «сейчас». Поэтому сервер снимает
 * их сам каждую ночь в 00:05 по Москве и хранит больше 13 месяцев.
 *
 * Снимок с датой D сделан в начале суток D — это остаток на конец D−1.
 * Если сервер в полночь лежал, снимок делается сразу после запуска, и время
 * снимка показывается рядом с датой: подменять одно другим молча нельзя.
 *
 * Данные лежат сжатым JSON: остатки трёх кабинетов WB по складам весят
 * сотни килобайт в день, а диск на сервере маленький.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { config } from './config.js';
import { db } from './db/index.js';
import { logger } from './logger.js';
import { post, retryOn429, type OzonCabinet } from './ozon/client.js';
import { getWarehouseRemains, splitRemains } from './wb/api.js';
import type { Cabinet } from './wb/cabinets.js';
import { wbJson } from './wb/client.js';
import { sleep } from './wb/ratelimit.js';

db.exec(`
CREATE TABLE IF NOT EXISTS snapshots (
  kind     TEXT NOT NULL,
  cabinet  TEXT NOT NULL,
  -- Дата по Москве, на начало которой снят остаток.
  day      TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  rows     INTEGER NOT NULL,
  data     BLOB NOT NULL,
  PRIMARY KEY (kind, cabinet, day)
);
`);

export type SnapshotKind = 'wb_stock' | 'wb_balance' | 'ozon_stock';

export interface WbStockItem {
    nmId: number;
    size: string;
    /** Артикул продавца. */
    article: string;
    barcode: string;
    onHand: number;
    toCustomers: number;
    returning: number;
    /** Только реальные склады с ненулевым остатком: [название, штук]. */
    warehouses: Array<[string, number]>;
}

export interface WbBalance {
    currency: string;
    current: number;
    forWithdraw: number;
}

export interface OzonStockItem {
    sku: number;
    article: string;
    warehouse: string;
    cluster: string;
    /** Ненулевые счётчики как их называет Ozon: available_stock_count и т.д. */
    counts: Record<string, number>;
}

export interface Snapshot<T> {
    kind: SnapshotKind;
    cabinet: string;
    day: string;
    takenAt: number;
    rows: number;
    data: T;
}

/** 13 месяцев с запасом: отчёт сравнивают с тем же месяцем прошлого года. */
const KEEP_DAYS = 400;

/** Снимаем не ровно в полночь: дать площадкам дописать последние движения дня. */
const START_MINUTE = 5;

/** Если площадка не ответила, повторяем не каждую минуту, а через четверть часа. */
const RETRY_AFTER_MS = 15 * 60 * 1000;

const MSK_MS = 3 * 60 * 60 * 1000;

export const mskDay = (at = new Date()): string => new Date(at.getTime() + MSK_MS).toISOString().slice(0, 10);

const mskMinuteOfDay = (at: Date): number => {
    const msk = new Date(at.getTime() + MSK_MS);
    return msk.getUTCHours() * 60 + msk.getUTCMinutes();
};

// ─── Снятие ──────────────────────────────────────────────────────────────────

async function captureWbStock(cabinet: Cabinet): Promise<WbStockItem[]> {
    // Ночью WB готовит отчёт дольше, чем днём, — ждём с запасом.
    const rows = await getWarehouseRemains(cabinet, 300_000);
    // Пустой отчёт — сбой WB, а не пустые склады: записанный ноль задним числом
    // уже не исправить, поэтому лучше повторить через четверть часа.
    if (rows.length === 0) throw new Error('WB вернул пустой отчёт об остатках');
    return rows.map(r => {
        const s = splitRemains(r);
        return {
            nmId: r.nmId,
            size: r.techSize ?? '',
            article: r.vendorCode ?? '',
            barcode: r.barcode ?? '',
            onHand: s.onHand,
            toCustomers: s.toCustomers,
            returning: s.returning,
            warehouses: s.warehouses.map(w => [w.warehouseName, w.quantity])
        };
    });
}

async function captureWbBalance(cabinet: Cabinet): Promise<WbBalance> {
    const res = await wbJson<{ currency?: string; current?: number; for_withdraw?: number }>(cabinet, 'finance', {
        path: '/api/v1/account/balance'
    });
    if (typeof res?.current !== 'number') throw new Error('WB вернул баланс без поля current');
    return { currency: res.currency ?? 'RUB', current: res.current, forWithdraw: res.for_withdraw ?? 0 };
}

/**
 * Какие счётчики Ozon берём из /v1/analytics/stocks.
 *
 * Оборачиваемость, среднесуточные продажи и грейды — не остаток, их не храним.
 * Остальное храним всё ненулевое: какие из полей Ozon складывать в «на складе»,
 * решается при чтении, а пропущенное сегодня завтра уже не снять.
 */
const isOzonCount = (key: string): boolean =>
    key.endsWith('_stock_count') || key.startsWith('outbound_') || key.startsWith('inbound_') || key === 'stock_not_being_sold';

async function ozonSkus(cabinet: OzonCabinet): Promise<number[]> {
    const skus: number[] = [];
    let lastId = '';
    for (let page = 0; page < 50; page++) {
        const res = await retryOn429(() =>
            post<{ result?: { items?: Array<{ sku?: number }>; last_id?: string } }>(cabinet, '/v3/product/list', {
                filter: { visibility: 'ALL' },
                limit: 1000,
                last_id: lastId
            })
        );
        const items = res.result?.items ?? [];
        for (const it of items) if (it.sku) skus.push(it.sku);
        lastId = res.result?.last_id ?? '';
        if (items.length < 1000 || !lastId) break;
    }
    return skus;
}

/**
 * Остатки Ozon по товарам и складам.
 *
 * /v1/analytics/stocks, а не /v2/analytics/stock_on_warehouses: у старого метода
 * нет ни товаров в пути, ни возвратов от покупателей, а они нужны для баланса.
 * Проверено 31.10.2026: available_stock_count по товару совпадает с present
 * схемы FBO из /v4/product/info/stocks.
 */
async function captureOzonStock(cabinet: OzonCabinet): Promise<OzonStockItem[]> {
    const skus = await ozonSkus(cabinet);
    const out: OzonStockItem[] = [];
    for (let i = 0; i < skus.length; i += 100) {
        if (i > 0) await sleep(1000);
        const res = await retryOn429(() =>
            post<{ items?: Array<Record<string, unknown>> }>(cabinet, '/v1/analytics/stocks', {
                skus: skus.slice(i, i + 100).map(String)
            })
        );
        for (const it of res.items ?? []) {
            const counts: Record<string, number> = {};
            for (const [key, value] of Object.entries(it)) {
                if (typeof value === 'number' && value !== 0 && isOzonCount(key)) counts[key] = value;
            }
            if (Object.keys(counts).length === 0) continue;
            out.push({
                sku: Number(it.sku ?? 0),
                article: String(it.offer_id ?? ''),
                warehouse: String(it.warehouse_name ?? ''),
                cluster: String(it.cluster_name ?? ''),
                counts
            });
        }
    }
    if (skus.length > 0 && out.length === 0) throw new Error('Ozon не вернул ни одной строки остатков');
    return out;
}

// ─── Хранение ────────────────────────────────────────────────────────────────

const exists = db.prepare('SELECT 1 FROM snapshots WHERE kind = ? AND cabinet = ? AND day = ?');
const insert = db.prepare(
    'INSERT OR REPLACE INTO snapshots (kind, cabinet, day, taken_at, rows, data) VALUES (?, ?, ?, ?, ?, ?)'
);
const prune = db.prepare('DELETE FROM snapshots WHERE day < ?');
const selectOne = db.prepare('SELECT kind, cabinet, day, taken_at, rows, data FROM snapshots WHERE kind = ? AND cabinet = ? AND day = ?');
const selectDays = db.prepare('SELECT day FROM snapshots WHERE kind = ? AND cabinet = ? ORDER BY day');

function save(kind: SnapshotKind, cabinet: string, day: string, rows: number, data: unknown): void {
    insert.run(kind, cabinet, day, Date.now(), rows, gzipSync(JSON.stringify(data)));
}

export function readSnapshot<T>(kind: SnapshotKind, cabinet: string, day: string): Snapshot<T> | undefined {
    const row = selectOne.get(kind, cabinet, day) as
        | { kind: SnapshotKind; cabinet: string; day: string; taken_at: number; rows: number; data: Buffer }
        | undefined;
    if (!row) return undefined;
    return {
        kind: row.kind,
        cabinet: row.cabinet,
        day: row.day,
        takenAt: row.taken_at,
        rows: row.rows,
        data: JSON.parse(gunzipSync(row.data).toString('utf8')) as T
    };
}

export const snapshotDays = (kind: SnapshotKind, cabinet: string): string[] =>
    (selectDays.all(kind, cabinet) as Array<{ day: string }>).map(r => r.day);

// ─── Расписание ──────────────────────────────────────────────────────────────

const failedAt = new Map<string, number>();
let running = false;

async function once<T>(
    kind: SnapshotKind,
    cabinet: string,
    day: string,
    capture: () => Promise<{ rows: number; data: T }>
): Promise<void> {
    if (exists.get(kind, cabinet, day)) return;
    const key = `${kind}:${cabinet}`;
    const failed = failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return;
    try {
        const { rows, data } = await capture();
        save(kind, cabinet, day, rows, data);
        failedAt.delete(key);
        logger.info({ kind, cabinet, day, rows }, 'снимок сохранён');
    } catch (e) {
        failedAt.set(key, Date.now());
        logger.warn({ kind, cabinet, day, err: e instanceof Error ? e.message : String(e) }, 'снимок не удался, повторим позже');
    }
}

/**
 * Делает недостающие снимки за сегодня. Вызывается раз в минуту: если снимок
 * уже есть, это один SELECT. Кабинеты идут по очереди — лимиты площадок
 * считаются на продавца, и параллельные отчёты друг другу только мешают.
 */
export async function takeDueSnapshots(at = new Date()): Promise<void> {
    if (running || mskMinuteOfDay(at) < START_MINUTE) return;
    running = true;
    const day = mskDay(at);
    try {
        const wb = config.cabinets.all().filter(c => c.dataToken);
        // Баланс — первым по всем кабинетам: он меняется каждую минуту, а отчёт
        // об остатках готовится долго и отодвинул бы снимок баланса от полуночи.
        for (const cabinet of wb) {
            await once('wb_balance', cabinet.slug, day, async () => ({ rows: 1, data: await captureWbBalance(cabinet) }));
        }
        for (const cabinet of wb) {
            await once('wb_stock', cabinet.slug, day, async () => {
                const data = await captureWbStock(cabinet);
                return { rows: data.length, data };
            });
        }
        for (const cabinet of config.ozon) {
            await once('ozon_stock', cabinet.slug, day, async () => {
                const data = await captureOzonStock(cabinet);
                return { rows: data.length, data };
            });
        }
        prune.run(mskDay(new Date(at.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000)));
    } finally {
        running = false;
    }
}

export function startSnapshots(): void {
    // Первый проход — вскоре после запуска: если сервер перезапускали
    // в полночь, сегодняшний снимок не должен потеряться.
    setTimeout(() => void takeDueSnapshots(), 30_000).unref();
    setInterval(() => void takeDueSnapshots(), 60_000).unref();
}
