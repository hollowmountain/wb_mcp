import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { resolveCabinet } from '../../access.js';
import type { Actor } from '../../auth/provider.js';
import { inArea } from '../../auth/provider.js';
import { config } from '../../config.js';
import { describe as describeBudget, record as recordSpend, refuseIfOverLimit } from '../../media/budget.js';
import { edit, estimateUsd, OpenAiError, type Quality } from '../../media/openai.js';
import { decodePlan, encodePlan, planErrorText, type Plan } from '../../media/plan.js';
import { listPhotos, ReferenceError_, resolveReference } from '../../media/reference.js';
import {
    buildPrompt,
    checkNeeds,
    checkOverlay,
    describeTemplate,
    SIZES,
    SLOT_RULES,
    SLOTS,
    type Overlay,
    type SizeKey,
    type Slot
} from '../../media/slots.js';
import { save } from '../../media/store.js';
import { actorOf, fail, guarded, text } from './common.js';

const ready = (): boolean => Boolean(config.media.apiKey);
const available = (actor: Actor): boolean => ready() && inArea(actor, 'media');

const money = (usd: number): string => `${usd.toFixed(3)} $`;

function denied(actor: Actor): string | null {
    if (!ready()) return 'Генерация не настроена: у коннектора нет ключа OpenAI.';
    if (!inArea(actor, 'media')) {
        return 'Область «генерация картинок» вам не открыта. Обратитесь к администратору.';
    }
    return null;
}

const explain = (e: unknown): string =>
    e instanceof OpenAiError
        ? e.toUserMessage()
        : e instanceof ReferenceError_
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);

const overlayOf = (args: {
    headline?: string;
    bullets?: string[];
    badge?: string;
    footer?: string;
}): Overlay => ({
    ...(args.headline?.trim() ? { headline: args.headline.trim() } : {}),
    ...(args.bullets?.length ? { bullets: args.bullets.map(b => b.trim()).filter(Boolean) } : {}),
    ...(args.badge?.trim() ? { badge: args.badge.trim() } : {}),
    ...(args.footer?.trim() ? { footer: args.footer.trim() } : {})
});

