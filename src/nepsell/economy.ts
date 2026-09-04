/**
 * Сведение отчётов Nepsell к пригодному для чтения виду.
 *
 * Отчёт приходит «длинной» таблицей: за две недели по одному кабинету это
 * шесть с лишним тысяч строк. Отдавать такое модели нельзя — она захлебнётся,
 * а человек получит кашу вместо ответа.
 */
import { itemIdOf } from './client.js';
import type { AdMetricRow, MetricRow, NepsellClient } from './client.js';

/** Метрики, которые складываются по товарам. */
const ADDITIVE = [
    'revenue_sum',
    'client_revenue_sum',
    'cost_sum',
    'sale_commission_sum',
    'logistic_price_sum',
    'ad_sum',
    'taxes_sum',
    'expences_sum',
    'gross_profit_sum',
    'profit_sum',
    'val_profit_sum',
    'sales_count'
] as const;

/**
 * ROI приходит по каждому товару отдельно. Складывать такие величины нельзя:
 * сумма четырёхсот значений ROI не означает ничего. Считаем маржу сами из
 * итогов и честно помечаем как свой расчёт.
 */
const NON_ADDITIVE = new Set(['roi', 'gross_roi']);

export interface EconomyTotals {
    revenue: number;
    clientRevenue: number;
    cost: number;
    commission: number;
    logistics: number;
    ads: number;
    taxes: number;
    expenses: number;
    grossProfit: number;
    profit: number;
    salesCount: number;
    /** Наш расчёт: прибыль к выручке. У Nepsell своя формула ROI, её не берём. */
    marginPercent: number | null;
}

export interface ItemEconomy {
    nmId: string;
    revenue: number;
    cost: number;
    profit: number;
    salesCount: number;
    marginPercent: number | null;
}

export interface EconomyReport {
    totals: EconomyTotals;
    items: ItemEconomy[];
    /** Метрики, которые пришли, но которые мы сознательно не складывали. */
    skipped: string[];
}

const pct = (part: number, whole: number): number | null =>
    whole === 0 ? null : Number(((part / whole) * 100).toFixed(2));

export function summariseFinances(rows: MetricRow[]): EconomyReport {
    const sums = new Map<string, number>();
    const perItem = new Map<string, Map<string, number>>();
    const skipped = new Set<string>();

    for (const r of rows) {
        if (NON_ADDITIVE.has(r.metric_name)) {
            skipped.add(r.metric_name);
            continue;
        }
        if (!(ADDITIVE as readonly string[]).includes(r.metric_name)) {
            skipped.add(r.metric_name);
            continue;
        }
        const v = typeof r.metric_value === 'number' ? r.metric_value : 0;
        sums.set(r.metric_name, (sums.get(r.metric_name) ?? 0) + v);

        const key = itemIdOf(r);
        const item = perItem.get(key) ?? new Map<string, number>();
        item.set(r.metric_name, (item.get(r.metric_name) ?? 0) + v);
        perItem.set(key, item);
    }

    const g = (name: string): number => Number((sums.get(name) ?? 0).toFixed(2));
    const totals: EconomyTotals = {
        revenue: g('revenue_sum'),
        clientRevenue: g('client_revenue_sum'),
        cost: g('cost_sum'),
        commission: g('sale_commission_sum'),
        logistics: g('logistic_price_sum'),
        ads: g('ad_sum'),
        taxes: g('taxes_sum'),
        expenses: g('expences_sum'),
        grossProfit: g('gross_profit_sum'),
        profit: g('profit_sum'),
        salesCount: g('sales_count'),
        marginPercent: pct(g('profit_sum'), g('revenue_sum'))
    };

    const items: ItemEconomy[] = [...perItem.entries()]
        .map(([nmId, m]) => {
            const revenue = Number((m.get('revenue_sum') ?? 0).toFixed(2));
            const profit = Number((m.get('profit_sum') ?? 0).toFixed(2));
            return {
                nmId,
                revenue,
                cost: Number((m.get('cost_sum') ?? 0).toFixed(2)),
                profit,
                salesCount: m.get('sales_count') ?? 0,
                marginPercent: pct(profit, revenue)
            };
        })
        .sort((a, b) => b.profit - a.profit);

    return { totals, items, skipped: [...skipped].sort() };
}

// ─── Реклама ─────────────────────────────────────────────────────────────────

/**
 * Метрики рекламы, которые складываются по кампаниям.
 *
 * Готовые коэффициенты Nepsell — sales_drr, ctr, romi, conversion_to_order,
 * bayout, click_price, order_price — сюда не входят намеренно: среднее из
 * отношений не равно отношению сумм, а складывать их и вовсе бессмысленно.
 * Считаем сами из итогов.
 *
 * Отдельно про единицы: sales_drr Nepsell хранит ДОЛЕЙ, не процентом —
 * 0.345 означает 34,5%. Сверено 02.09.2026 по тринадцати кампаниям: наш
 * spend/sales*100 совпал с их значением, умноженным на сто, у двенадцати
 * из тринадцати, тринадцатая разошлась на сотые от округления.
 */
