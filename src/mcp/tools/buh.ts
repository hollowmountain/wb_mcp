/**
 * Бухгалтерские базы юрлиц (1С:Бухгалтерия) — только чтение.
 *
 * Появились 24.10.2026 по задаче бухгалтерии: Claude сверяет управленческую
 * УНФ с официальным учётом. Баз три (ИП Арасланов А.Г., ИП Арасланова З.Г.,
 * ООО «КРАСОТА»), конфигурация другая, чем у УНФ, поэтому белый список УНФ
 * здесь не годится: читается ровно то, что администратор базы опубликовал
 * в OData (список берётся из $metadata).
 *
 * В одной базе бывает несколько организаций (в базе «Красоты» их четыре),
 * поэтому каждый ответ подписан базой, а итоги разложены по организациям —
 * чтобы цифры разных юрлиц не слиплись в одну.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { inArea } from '../../auth/provider.js';
import { config } from '../../config.js';
import { listEntity, listEntitySets, nextDay, type OnecConfig, type OnecEntity } from '../../onec/client.js';
import { actorOf, amount, badDay, explainError, fail, guarded, isDay, pageOf, text } from './common.js';

const dash = '—';
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const rub = (v: number): string => `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY = '00000000-0000-0000-0000-000000000000';

/**
 * Разделы про людей и их доходы. Открываются только вместе с областью payroll,
 * как и в УНФ: проводки по зарплате читаются по фамилиям.
 */
const PERSONAL = /Зарплат|Сотрудник|ФизическиеЛица|Ведомост|НДФЛ|Отпуск|Больничн|Кадров|ЛичныеДанные|Страхов|Увольнени|ПриемНаРаботу/i;

/** Сколько строк одной выборки. 1С отдаёт и больше, но 1000 — разумная страница. */
const PAGE = 1000;

type Base = { key: string; label: string; url: string };

const cfgOf = (b: Base, allow?: (e: string) => boolean): OnecConfig => ({
    baseUrl: b.url,
    user: config.buh.user,
    password: config.buh.password,
    allow
});

/** Опубликованное в базе: кэш на 30 минут, $metadata тяжёлый. */
const published = new Map<string, { at: number; names: Set<string> }>();
async function publishedOf(b: Base): Promise<Set<string>> {
    const hit = published.get(b.key);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.names;
    const names = new Set(await listEntitySets(cfgOf(b)));
    published.set(b.key, { at: Date.now(), names });
    return names;
}

/** Корень имени: «AccountingRegister_Хозрасчетный/Balance(…)» → «AccountingRegister_Хозрасчетный». */
const rootOf = (entity: string): string => entity.split('/')[0]!.split('(')[0]!;

/** Клиент с проверкой «опубликовано ли» и «можно ли этому человеку про людей». */
async function readerFor(b: Base, actor: Actor): Promise<OnecConfig> {
    const names = await publishedOf(b);
    const people = inArea(actor, 'payroll');
    return cfgOf(b, e => names.has(rootOf(e)) && (people || !PERSONAL.test(rootOf(e))));
}

const head = (b: Base): string => `База: ${b.label} (${b.key})`;

/**
 * Названия по ссылкам. GUID-ов в одном запросе — не больше 20: длинную строку режет IIS (404.15).
 *
 * Неопубликованный справочник (или про людей без payroll) — не ошибка: allow
 * его не пускает, и вызывающий подписывает такие ссылки «название скрыто».
 * А вот сбой при чтении опубликованного глотать нельзя: позиции молча
 * остались бы без названий или слиплись в одну строку. Причину кладём в
 * problems — вызывающий обязан написать её в ответе.
 */
async function namesOf(cfg: OnecConfig, entity: string, keys: string[], problems: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const uniq = [...new Set(keys.filter(k => GUID.test(k) && k !== EMPTY))];
    if (!cfg.allow?.(entity)) return out;
    for (let i = 0; i < uniq.length; i += 20) {
        const part = uniq.slice(i, i + 20);
        try {
            const rows = await listEntity<{ Ref_Key: string; Description?: string }>(cfg, entity as OnecEntity, {
                top: part.length,
                filter: part.map(k => `Ref_Key eq guid'${k}'`).join(' or '),
                select: 'Ref_Key,Description'
            });
            for (const r of rows) out.set(r.Ref_Key, r.Description ?? dash);
        } catch (e) {
            problems.push(`справочник «${entity}» не загрузился: ${explainError(e)}`);
            break;
        }
    }
    return out;
}

/** «StandardODATA.Catalog_Контрагенты» → «Catalog_Контрагенты». */
const entityOfType = (t: unknown): string | null =>
    typeof t === 'string' && t.startsWith('StandardODATA.') ? t.slice('StandardODATA.'.length) : null;