export function registerMediaTools(server: McpServer, actor: Actor): void {
    if (!available(actor)) return;

    server.registerTool(
        'media_template',
        {
            title: 'Шаблон карточки: порядок слайдов и правила площадок',
            description:
                'Из каких слайдов состоит карточка, в каком порядке они идут, сколько на каждом текста, ' +
                'какие размеры и что запрещено писать на картинке. Вызовите первым, если делаете карточку ' +
                'целиком, а не один кадр. Ничего не генерирует и денег не тратит.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        guarded('media_template', async (_args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);
            return text([describeTemplate(), '', describeBudget(who.email)].join('\n'));
        })
    );

    server.registerTool(
        'media_photos',
        {
            title: 'Показать фотографии товара',
            description:
                'Список снимков из карточки Wildberries со ссылками. Нужен, чтобы выбрать исходник: ' +
                'первое фото в карточке почти всегда с инфографикой, а генерации нужен кадр с чистым товаром. ' +
                'Покажите ссылки человеку и спросите, на каком снимке товар без наложенного текста.',
            inputSchema: {
                nmId: z.number().int().positive().describe('Номенклатура Wildberries'),
                cabinet: z.string().describe('Кабинет Wildberries')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('media_photos', async (args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            const cabinet = resolveCabinet(who, args.cabinet);
            const photos = await listPhotos(cabinet, args.nmId);
            if (photos.length === 0) return fail(`У товара nmID ${args.nmId} в карточке нет фотографий.`);

            return text(
                [
                    `Фотографий в карточке: ${photos.length}`,
                    ...photos.map((url, i) => `${i + 1}. ${url}`),
                    '',
                    'Для генерации нужен номер кадра, где товар снят без наложенного текста и без подтёков поверх букв.',
                    'Этот номер передаётся в media_plan параметром photo.'
                ].join('\n')
            );
        })
    );

    server.registerTool(
        'media_plan',
        {
            title: 'Согласовать кадр перед запуском',
            description:
                'Первый шаг генерации. Собирает промт по шаблону, проверяет тексты на запреты площадок, ' +
                'считает примерную цену и возвращает план — подписанную строку. План надо ПОКАЗАТЬ ЧЕЛОВЕКУ ' +
                'вместе с промтом и ценой и дождаться прямого «да». Ничего не генерирует и денег не тратит. ' +
                'Сцену описывайте по-русски, тексты давайте отдельными полями — промт соберётся сам.',
            inputSchema: {
                slot: z
                    .enum(SLOTS)
                    .describe(
                        'Какой слайд карточки: ' +
                            SLOTS.map(s => `${s} — ${SLOT_RULES[s].label}`).join('; ') +
                            '. Полные правила — в media_template.'
                    ),
                scene: z
                    .string()
                    .min(20)
                    .describe(
                        'Обстановка вокруг товара, по-русски и подробно: где стоит, что рядом, какой свет, ' +
                            'какое настроение. Короткое описание даёт случайный результат.'
                    ),
                nmId: z.number().int().positive().optional().describe('Товар на Wildberries — фото возьмётся из его карточки'),
                photo: z.number().int().positive().optional().describe('Номер фото в карточке, по умолчанию первое'),
                imageUrl: z
                    .string()
                    .optional()
                    .describe('Прямая ссылка на фото, если нужного кадра в карточке нет. Только витрины WB и Ozon.'),
                cabinet: z.string().optional().describe('Кабинет Wildberries — нужен вместе с nmId'),
                headline: z.string().optional().describe('Заголовок на картинке'),
                bullets: z.array(z.string()).max(6).optional().describe('Пункты списка, не больше шести'),
                badge: z.string().optional().describe('Надпись в круглой печати'),
                footer: z.string().optional().describe('Нижняя плашка: объём, комплектация'),
                size: z
                    .enum(Object.keys(SIZES) as [SizeKey, ...SizeKey[]])
                    .default('wb')
                    .describe('Формат кадра. По умолчанию wb — вертикаль 3:4, её принимают обе площадки.'),
                quality: z
                    .enum(['medium', 'high'])
                    .default('high')
                    .describe('high — для готовой карточки; medium вдвое дешевле, но мелкий текст плывёт, годится на пробу')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('media_plan', async (args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            if (!args.nmId && !args.imageUrl) {
                return fail('Нужно исходное фото товара: укажите nmId (и кабинет) либо imageUrl.');
            }

            const overlay = overlayOf(args);

            // Проверяем до денег: с запрещённой надписью карточку всё равно
            // завернёт модерация, а генерация уже будет оплачена.
            const banned = checkOverlay(overlay);
            if (banned.length > 0) {
                return fail(['Такие надписи площадки не пропустят:', ...banned.map(b => `— ${b}`)].join('\n'));
            }

            const missing = checkNeeds(args.slot as Slot, overlay);
            if (missing.length > 0) {
                return fail(
                    `Для слайда «${SLOT_RULES[args.slot as Slot].label}» не хватает: ${missing.join(', ')}. ` +
                        'Что нужно на каждом слайде — в media_template.'
                );
            }

            const size = SIZES[args.size as SizeKey];
            const prompt = buildPrompt({ slot: args.slot as Slot, scene: args.scene, overlay });
            const estUsd = estimateUsd(size.width, size.height, args.quality as Quality, prompt.length);

            const overLimit = refuseIfOverLimit(who.email, estUsd);
            if (overLimit) return fail(overLimit);

            // Фото скачиваем уже сейчас: пусть ошибка «нет такого товара»
            // придёт до согласования, а не после «да».
            const cabinet = args.cabinet ? resolveCabinet(who, args.cabinet) : null;
            let source: string;
            try {
                const reference = await resolveReference(cabinet, {
                    ...(args.nmId ? { nmId: args.nmId } : {}),
                    ...(args.photo ? { photo: args.photo } : {}),
                    ...(args.imageUrl ? { imageUrl: args.imageUrl } : {})
                });
                source = reference.source;
            } catch (e) {
                return fail(explain(e));
            }

            const plan: Plan = {
                slot: args.slot as Slot,
                size: args.size as SizeKey,
                quality: args.quality as Quality,
                prompt,
                cabinet: args.cabinet ?? null,
                ...(args.nmId ? { nmId: args.nmId } : {}),
                ...(args.photo ? { photo: args.photo } : {}),
                ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}),
                overlay,
                estUsd,
                email: who.email,
                at: Math.floor(Date.now() / 1000)
            };

            return text(
                [
                    `Слайд: ${SLOT_RULES[plan.slot].label}`,
                    `Исходное фото: ${source}`,
                    `Формат: ${size.width}×${size.height}, качество ${plan.quality}`,
                    `Примерная цена: около ${money(estUsd)} — точную скажу после запуска`,
                    describeBudget(who.email),
                    '',
                    'ПРОМТ ЦЕЛИКОМ:',
                    prompt,
                    '',
                    'ПОКАЖИТЕ ЭТО ЧЕЛОВЕКУ — И ФОТО-ИСХОДНИК, И ПРОМТ — И ДОЖДИТЕСЬ ЯВНОГО СОГЛАСИЯ.',
                    'После «да» — media_generate с этой строкой:',
                    encodePlan(plan)
                ].join('\n')
            );
        })
    );

    server.registerTool(
        'media_generate',
        {
            title: 'Запустить согласованный кадр',
            description:
                'Второй шаг. Принимает ТОЛЬКО план из media_plan — своих параметров у него нет, поэтому ' +
                'сгенерируется ровно то, что видел человек. Вызывать можно лишь после прямого согласия. ' +
                'Считает около минуты и сразу возвращает ссылку на готовый файл и настоящую цену.',
            inputSchema: {
                plan: z.string().min(20).describe('Строка плана из media_plan, целиком и без изменений')
            },
            annotations: { readOnlyHint: false, openWorldHint: true }
        },
        guarded('media_generate', async (args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            const plan = decodePlan(args.plan, who.email);
            if (typeof plan === 'string') return fail(planErrorText(plan));

            // Предел мог кончиться между согласованием и запуском.
            const overLimit = refuseIfOverLimit(who.email, plan.estUsd);
            if (overLimit) return fail(overLimit);

            const size = SIZES[plan.size];

            try {
                const cabinet = plan.cabinet ? resolveCabinet(who, plan.cabinet) : null;
                const reference = await resolveReference(cabinet, {
                    ...(plan.nmId ? { nmId: plan.nmId } : {}),
                    ...(plan.photo ? { photo: plan.photo } : {}),
                    ...(plan.imageUrl ? { imageUrl: plan.imageUrl } : {})
                });

                const result = await edit(config.media, {
                    reference,
                    prompt: plan.prompt,
                    width: size.width,
                    height: size.height,
                    quality: plan.quality
                });

                recordSpend(who.email, result.usd);
                const stored = save(result.bytes, result.mime);

                return text(
                    [
                        `Готово: ${SLOT_RULES[plan.slot].label}, ${size.width}×${size.height}`,
                        `Списалось: ${money(result.usd)}`,
                        describeBudget(who.email),
                        '',
                        stored.url,
                        '',
                        'Ссылка живёт семь дней — скачайте файл сразу.',
                        'Перед загрузкой на площадку проверьте глазами надписи: их рисует модель, а не набирает шрифтом.'
                    ].join('\n')
                );
            } catch (e) {
                return fail(explain(e));
            }
        })
    );
}
