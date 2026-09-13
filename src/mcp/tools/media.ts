import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { resolveCabinet, resolveOzonCabinet } from '../../access.js';
import type { Actor } from '../../auth/provider.js';
import { inArea } from '../../auth/provider.js';
import { config } from '../../config.js';
import { describe as describeBudget, record as recordSpend, refuseIfOverLimit } from '../../media/budget.js';
import { buildPrompt, checkTexts, describeRules, SIZES, type SizeKey } from '../../media/compose.js';
import { edit, estimateUsd, OpenAiError, type Quality } from '../../media/openai.js';
import { decodePlan, encodePlan, planErrorText, type Plan } from '../../media/plan.js';
import { listOzonPhotos, listPhotos, ReferenceError_, resolveReference } from '../../media/reference.js';
import { findUploads, listUploads } from '../../media/uploads.js';
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

export function registerMediaTools(server: McpServer, actor: Actor): void {
    if (!available(actor)) return;

    server.registerTool(
        'media_rules',
        {
            title: 'Правила площадок, форматы и остаток',
            description:
                'Что запрещено писать на картинке, какие есть размеры и сколько потрачено из предела. ' +
                'Шаблона карточки нет: сцену и надписи придумываете вы с человеком. Ничего не тратит.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        guarded('media_rules', async (_args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);
            return text([describeRules(), '', describeBudget(who.email)].join('\n'));
        })
    );

    server.registerTool(
        'media_photos',
        {
            title: 'Найти исходное фото товара',
            description:
                'Что можно взять за исходник. Без параметров — свои загруженные снимки. ' +
                'С find — поиск среди них по названию. С nmId или offerId — фотографии из карточки площадки. ' +
                'Нужен, чтобы человек выбрал кадр: первое фото в карточке почти всегда с инфографикой, ' +
                'а генерации нужен чистый товар.',
            inputSchema: {
                find: z.string().optional().describe('Часть названия своего снимка, например «ланолин»'),
                nmId: z.number().int().positive().optional().describe('Номенклатура Wildberries'),
                offerId: z.string().optional().describe('Артикул продавца на Ozon'),
                cabinet: z.string().optional().describe('Кабинет: harbez для Wildberries, oz-harbez для Ozon')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('media_photos', async (args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            const mine = args.find ? findUploads(who.email, args.find) : listUploads(who.email);
            const ownBlock =
                mine.length === 0
                    ? args.find
                        ? [`Своих снимков по запросу «${args.find}» не нашлось.`]
                        : [
                              'Своих снимков не загружено.',
                              'Если у человека есть студийная съёмка товара — она лучше кадра из карточки.',
                              'Загрузить можно на странице /panel/reference, оттуда вернётся код ref-xxxxxx.'
                          ]
                    : [
                          `Свои снимки (${mine.length}) — их можно назвать вместо кадра из карточки:`,
                          ...mine.map(u => `   ${u.code} — ${u.note ?? 'без описания'}, ${Math.round(u.bytes / 1024)} КБ`)
                      ];

            if (args.offerId) {
                if (!args.cabinet) return fail('Чтобы показать фото из карточки Ozon, нужен кабинет вида oz-harbez.');
                const ozon = resolveOzonCabinet(who, args.cabinet);
                const found = await listOzonPhotos(ozon, args.offerId);
                if (found.photos.length === 0) return fail(`У товара «${args.offerId}» в карточке Ozon нет фотографий.`);
                return text(
                    [
                        ...ownBlock,
                        '',
                        `${found.name || args.offerId} — фотографий в карточке Ozon: ${found.photos.length}`,
                        ...found.photos.map((url, i) => `${i + 1}. ${url}`),
                        '',
                        'ПОКАЖИТЕ ЭТОТ СПИСОК ЧЕЛОВЕКУ и спросите, какой кадр брать: нужен тот, где товар снят',
                        'без наложенной инфографики. Первый обычно главный и как раз с надписями.'
                    ].join('\n')
                );
            }

            if (!args.nmId) return text(ownBlock.join('\n'));
            if (!args.cabinet) return fail('Чтобы показать фото из карточки, нужен кабинет Wildberries.');

            const cabinet = resolveCabinet(who, args.cabinet);
            const photos = await listPhotos(cabinet, args.nmId);
            if (photos.length === 0) return fail(`У товара nmID ${args.nmId} в карточке нет фотографий.`);

            return text(
                [
                    ...ownBlock,
                    '',
                    `Фотографий в карточке: ${photos.length}`,
                    ...photos.map((url, i) => `${i + 1}. ${url}`),
                    '',
                    'ПОКАЖИТЕ ЭТОТ СПИСОК ЧЕЛОВЕКУ и спросите, какой кадр брать: нужен тот, где товар снят',
                    'без наложенного текста и без подтёков поверх букв. Первое фото обычно с инфографикой.'
                ].join('\n')
            );
        })
    );

    server.registerTool(
        'media_plan',
        {
            title: 'Согласовать кадр перед запуском',
            description:
                'Первый шаг. Собирает запрос, проверяет надписи на запреты площадок, считает примерную цену ' +
                'и возвращает план — подписанную строку. План надо ПОКАЗАТЬ ЧЕЛОВЕКУ вместе с описанием сцены ' +
                'и ценой и дождаться прямого «да». Ничего не генерирует и денег не тратит. ' +
                'Шаблона нет: сцену описываете своими словами, по-русски и подробно.',
            inputSchema: {
                description: z
                    .string()
                    .min(40)
                    .describe(
                        'Сцена целиком, своими словами: где стоит товар, что вокруг, какой свет, какое настроение, ' +
                            'как расположены предметы, как свёрстан текст. Чем подробнее, тем меньше случайности. ' +
                            'Сохранность упаковки, посадку в кадр и запрет посторонних надписей дописывать не надо — ' +
                            'они добавятся сами.'
                    ),
                texts: z
                    .array(z.string())
                    .optional()
                    .describe(
                        'Надписи, которые лягут поверх картинки, по одной строке. Именно они проверяются на запреты ' +
                            'площадок. Пусто — картинка без текста.'
                    ),
                upload: z.string().optional().describe('Код своего снимка: ref-xxxxxx'),
                nmId: z.number().int().positive().optional().describe('Товар на Wildberries'),
                offerId: z.string().optional().describe('Артикул продавца на Ozon'),
                photo: z.number().int().positive().optional().describe('Номер фото в карточке, по умолчанию первое'),
                imageUrl: z.string().optional().describe('Прямая ссылка на фото с витрины WB или Ozon'),
                cabinet: z.string().optional().describe('Кабинет: harbez для Wildberries, oz-harbez для Ozon'),
                size: z
                    .enum(Object.keys(SIZES) as [SizeKey, ...SizeKey[]])
                    .default('wb')
                    .describe('Формат кадра. По умолчанию wb — вертикаль 3:4, её принимают обе площадки.'),
                quality: z
                    .enum(['medium', 'high'])
                    .default('high')
                    .describe('high — для готовой карточки; medium вдвое дешевле, но мелкий текст плывёт')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('media_plan', async (args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            if (!args.upload && !args.nmId && !args.offerId && !args.imageUrl) {
                return fail(
                    'Нужно исходное фото товара. Спросите у человека, что берём: его собственный снимок ' +
                        '(код ref-xxxxxx, найти можно через media_photos) или кадр из карточки площадки ' +
                        '(nmId и кабинет для Wildberries, offerId и кабинет oz- для Ozon).'
                );
            }

            const texts = (args.texts ?? []).map(t => t.trim()).filter(Boolean);

            // Проверяем до денег: с запрещённой надписью карточку всё равно
            // завернёт модерация, а генерация уже будет оплачена.
            const banned = checkTexts(texts);
            if (banned.length > 0) {
                return fail(['Такие надписи площадки не пропустят:', ...banned.map(b => `— ${b}`)].join('\n'));
            }

            const size = SIZES[args.size as SizeKey];
            const prompt = buildPrompt({ description: args.description, texts });
            const estUsd = estimateUsd(size.width, size.height, args.quality as Quality, prompt.length);

            const overLimit = refuseIfOverLimit(who.email, estUsd);
            if (overLimit) return fail(overLimit);

            // Фото достаём уже сейчас: пусть ошибка «нет такого товара»
            // придёт до согласования, а не после «да».
            const isOzon = Boolean(args.offerId);
            const cabinet = args.cabinet && !isOzon ? resolveCabinet(who, args.cabinet) : null;
            const ozon = args.cabinet && isOzon ? resolveOzonCabinet(who, args.cabinet) : null;
            let source: string;
            try {
                const reference = await resolveReference(
                    cabinet,
                    {
                        ...(args.upload ? { upload: args.upload } : {}),
                        ...(args.nmId ? { nmId: args.nmId } : {}),
                        ...(args.offerId ? { offerId: args.offerId } : {}),
                        ...(args.photo ? { photo: args.photo } : {}),
                        ...(args.imageUrl ? { imageUrl: args.imageUrl } : {})
                    },
                    who.email,
                    ozon
                );
                source = reference.source;
            } catch (e) {
                return fail(explain(e));
            }

            const plan: Plan = {
                size: args.size as SizeKey,
                quality: args.quality as Quality,
                prompt,
                cabinet: args.cabinet ?? null,
                ...(args.upload ? { upload: args.upload } : {}),
                ...(args.nmId ? { nmId: args.nmId } : {}),
                ...(args.offerId ? { offerId: args.offerId } : {}),
                ...(args.photo ? { photo: args.photo } : {}),
                ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}),
                texts,
                estUsd,
                email: who.email,
                at: Math.floor(Date.now() / 1000)
            };

            return text(
                [
                    `Исходное фото: ${source}`,
                    `Формат: ${size.width}×${size.height}, качество ${plan.quality}`,
                    `Примерная цена: около ${money(estUsd)} — точную скажу после запуска`,
                    describeBudget(who.email),
                    '',
                    'ЗАПРОС ЦЕЛИКОМ:',
                    prompt,
                    '',
                    'ПОКАЖИТЕ ЭТО ЧЕЛОВЕКУ — И ФОТО-ИСХОДНИК, И ЗАПРОС — И ДОЖДИТЕСЬ ЯВНОГО СОГЛАСИЯ.',
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
                'Считает около минуты и возвращает ссылку на готовый файл и настоящую цену.',
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
                const planIsOzon = Boolean(plan.offerId);
                const cabinet = plan.cabinet && !planIsOzon ? resolveCabinet(who, plan.cabinet) : null;
                const ozon = plan.cabinet && planIsOzon ? resolveOzonCabinet(who, plan.cabinet) : null;
                const reference = await resolveReference(
                    cabinet,
                    {
                        ...(plan.upload ? { upload: plan.upload } : {}),
                        ...(plan.nmId ? { nmId: plan.nmId } : {}),
                        ...(plan.offerId ? { offerId: plan.offerId } : {}),
                        ...(plan.photo ? { photo: plan.photo } : {}),
                        ...(plan.imageUrl ? { imageUrl: plan.imageUrl } : {})
                    },
                    who.email,
                    ozon
                );

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
                        `Готово: ${size.width}×${size.height}`,
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