/** Организации базы: ключ → название, и отбор по подстроке. */
async function orgsOf(cfg: OnecConfig): Promise<Map<string, string>> {
    const rows = await listEntity<{ Ref_Key: string; Description: string }>(cfg, 'Catalog_Организации' as OnecEntity, {
        top: 50,
        select: 'Ref_Key,Description'
    });
    return new Map(rows.map(r => [r.Ref_Key, r.Description]));
}

function pickOrgs(orgs: Map<string, string>, find: string | undefined): string[] | null {
    if (!find?.trim()) return null;
    const needle = find.trim().toLowerCase();
    return [...orgs].filter(([, name]) => name.toLowerCase().includes(needle)).map(([k]) => k);
}

/**
 * Банковские документы за период, все страницы. Живут десять минут: ради
 * листания страницы одного месяца должны браться из одного снимка, иначе
 * новый документ сдвинет offset и строка пропадёт или повторится.
 * capped — упёрлись в 20 страниц, выгрузка неполная.
 */
const BANK_TTL = 10 * 60_000;
const bankCache = new Map<string, { at: number; rows: Record<string, unknown>[]; capped: boolean }>();
async function bankDocs(cfg: OnecConfig, b: Base, entity: string, filter: string): Promise<{ rows: Record<string, unknown>[]; capped: boolean }> {
    const key = `${b.key}|${entity}|${filter}`;
    const hit = bankCache.get(key);
    if (hit && Date.now() - hit.at < BANK_TTL) return hit;
    const rows: Record<string, unknown>[] = [];
    let capped = false;
    for (let page = 0; ; page++) {
        const part = await listEntity<Record<string, unknown>>(cfg, entity as OnecEntity, {
            top: PAGE,
            skip: page * PAGE,
            filter,
            orderby: 'Date,Ref_Key',
            select:
                'Ref_Key,Number,Date,Posted,Организация_Key,ВидОперации,Контрагент,Контрагент_Type,СуммаДокумента,' +
                'НазначениеПлатежа,СтатьяДвиженияДенежныхСредств_Key'
        });
        rows.push(...part);
        if (part.length < PAGE) break;
        if (page >= 19) {
            capped = true;
            break;
        }
    }
    const value = { at: Date.now(), rows, capped };
    // Протухшие выгрузки выбрасываем, чтобы память сервера не копила месяцы.
    for (const [k, v] of bankCache) if (Date.now() - v.at >= BANK_TTL) bankCache.delete(k);
    bankCache.set(key, value);
    return value;
}

/**
 * Название и ИНН по ссылкам — для контрагентов, физлиц, статей ДДС.
 * ИНН есть только у контрагентов; у физлица он личный и не нужен.
 * Справочники меняются редко, поэтому десять минут помним, что уже спросили.
 */
const cardCache = new Map<string, { at: number; cards: Map<string, { name: string; inn: string }> }>();
async function cardsOf(
    cfg: OnecConfig,
    b: Base,
    entity: string,
    keys: string[],
    /** Сюда — причина, если опубликованный справочник не прочитался (см. namesOf). */
    problems: string[]
): Promise<Map<string, { name: string; inn: string }>> {
    const out = new Map<string, { name: string; inn: string }>();
    if (!cfg.allow?.(entity)) return out;
    const ck = `${b.key}|${entity}`;
    const hit = cardCache.get(ck);
    const known = hit && Date.now() - hit.at < BANK_TTL ? hit.cards : new Map<string, { name: string; inn: string }>();
    if (known !== hit?.cards) cardCache.set(ck, { at: Date.now(), cards: known });
    const withInn = entity === 'Catalog_Контрагенты';
    const uniq = [...new Set(keys.filter(k => GUID.test(k) && k !== EMPTY))];
    const missing = uniq.filter(k => !known.has(k));
    // GUID-ов в одном запросе — не больше 20: длинную строку режет IIS (404.15).
    for (let i = 0; i < missing.length; i += 20) {
        const part = missing.slice(i, i + 20);
        try {
            const rows = await listEntity<{ Ref_Key: string; Description?: string; ИНН?: string }>(cfg, entity as OnecEntity, {
                top: part.length,
                filter: part.map(k => `Ref_Key eq guid'${k}'`).join(' or '),
                select: withInn ? 'Ref_Key,Description,ИНН' : 'Ref_Key,Description'
            });
            for (const r of rows) known.set(r.Ref_Key, { name: (r.Description ?? dash).trim(), inn: (r.ИНН ?? '').trim() });
        } catch (e) {
            problems.push(`справочник «${entity}» не загрузился: ${explainError(e)}`);
            break;
        }
    }
    for (const k of uniq) {
        const v = known.get(k);
        if (v) out.set(k, v);
    }
    return out;
}

