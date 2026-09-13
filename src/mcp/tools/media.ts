import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { inArea } from '../../auth/provider.js';
import { config } from '../../config.js';
import { describe as describeBudget, record as recordSpend, refuseIfOverLimit } from '../../media/budget.js';
import { buildPrompt, checkTexts, describeRules, SIZES, type SizeKey } from '../../media/compose.js';
import { edit, estimateUsd, OpenAiError, type Quality } from '../../media/openai.js';
import { decodePlan, encodePlan, planErrorText, type Plan } from '../../media/plan.js';
import { findUploads, listUploads, readUpload } from '../../media/uploads.js';
import { makeUploadLink } from '../../media/uploadlink.js';
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
    e instanceof OpenAiError ? e.toUserMessage() : e instanceof Error ? e.message : String(e);

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
        'media_upload_link',
        {
            title: 'Ссылка, куда человек скинет своё фото',
            description:
                'Возвращает короткую ссылку: человек открывает её, перетаскивает снимок и возвращается в чат. ' +
                'Входа и кодов не требует — ссылка уже его. Нужна, когда у человека есть своя съёмка товара ' +
                'или когда товара ещё нет на площадке. Ничего не тратит.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        guarded('media_upload_link', async (_args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            const link = makeUploadLink(who.email);
            return text(
                [
                    'Дайте человеку эту ссылку:',
                    link.url,
                    '',
                    `Ссылка живёт ${link.minutes} минут и работает только у него — входить никуда не нужно.`,
                    'Пусть выберет файл и подпишет одной строкой, что это за товар.',
                    'Принимаются JPEG, PNG и WebP. Фото с айфона в HEIC не подойдёт, его надо сохранить как JPEG.',
                    'Загруженный снимок хранится час и удаляется сам.',
                    '',
                    'Когда человек скажет, что загрузил, — вызовите media_photos и увидите его снимок.'
                ].join('\n')
            );
        })
    );

    server.registerTool(
        'media_photos',
        {
            title: 'Мои загруженные снимки',
            description:
                'Что человек загрузил и можно взять за исходник. Без параметров — всё, с find — поиск ' +
                'по названию. Если пусто, дайте ссылку через media_upload_link.',
            inputSchema: {
                find: z.string().optional().describe('Часть названия снимка, например «ланолин»')
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        guarded('media_photos', async (args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            const mine = args.find ? findUploads(who.email, args.find) : listUploads(who.email);
            if (mine.length === 0) {
                return text(
                    args.find
                        ? `Снимков по запросу «${args.find}» не нашлось. Покажите весь список или дайте ссылку на загрузку.`
                        : [
                              'Снимков не загружено.',
                              'Дайте человеку ссылку через media_upload_link — входить никуда не нужно.'
                          ].join('\n')
                );
            }

            return text(
                [
                    `Загружено снимков: ${mine.length}`,
                    ...mine.map(u => `   ${u.code} — ${u.note ?? 'без описания'}, ${Math.round(u.bytes / 1024)} КБ`),
                    '',
                    'Нужный код передаётся в media_plan параметром upload.'
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
                upload: z
                    .string()
                    .describe('Код загруженного снимка: ref-xxxxxx. Список — в media_photos.'),
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

            // Снимок проверяем уже сейчас: пусть «нет такого кода» придёт до
            // согласования, а не после «да».
            const found = readUpload(args.upload, who.email);
            if (!found) {
                return fail(
                    `Снимок «${args.upload}» не найден или загружен не вами. Он мог устареть — они живут час. ` +
                        'Посмотрите список через media_photos или дайте новую ссылку через media_upload_link.'
                );
            }
            const source = `свой снимок ${args.upload}${found.note ? ` — ${found.note}` : ''}`;

            const plan: Plan = {
                size: args.size as SizeKey,
                quality: args.quality as Quality,
                prompt,
                upload: args.upload,
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

            const found = readUpload(plan.upload, who.email);
            if (!found) {
                return fail(
                    'Снимок больше недоступен — они живут час. Загрузите заново через media_upload_link и соберите план снова.'
                );
            }
            const ext = found.mime === 'image/png' ? 'png' : found.mime === 'image/webp' ? 'webp' : 'jpg';

            try {
                const result = await edit(config.media, {
                    reference: { bytes: found.bytes, mime: found.mime, filename: `reference.${ext}` },
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
