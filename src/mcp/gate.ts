import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Area } from '../areas.js';
import { AREA_LABELS } from '../areas.js';
import { inArea, type Actor } from '../auth/provider.js';

/**
 * Какой инструмент к какой области относится.
 *
 * Объявление одно на всех и лежит рядом с заслоном, а не размазано по местам
 * регистрации: так видно всю раскладку разом, и её можно перечитать глазами.
 * null — служебный инструмент: он только сообщает, что человеку доступно,
 * и потому открыт всем допущенным.
 *
 * Инструмент, которого здесь нет, сервер не запустит: см. проверку ниже.
 * Это важнее удобства — иначе новый инструмент незаметно оказался бы виден всем.
 */
export const TOOL_AREAS: Record<string, Area | null> = {
    // служебные
    wb_cabinets: null,
    wb_whoami: null,
    ozon_cabinets: null,
    nep_cabinets: null,


    // обращения покупателей
    wb_overview: 'inbox',
    wb_feedbacks_list: 'inbox',
    wb_feedback_get: 'inbox',
    wb_feedbacks_archive: 'inbox',
    wb_feedbacks_count: 'inbox',
    wb_questions_list: 'inbox',
    wb_question_get: 'inbox',
    wb_questions_count: 'inbox',
    wb_chats_list: 'inbox',
    wb_chat_events: 'inbox',
    ozon_chats: 'inbox',

    // черновик — часть работы с обращением, поэтому inbox;
    // отправка и изменение состояния у WB — уже reply
    wb_draft_feedback_reply: 'inbox',
    wb_draft_feedback_answer_edit: 'inbox',
    wb_draft_question_answer: 'inbox',
    wb_draft_chat_message: 'inbox',
    wb_drafts_list: 'inbox',
    wb_draft_discard: 'inbox',
    wb_draft_send: 'reply',
    wb_question_reject: 'reply',
    wb_question_mark_viewed: 'reply',

    // товары и цены
    wb_product: 'catalog',
    ozon_products: 'catalog',
    ozon_stocks: 'stock',

    // остатки
    wb_stocks: 'stock',

    // заказы, возвраты, контрагенты
    wb_orders: 'orders',
    wb_returns: 'orders',
    ozon_orders: 'orders',
    ozon_returns: 'orders',
    ozon_analytics: 'orders',

    // 1С отдельно от orders: у неё нет разреза по кабинетам, и человек,
    // ограниченный одним кабинетом маркетплейса, увидел бы там всю компанию.
    onec_reference: 'erp',
    onec_products: 'erp',
    onec_orders: 'erp',
    onec_partners: 'supply',
    onec_stock: 'erp',
    onec_purchases: 'supply',
    onec_receipts: 'supply',
    onec_piecework: 'payroll',
    onec_specification: 'erp',
    onec_shipments: 'erp',
    onec_production: 'erp',
    onec_warehouse: 'erp',

    // Продажи по географии остаются вместе с заказами: это выручка площадки,
    // а не себестоимость, и сотрудники видели их с самого начала. Отбирать
    // задним числом то, чем уже пользуются, — плохой способ вводить правила.
    wb_regions: 'orders',

    // экономика
    nep_economy: 'money',
    ozon_finance: 'money',
    onec_stock_value: 'money',
    nep_ads: 'money'
};

type Handler = (args: never, extra: never) => Promise<unknown>;

/**
 * Ставит заслон на регистрацию инструментов: чего человеку не положено, того
 * он не увидит, а если позовёт по закэшированному списку — получит отказ.
 *
 * Оба заслона нужны вместе. Клиенты MCP держат список инструментов в кэше, и
 * после сужения доступа старый список может ещё какое-то время жить у человека
 * на руках — эта ловушка уже стоила нам разбирательства с параметром кабинета.
 */
export function gateByAreas(server: McpServer, actor: Actor): { registered: string[]; hidden: string[] } {
    const registered: string[] = [];
    const hidden: string[] = [];

    // Точка расширения SDK — обёртка вокруг метода регистрации. Типы здесь
    // намеренно широкие: сигнатура registerTool обобщённая, а нам нужно лишь
    // имя и возможность подменить обработчик.
    const target = server as unknown as Record<string, unknown>;
    const original = (target.registerTool as (...a: unknown[]) => unknown).bind(server);

    target.registerTool = (name: string, spec: unknown, handler: Handler): unknown => {
        if (!(name in TOOL_AREAS)) {
            throw new Error(
                `Инструмент «${name}» не отнесён ни к одной области. Допишите его в TOOL_AREAS в mcp/gate.ts — ` +
                    'иначе он оказался бы доступен всем.'
            );
        }
        const area = TOOL_AREAS[name] ?? null;

        if (area !== null && !inArea(actor, area)) {
            hidden.push(name);
            return undefined;
        }
        registered.push(name);

        const guardedHandler: Handler = async (args, extra) => {
            if (area !== null && !inArea(actor, area)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text:
                                `Инструмент «${name}» вам недоступен: нужна область «${area}» — ${AREA_LABELS[area]}. ` +
                                'Возможно, список инструментов у вас устарел — переподключите коннектор.'
                        }
                    ],
                    isError: true
                };
            }
            return handler(args, extra);
        };

        return original(name, spec, guardedHandler);
    };

    return { registered, hidden };
}