export function registerBuhTools(server: McpServer, _actor: Actor): void {
    const bases = config.buh.bases;
    if (bases.length === 0 || !config.buh.user) return;
    const keys = bases.map(b => b.key) as [string, ...string[]];
    const baseOf = (key: string): Base => bases.find(b => b.key === key)!;
    const baseArg = z
        .enum(keys)
        .describe(`Какая база: ${bases.map(b => `${b.key} — ${b.label}`).join('; ')}. Данные баз не смешивать.`);

    server.registerTool(
        'buh_entities',
        {
            title: 'Бухгалтерия: что есть в базе',
            description:
                'Разделы бухгалтерской базы юрлица (1С:Бухгалтерия), которые можно прочитать через buh_read. ' +
                'Поиск по части названия — как раздел называется в 1С, например «Поступление», «Хозрасчетн», «Контрагент».',
            inputSchema: {
                base: baseArg,
                find: z.string().optional().describe('Часть названия раздела'),
                kind: z.enum(['все', 'справочники', 'документы', 'регистры']).optional().describe('По умолчанию все')
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        guarded('buh_entities', async (args, extra) => {
            const actor = actorOf(extra);
            const b = baseOf(args.base);
            const cfg = await readerFor(b, actor);
            const prefix = { справочники: 'Catalog_', документы: 'Document_', регистры: 'Register_', все: '' }[args.kind ?? 'все'];
            const needle = args.find?.trim().toLowerCase();
            const rows = [...(await publishedOf(b))]
                .filter(e => cfg.allow!(e))
                .filter(e => (prefix === 'Register_' ? e.includes('Register_') : e.startsWith(prefix)))
                .filter(e => !needle || e.toLowerCase().includes(needle))
                .sort();
            if (rows.length === 0) return text(`${head(b)}\nРазделов по запросу нет. Попробуйте часть слова короче.`);
            const shown = rows.slice(0, 200);
            return text(
                [
                    head(b),
                    `Разделов: ${rows.length}${rows.length > shown.length ? ` (показаны первые ${shown.length} — уточните поиск)` : ''}`,
                    '',
                    ...shown.map(e => `   ${e}`),
                    '',
                    'Читать — buh_read, имя брать целиком. Табличные части — через подчёркивание: Document_РеализацияТоваровУслуг_Товары.',
                    'Остаток по счёту на дату — buh_balance, банковские поступления и списания — buh_bank.'
                ].join('\n')
            );
        })
    );

    server.registerTool(
        'buh_read',
        {
            title: 'Бухгалтерия: прочитать раздел базы',
            description:
                'Читает любой опубликованный раздел бухгалтерской базы юрлица по имени (имена — buh_entities). ' +
                'Только чтение. Ссылки приходят GUID-ами в полях …_Key. Для остатков по счетам и банка есть ' +
                'готовые buh_balance и buh_bank — там уже сведено и расшифровано.',
            inputSchema: {
                base: baseArg,
                entity: z.string().min(3).describe('Имя раздела целиком, например Document_ОтчетКомиссионераОПродажах'),
                filter: z
                    .string()
                    .optional()
                    .describe("OData $filter, например: Date ge datetime'2026-09-01T00:00:00' and Posted eq true"),
                select: z.string().optional().describe('Поля через запятую. Пусто — все.'),
                orderby: z.string().optional().describe('Сортировка, например Date desc'),
                top: z.number().int().min(1).max(200).optional().describe('Сколько строк, по умолчанию 20'),
                skip: z.number().int().min(0).optional().describe('Сколько пропустить — для листания (вместе с orderby)')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('buh_read', async (args, extra) => {
            const actor = actorOf(extra);
            const b = baseOf(args.base);
            const cfg = await readerFor(b, actor);
            const entity = args.entity.trim();
            if (!cfg.allow!(entity)) {
                return fail(
                    `${head(b)}\nРаздела «${rootOf(entity)}» в этой базе не опубликовано` +
                        (PERSONAL.test(rootOf(entity)) && !inArea(actor, 'payroll') ? ' либо он про людей и оплату труда (нужна область payroll)' : '') +
                        '. Точные имена — buh_entities.'
                );
            }
            const asked = args.top ?? 20;
            let fetched: Record<string, unknown>[];
            try {
                fetched = await listEntity<Record<string, unknown>>(cfg, entity as OnecEntity, {
                    top: asked + 1,
                    skip: args.skip,
                    filter: args.filter,
                    select: args.select,
                    orderby: args.orderby
                });
            } catch (e) {
                const missing = e instanceof Error ? /Сегмент пути (.+?) не найден/.exec(e.message)?.[1] : undefined;
                if (!missing) throw e;
                const sample = await listEntity<Record<string, unknown>>(cfg, entity as OnecEntity, { top: 1 }).catch(() => []);
                const fields = Object.keys(sample[0] ?? {}).filter(k => !k.includes('@navigationLinkUrl'));
                return fail(`${head(b)}\nВ «${entity}» нет поля «${missing}».` + (fields.length ? ` Поля раздела: ${fields.join(', ')}.` : ''));
            }
            const more = fetched.length > asked;
            const rows = more ? fetched.slice(0, asked) : fetched;
            if (rows.length === 0) return text(`${head(b)}\nВ «${entity}» по такому условию ничего нет.`);
            const render = (r: Record<string, unknown>): string =>
                Object.entries(r)
                    .filter(([k]) => !k.includes('@navigationLinkUrl') && k !== 'DataVersion')
                    .map(([k, v]) => {
                        if (v === null || v === undefined || v === '') return `   ${k}: ${dash}`;
                        if (Array.isArray(v)) return `   ${k}: строк ${v.length}`;
                        if (typeof v === 'object') return `   ${k}: {…}`;
                        return `   ${k}: ${String(v)}`;
                    })
                    .join('\n');
            return text(
                [
                    head(b),
                    `${entity}: строк ${rows.length}${more ? ' (есть ещё — увеличьте top или листайте через skip с orderby)' : ''}`,
                    '',
                    ...rows.map((r, i) => `${i + 1}.\n${render(r)}`)
                ].join('\n')
            );
        })
    );

    server.registerTool(
        'buh_balance',
        {
            title: 'Бухгалтерия: остаток по счёту на дату',
            description:
                'Сальдо по счёту бухучёта (с субсчетами) на конец дня: дебет, кредит, итог — по организациям базы, ' +
                'по субсчетам и самые крупные позиции аналитики (номенклатура, контрагенты и т. п.). ' +
                'Например, счёт 10 — материалы, 41 — товары, 43 — готовая продукция, 51 — расчётный счёт, 60 — поставщики, 62 — покупатели.',
            inputSchema: {
                base: baseArg,
                account: z.string().regex(/^\d{2}(\.\d{1,2}(\.\d)?)?$/).describe('Код счёта: «10», «41.01», «60.01»'),
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('На конец какого дня, ГГГГ-ММ-ДД. По умолчанию сегодня.'),
                organization: z.string().optional().describe('Часть названия организации, если в базе их несколько'),
                top: z.number().int().min(0).max(50).optional().describe('Сколько крупнейших позиций аналитики показать, по умолчанию 15')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('buh_balance', async (args, extra) => {
            if (args.date && !isDay(args.date)) return fail(badDay(args.date));
            const actor = actorOf(extra);
            const b = baseOf(args.base);
            const cfg = await readerFor(b, actor);
            const reg = 'AccountingRegister_Хозрасчетный';
            if (!cfg.allow!(reg) || !cfg.allow!('ChartOfAccounts_Хозрасчетный')) {
                return fail(`${head(b)}\nВ базе не опубликованы регистр «Хозрасчетный» или план счетов — попросите администратора базы.`);
            }
            const date = args.date ?? new Date().toISOString().slice(0, 10);
            const code = args.account;

            const accounts = (
                await listEntity<{ Ref_Key: string; Code: string; Description: string }>(cfg, 'ChartOfAccounts_Хозрасчетный' as OnecEntity, {
                    top: 300,
                    filter: `startswith(Code,${q(code)})`,
                    select: 'Ref_Key,Code,Description'
                })
            ).filter(a => a.Code === code || a.Code.startsWith(`${code}.`));
            if (accounts.length === 0) return fail(`${head(b)}\nСчёта ${code} в плане счетов нет.`);
            const codeOf = new Map(accounts.map(a => [a.Ref_Key, `${a.Code} ${a.Description}`]));

            const orgs = await orgsOf(cfg);
            const orgKeys = pickOrgs(orgs, args.organization);
            if (orgKeys && orgKeys.length === 0) {
                return fail(`${head(b)}\nОрганизации «${args.organization}» в базе нет. Есть: ${[...orgs.values()].join('; ')}.`);
            }

            // Условие по счетам — в $filter, а не в параметре виртуальной таблицы:
            // параметр едет в пути, а IIS режет сегмент пути длиннее 260 знаков.
            // По 15 счетов на запрос, чтобы и строка запроса уложилась в предел.
            // Одним запросом на пачку счетов, без сортировки и листания: $orderby по
            // виртуальной таблице стоил 49 с на страницу (замер 24.10.2026), а всё
            // разом приходит за 3 с. Упёрлись в потолок — честно пишем, что не всё.
            type Row = Record<string, unknown>;
            const rows: Row[] = [];
            let capped = false;
            const CAP = 20_000;
            // Остаток на конец дня — это остаток на начало следующего: на моменте
            // 23:59:59 1С не учитывает документы с этим же временем, а закрытие
            // месяца и регламентные операции датируются как раз им.
            const virt = `${reg}/Balance(Period=datetime'${nextDay(date)}T00:00:00')`;
            for (let i = 0; i < accounts.length; i += 15) {
                const accF = accounts.slice(i, i + 15).map(a => `Account_Key eq guid'${a.Ref_Key}'`).join(' or ');
                const orgF = orgKeys ? ` and (${orgKeys.map(k => `Организация_Key eq guid'${k}'`).join(' or ')})` : '';
                const part = await listEntity<Row>(cfg, virt as OnecEntity, { top: CAP, max: CAP, filter: `(${accF})${orgF}` });
                rows.push(...part);
                if (part.length >= CAP) capped = true;
            }

            const dr = rows.reduce((s, r) => s + num(r.СуммаBalanceDr), 0);
            const cr = rows.reduce((s, r) => s + num(r.СуммаBalanceCr), 0);
            const sum = (pick: (r: Row) => string): Map<string, { dr: number; cr: number }> => {
                const m = new Map<string, { dr: number; cr: number }>();
                for (const r of rows) {
                    const k = pick(r);
                    const v = m.get(k) ?? { dr: 0, cr: 0 };
                    v.dr += num(r.СуммаBalanceDr);
                    v.cr += num(r.СуммаBalanceCr);
                    m.set(k, v);
                }
                return m;
            };
            const line = (name: string, v: { dr: number; cr: number }): string =>
                `   ${name}: ${v.dr ? `Дт ${rub(v.dr)}` : ''}${v.dr && v.cr ? ', ' : ''}${v.cr ? `Кт ${rub(v.cr)}` : ''}${!v.dr && !v.cr ? '0' : ''}`;

            const byOrg = sum(r => orgs.get(String(r.Организация_Key)) ?? 'без организации');
            const byAcc = sum(r => codeOf.get(String(r.Account_Key)) ?? String(r.Account_Key));

            // Крупнейшие позиции первой аналитики — с названиями.
            const topN = args.top ?? 15;
            let topLines: string[] = [];
            if (topN > 0 && rows.length > 0) {
                const byItem = new Map<string, { dr: number; cr: number; type: string | null }>();
                for (const r of rows) {
                    const k = String(r.ExtDimension1 ?? '');
                    const v = byItem.get(k) ?? { dr: 0, cr: 0, type: entityOfType(r.ExtDimension1_Type) };
                    v.dr += num(r.СуммаBalanceDr);
                    v.cr += num(r.СуммаBalanceCr);
                    byItem.set(k, v);
                }
                const top = [...byItem].sort((a, b2) => Math.abs(b2[1].dr - b2[1].cr) - Math.abs(a[1].dr - a[1].cr)).slice(0, topN);
                const names = new Map<string, string>();
                const byType = new Map<string, string[]>();
                for (const [k, v] of top) if (v.type && GUID.test(k)) byType.set(v.type, [...(byType.get(v.type) ?? []), k]);
                const problems: string[] = [];
                for (const [t, ks] of byType) for (const [k, n] of await namesOf(cfg, t, ks, problems)) names.set(k, n);
                topLines = [
                    '',
                    `Крупнейшие позиции (первая аналитика счёта${byItem.size > top.length ? `, ${top.length} из ${byItem.size}` : ''}):`,
                    ...problems.map(m => `ВНИМАНИЕ: ${m} — часть позиций показана ссылками без названий.`),
                    ...top.map(([k, v]) => line(names.get(k) ?? (GUID.test(k) ? `${k} (${v.type ?? 'ссылка'})` : k || 'без аналитики'), v))
                ];
            }

            return text(
                [
                    head(b),
                    `Счёт ${code} с субсчетами, остаток на конец ${date}${orgKeys ? `, организации: ${orgKeys.map(k => orgs.get(k)).join('; ')}` : ''}`,
                    capped
                        ? `ВНИМАНИЕ: строк ${rows.length} и больше — показан НЕ полный остаток. Сузьте: субсчёт или организация.`
                        : `Строк аналитики: ${rows.length}`,
                    '',
                    `Итого: Дт ${rub(dr)}, Кт ${rub(cr)}, сальдо ${rub(dr - cr)}`,
                    '',
                    'По организациям:',
                    ...[...byOrg].map(([n, v]) => line(n, v)),
                    '',
                    'По субсчетам:',
                    ...[...byAcc].sort().map(([n, v]) => line(n, v)),
                    ...topLines
                ].join('\n')
            );
        })
    );

    server.registerTool(
        'buh_bank',
        {
            title: 'Бухгалтерия: банк за период',
            description:
                'Поступления и списания по расчётным счетам из бухгалтерской базы юрлица за период. Только чтение. ' +
                'Без groupBy — сводка: итоги по организациям, крупнейшие контрагенты и последние платежи с назначением. ' +
                'groupBy=payment — все платежи периода компактной таблицей по дате: сумма, контрагент, ИНН, статья ДДС, ' +
                'назначение до 150 знаков. groupBy=counterparty — свод по контрагентам: поступило и списано раздельно, ' +
                'с числом платежей. Итоги вверху — всегда по всем платежам периода, не по странице. Ответ не больше 30 КБ, ' +
                'длинное листается через offset; страницы одного периода 10 минут берутся из одной выгрузки.',
            inputSchema: {
                base: baseArg,
                from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('С какого дня, ГГГГ-ММ-ДД'),
                to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('По какой день включительно'),
                direction: z.enum(['все', 'поступления', 'списания']).optional().describe('По умолчанию все'),
                organization: z.string().optional().describe('Часть названия организации, если в базе их несколько'),
                purpose: z.string().optional().describe('Часть назначения платежа, например «Вайлдберриз» или «аренд»'),
                groupBy: z
                    .enum(['payment', 'counterparty'])
                    .optional()
                    .describe('payment — все платежи таблицей; counterparty — свод по контрагентам. Не указано — сводка.'),
                offset: z.number().int().min(0).optional().describe('С какой строки — для листания; номер следующей страницы пишется внизу ответа'),
                limit: z
                    .number()
                    .int()
                    .min(0)
                    .max(500)
                    .optional()
                    .describe('Сколько строк на странице: в сводке по умолчанию 30, в payment и counterparty — 500 (итоги — по всем)')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('buh_bank', async (args, extra) => {
            const actor = actorOf(extra);
            const b = baseOf(args.base);
            for (const d of [args.from, args.to]) if (!isDay(d)) return fail(badDay(d));
            const cfg = await readerFor(b, actor);
            if (args.from > args.to) return fail('Начало периода позже конца.');
            const orgs = await orgsOf(cfg);
            const orgKeys = pickOrgs(orgs, args.organization);
            if (orgKeys && orgKeys.length === 0) {
                return fail(`${head(b)}\nОрганизации «${args.organization}» в базе нет. Есть: ${[...orgs.values()].join('; ')}.`);
            }
            const people = inArea(actor, 'payroll');
            const kinds: Array<{ entity: string; sign: 1 | -1; label: string }> = [];
            if (args.direction !== 'списания') kinds.push({ entity: 'Document_ПоступлениеНаРасчетныйСчет', sign: 1, label: 'поступление' });
            if (args.direction !== 'поступления') kinds.push({ entity: 'Document_СписаниеСРасчетногоСчета', sign: -1, label: 'списание' });

            type Pay = {
                ref: string;
                date: string;
                num: string;
                posted: boolean;
                org: string;
                who: string;
                whoType: string | null;
                sum: number;
                sign: 1 | -1;
                kind: string;
                purpose: string;
                op: string;
                articleKey: string;
            };
            const pays: Pay[] = [];
            const notes: string[] = [];
            for (const k of kinds) {
                if (!cfg.allow!(k.entity)) {
                    notes.push(`Раздел ${k.entity} в базе не опубликован — ${k.label} не учтены.`);
                    continue;
                }
                let filter = `Date ge datetime'${args.from}T00:00:00' and Date le datetime'${args.to}T23:59:59' and DeletionMark eq false`;
                if (orgKeys) filter += ` and (${orgKeys.map(x => `Организация_Key eq guid'${x}'`).join(' or ')})`;
                if (args.purpose?.trim()) filter += ` and substringof(${q(args.purpose.trim())}, НазначениеПлатежа)`;
                const { rows, capped } = await bankDocs(cfg, b, k.entity, filter);
                if (capped) notes.push(`ВНИМАНИЕ: ${k.label} — больше ${rows.length} документов, учтены не все. Возьмите период короче.`);
                for (const r of rows) {
                    pays.push({
                        ref: String(r.Ref_Key ?? ''),
                        date: String(r.Date ?? '').slice(0, 10),
                        num: String(r.Number ?? '').trim(),
                        posted: r.Posted === true,
                        org: orgs.get(String(r.Организация_Key)) ?? dash,
                        who: String(r.Контрагент ?? ''),
                        whoType: entityOfType(r.Контрагент_Type),
                        sum: num(r.СуммаДокумента),
                        sign: k.sign,
                        kind: k.label,
                        purpose: String(r.НазначениеПлатежа ?? '').replace(/\s+/g, ' ').trim(),
                        op: String(r.ВидОперации ?? ''),
                        articleKey: String(r.СтатьяДвиженияДенежныхСредств_Key ?? '')
                    });
                }
            }
            // Зарплатные платежи — это доходы конкретных людей: без payroll не показываем строки.
            const isSalary = (p: Pay): boolean => /Зарплат|Сотрудник|Заработн/i.test(p.op);
            const hidden = people ? 0 : pays.filter(isSalary).length;
            const visible = people ? pays : pays.filter(p => !isSalary(p));
            if (hidden) notes.push(`Платежей по зарплате скрыто: ${hidden} (нужна область payroll). В итогах они учтены.`);
            const unposted = pays.filter(p => !p.posted);
            if (unposted.length) {
                notes.push(
                    `Не проведено: ${unposted.length} на ${rub(unposted.reduce((s, p) => s + p.sum, 0))} — в итогах учтены, в строках помечены.`
                );
            }

            if (pays.length === 0) return text(`${head(b)}\n${args.from} — ${args.to}: платежей нет.${notes.length ? `\n${notes.join('\n')}` : ''}`);

            const inRows = pays.filter(p => p.sign > 0);
            const outRows = pays.filter(p => p.sign < 0);
            const inSum = inRows.reduce((s, p) => s + p.sum, 0);
            const outSum = outRows.reduce((s, p) => s + p.sum, 0);
            const filters = [
                args.direction && args.direction !== 'все' ? `только ${args.direction}` : '',
                orgKeys ? `организации: ${orgKeys.map(k => orgs.get(k)).join('; ')}` : '',
                args.purpose?.trim() ? `в назначении «${args.purpose.trim()}»` : ''
            ].filter(Boolean);
            const top = [
                head(b),
                `Период: ${args.from} — ${args.to}, расчётные счета${filters.length ? ` · отбор: ${filters.join(', ')}` : ''}`,
                `Платежей: ${pays.length} (поступлений ${inRows.length}, списаний ${outRows.length})`,
                `Поступило ${rub(inSum)}, списано ${rub(outSum)}, разница ${rub(inSum - outSum)}`,
                ...notes
            ];

            // Названия и ИНН — для всех контрагентов в выдаче, по типу ссылки
            // (контрагент, физлицо, счёт…). Статьи ДДС — одним справочником.
            const need = new Map<string, string[]>();
            for (const p of visible) if (p.whoType) need.set(p.whoType, [...(need.get(p.whoType) ?? []), p.who]);
            const problems: string[] = [];
            const cards = new Map<string, { name: string; inn: string }>();
            for (const [t, ks] of need) for (const [k, v] of await cardsOf(cfg, b, t, ks, problems)) cards.set(k, v);
            const articles = new Map<string, string>();
            for (const [k, v] of await cardsOf(cfg, b, 'Catalog_СтатьиДвиженияДенежныхСредств', visible.map(p => p.articleKey), problems)) {
                articles.set(k, v.name);
            }
            // Справочник не прочитался — говорим прямо: названия, ИНН и свод по
            // контрагентам неполные. Итоги от этого не зависят.
            for (const m of problems) top.push(`ВНИМАНИЕ: ${m} — названия, ИНН и статьи неполные, разбивка по контрагентам неполная.`);
            const article = (p: Pay): string => articles.get(p.articleKey) || p.op || dash;
            const inn = (p: Pay): string => cards.get(p.who)?.inn || '';
            // Пустая ссылка — платёж без контрагента: комиссия банка, налог, перевод
            // между своими счетами, покупка по карте (в назначении — магазин).
            // Справочник открыт, а названия нет (не прочитался или ссылка битая) —
            // это не «скрыто»: такие ссылки не склеиваем, каждая остаётся своей строкой.
            const readable = (t?: string | null): boolean => Boolean(t && cfg.allow!(t));
            const nm = (k: string, t?: string | null): string =>
                !k || k === EMPTY
                    ? 'без контрагента (банк, налоги, свои счета)'
                    : (cards.get(k)?.name ??
                      (t
                          ? readable(t)
                              ? `${t.replace(/^Catalog_/, '')} ${k} (название не найдено)`
                              : `${t.replace(/^Catalog_/, '')} (название скрыто или не опубликовано)`
                          : k));
            const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
            const multiOrg = new Set(pays.map(p => p.org)).size > 1;

            if (args.groupBy === 'payment') {
                // Хронологически, поступления раньше списаний, дальше по номеру —
                // порядок устойчивый, чтобы offset между страницами не плыл.
                const ordered = [...visible].sort(
                    (a, c) => a.date.localeCompare(c.date) || c.sign - a.sign || a.num.localeCompare(c.num) || a.ref.localeCompare(c.ref)
                );
                const fixed = [
                    ...top,
                    '',
                    `Дата | № документа | Сумма, ₽ (+ поступление, − списание) | Контрагент | ИНН | Статья ДДС | Назначение${multiOrg ? ' | Организация' : ''}`,
                    ''
                ].join('\n');
                const body = ordered.map(p =>
                    [
                        p.date,
                        p.num || dash,
                        `${p.sign > 0 ? '+' : '−'}${amount(p.sum)}`,
                        cut(!p.who || p.who === EMPTY ? 'без контрагента' : nm(p.who, p.whoType), 60),
                        inn(p) || dash,
                        article(p),
                        cut(p.purpose, 150) || dash,
                        ...(multiOrg ? [p.org] : []),
                        ...(p.posted ? [] : ['НЕ ПРОВЕДЁН'])
                    ].join(' | ')
                );
                const page = pageOf(body, args.offset ?? 0, args.limit ?? 500, fixed);
                return text([fixed, ...page.lines, page.footer].join('\n'));
            }

            if (args.groupBy === 'counterparty') {
                // Без контрагента — комиссии, налоги, покупки по карте: не одной
                // кучей, а по виду операции. Скрытые имена сливаются по подписи.
                const groups = new Map<string, { name: string; inn: string; inSum: number; inN: number; outSum: number; outN: number }>();
                const add = (key: string, name: string, innOf: string, p: Pay): void => {
                    const g = groups.get(key) ?? { name, inn: innOf, inSum: 0, inN: 0, outSum: 0, outN: 0 };
                    if (p.sign > 0) {
                        g.inSum += p.sum;
                        g.inN += 1;
                    } else {
                        g.outSum += p.sum;
                        g.outN += 1;
                    }
                    groups.set(key, g);
                };
                for (const p of pays) {
                    if (!people && isSalary(p)) {
                        add('зарплата', 'зарплата (строки скрыты, нужна область payroll)', '', p);
                        continue;
                    }
                    if (!p.who || p.who === EMPTY) {
                        add(`оп:${p.op}`, `без контрагента: ${p.op || 'операция не указана'}`, '', p);
                        continue;
                    }
                    const name = nm(p.who, p.whoType);
                    // Скрытые имена (справочник не открыт) сливаются по подписи, остальные — по ссылке.
                    add(cards.has(p.who) || readable(p.whoType) ? p.who : `подпись:${name}`, name, inn(p), p);
                }
                const ordered = [...groups.values()].sort((a, c) => c.inSum + c.outSum - (a.inSum + a.outSum));
                const fixed = [
                    ...top,
                    '',
                    `Контрагентов и групп: ${ordered.length}`,
                    'Контрагент | ИНН | Поступило, ₽ / платежей | Списано, ₽ / платежей',
                    ''
                ].join('\n');
                const body = ordered.map(g =>
                    [cut(g.name, 80), g.inn || dash, `${amount(g.inSum)} / ${g.inN}`, `${amount(g.outSum)} / ${g.outN}`].join(' | ')
                );
                const page = pageOf(body, args.offset ?? 0, args.limit ?? 500, fixed);
                return text([fixed, ...page.lines, page.footer].join('\n'));
            }

            // Сводка — как было: организации, крупнейшие контрагенты, последние платежи.
            const byOrg = new Map<string, { inn: number; out: number }>();
            for (const p of pays) {
                const v = byOrg.get(p.org) ?? { inn: 0, out: 0 };
                if (p.sign > 0) v.inn += p.sum;
                else v.out += p.sum;
                byOrg.set(p.org, v);
            }
            const byWho = new Map<string, { sum: number; n: number; type: string | null }>();
            for (const p of visible) {
                const v = byWho.get(p.who) ?? { sum: 0, n: 0, type: p.whoType };
                v.sum += p.sign * p.sum;
                v.n += 1;
                byWho.set(p.who, v);
            }
            const topWho = [...byWho].sort((a, c) => Math.abs(c[1].sum) - Math.abs(a[1].sum)).slice(0, 10);
            const limit = args.limit ?? 30;
            const list = [...visible].sort((a, c) => (a.date < c.date ? 1 : a.date > c.date ? -1 : 0));
            const fixed = [
                ...top,
                '',
                'По организациям:',
                ...[...byOrg].map(([o, v]) => `   ${o}: поступило ${rub(v.inn)}, списано ${rub(v.out)}`),
                '',
                'Крупнейшие контрагенты (плюс — к нам, минус — от нас):',
                ...topWho.map(([k, v]) => `   ${nm(k, v.type)}${cards.get(k)?.inn ? ` (ИНН ${cards.get(k)!.inn})` : ''}: ${rub(v.sum)} (${v.n} пл.)`),
                '',
                'Все платежи таблицей — groupBy=payment, свод по контрагентам — groupBy=counterparty.'
            ].join('\n');
            if (limit === 0) return text(fixed);
            const lines = list.map(p => {
                const tail = [articles.get(p.articleKey), p.purpose.slice(0, 140)].filter(Boolean).join(' · ');
                return (
                    `   ${p.date} №${p.num} ${p.sign > 0 ? '+' : '−'}${rub(p.sum)} · ${nm(p.who, p.whoType)}${inn(p) ? ` (ИНН ${inn(p)})` : ''} · ${p.org}${p.posted ? '' : ' · НЕ ПРОВЕДЁН'}` +
                    (tail ? `\n      ${tail}` : '')
                );
            });
            const page = pageOf(lines, args.offset ?? 0, limit, fixed);
            return text([fixed, '', 'Платежи, от последних:', ...page.lines, page.footer].join('\n'));
        })
    );
}