const AD_ADDITIVE = new Set([
    'ads_sum',
    'views',
    'clicks',
    'carts',
    'orders',
    'direct_orders',
    'assoc_orders',
    'orders_sum',
    'sales_count',
    'sales_sum',
    'gross_profit_sum',
    'profit_sum'
]);

export interface AdTotals {
    spend: number;
    views: number;
    clicks: number;
    carts: number;
    orders: number;
    directOrders: number;
    assocOrders: number;
    ordersSum: number;
    salesCount: number;
    salesSum: number;
    /** Наш расчёт: доля расходов на рекламу в продажах, привязанных к ней. */
    drrPercent: number | null;
    ctrPercent: number | null;
    clickPrice: number | null;
}

export interface CampaignEconomy extends AdTotals {
    campaignId: string;
    name: string;
    type: string;
    nmIds: string[];
    assocNmIds: string[];
}

function adTotalsFrom(m: Map<string, number>): AdTotals {
    const g = (k: string): number => Number((m.get(k) ?? 0).toFixed(2));
    const spend = g('ads_sum');
    const salesSum = g('sales_sum');
    const views = g('views');
    const clicks = g('clicks');
    return {
        spend,
        views,
        clicks,
        carts: g('carts'),
        orders: g('orders'),
        directOrders: g('direct_orders'),
        assocOrders: g('assoc_orders'),
        ordersSum: g('orders_sum'),
        salesCount: g('sales_count'),
        salesSum,
        drrPercent: pct(spend, salesSum),
        ctrPercent: pct(clicks, views),
        clickPrice: clicks === 0 ? null : Number((spend / clicks).toFixed(2))
    };
}

export function summariseAds(
    metrics: AdMetricRow[],
    campaigns: Array<{
        campaign_id: string;
        campaign_name: string;
        campaign_type: string;
        nm_ids?: string[];
        assoc_nm_ids?: string[];
        skus?: string[];
    }>
): { totals: AdTotals; campaigns: CampaignEconomy[] } {
    const all = new Map<string, number>();
    const per = new Map<string, Map<string, number>>();

    for (const r of metrics) {
        if (!AD_ADDITIVE.has(r.metric_name)) continue;
        const v = typeof r.metric_value === 'number' ? r.metric_value : 0;
        all.set(r.metric_name, (all.get(r.metric_name) ?? 0) + v);
        const c = per.get(r.campaign_id) ?? new Map<string, number>();
        c.set(r.metric_name, (c.get(r.metric_name) ?? 0) + v);
        per.set(r.campaign_id, c);
    }

    const byId = new Map(campaigns.map(c => [c.campaign_id, c]));
    const list: CampaignEconomy[] = [...per.entries()]
        .map(([campaignId, m]) => {
            const info = byId.get(campaignId);
            return {
                campaignId,
                name: info?.campaign_name ?? campaignId,
                type: info?.campaign_type ?? '',
                nmIds: info?.nm_ids ?? info?.skus ?? [],
                assocNmIds: info?.assoc_nm_ids ?? [],
                ...adTotalsFrom(m)
            };
        })
        .sort((a, b) => b.spend - a.spend);

    return { totals: adTotalsFrom(all), campaigns: list };
}

// ─── Сопоставление кабинетов ─────────────────────────────────────────────────

export interface CabinetLink {
    slug: string;
    wb: NepsellClient | null;
    ozon: NepsellClient | null;
}

/**
 * Nepsell называет кабинет «w» + oid для Wildberries и «o» + Client-Id для
 * Ozon. И то и другое у нас уже есть: oid лежит в токене WB, Client-Id — в
 * настройках Ozon. Поэтому сопоставление строится само, без ручных таблиц.
 */
export function linkCabinets(
    clients: NepsellClient[],
    wb: Array<{ slug: string; orgId: number | null }>,
    ozon: Array<{ slug: string; clientId: string }>
): CabinetLink[] {
    const byId = new Map(clients.map(c => [c.client_id, c]));
    const slugs = new Set([...wb.map(c => c.slug), ...ozon.map(c => c.slug)]);

    return [...slugs].map(slug => {
        const w = wb.find(c => c.slug === slug);
        const o = ozon.find(c => c.slug === slug);
        return {
            slug,
            wb: w?.orgId ? (byId.get(`w${w.orgId}`) ?? null) : null,
            ozon: o ? (byId.get(`o${o.clientId}`) ?? null) : null
        };
    });
}
