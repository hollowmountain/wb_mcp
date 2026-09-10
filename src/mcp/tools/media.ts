import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { inArea } from '../../auth/provider.js';
import { config } from '../../config.js';
import { check, estimate, isTerminal, MODELS, submit, HiggsfieldError } from '../../media/higgsfield.js';
import { decodePlan, encodePlan, planErrorText, type Plan } from '../../media/plan.js';
import { actorOf, fail, guarded, text } from './common.js';

const ready = (): boolean => Boolean(config.higgsfield.keyId && config.higgsfield.keySecret);
const available = (actor: Actor): boolean => ready() && inArea(actor, 'media');

const money = (usd: number): string => `${usd.toFixed(3)} $`;

function denied(actor: Actor): string | null {
    if (!ready()) return 'Генерация не настроена: у коннектора нет ключа Higgsfield.';
    if (!inArea(actor, 'media')) {
        return 'Область «генерация картинок и видео» вам не открыта. Обратитесь к администратору.';
    }
    return null;
}

const explain = (e: unknown): string =>
    e instanceof HiggsfieldError ? e.toUserMessage() : e instanceof Error ? e.message : String(e);

/** Собираем тело запроса одинаково и при оценке, и при запуске: иначе согласовали бы одно, а ушло другое. */
function paramsOf(plan: Pick<Plan, 'what' | 'prompt' | 'imageUrl' | 'seconds'>): Record<string, unknown> {
    const model = MODELS[plan.what];
    const p: Record<string, unknown> = { prompt: plan.prompt };
    if (plan.imageUrl) {
        // Каждая модель называет вход по-своему: popcorn ждёт массив
        // image_urls, видео — одиночный image_url. Промахнуться легко,
        // а ошибка вылезет уже после списания.
        if (plan.what === 'scene') p.image_urls = [plan.imageUrl];
        else p.image_url = plan.imageUrl;
    }
    if (plan.what === 'scene') p.num_images = 1;
    if (model.kind === 'video') p.duration = plan.seconds ?? 6;
    return p;
}

export function registerMediaTools(server: McpServer, actor: Actor): void {
    if (!available(actor)) return;

    server.registerTool(
        'media_plan',
        {
            title: 'Согласовать генерацию перед запуском',
            description:
                'Первый и обязательный шаг. Считает цену и возвращает план — подписанную строку, которую надо ПОКАЗАТЬ ЧЕЛОВЕКУ ' +
                'вместе с промтом и ценой и дождаться прямого «да». Ничего не генерирует и денег не тратит. ' +
                'Промт составляете вы, по-английски и подробно: что за предмет, что в кадре, свет, объектив, чего быть не должно.',
            inputSchema: {
                what: z
                    .enum(['photo', 'scene', 'video_fast', 'video'])
                    .describe(
                        'photo — картинка с нуля по описанию (~0,003 $), товар выдумает; ' +
                            'scene — ваш товар с готового фото в новой обстановке (~0,09 $), это основной выбор для съёмки; ' +
                            'video_fast — ролик из фото подешевле (~0,19 $); video — ролик поплавнее (~0,21 $)'
                    ),
                prompt: z.string().min(20).describe('Готовый промт по-английски. Короткий промт даёт случайный результат.'),
                imageUrl: z
                    .string()
                    .optional()
                    .describe('Ссылка на исходное фото. Для роликов обязательна, для картинки — образец предмета.'),
                seconds: z.number().int().optional().describe('Длительность ролика: 6 или 10. По умолчанию 6.')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('media_plan', async (args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            const model = MODELS[args.what];
            if (model.needsImage && !args.imageUrl) {
                return fail(`Для «${model.label}» нужна ссылка на исходное фото — параметр imageUrl.`);
            }

            const draft = {
                what: args.what,
                prompt: args.prompt.trim(),
                ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}),
                ...(args.seconds ? { seconds: args.seconds } : {})
            };

            try {
                // Цену узнаём только здесь: остатка на счёте API не отдаёт, в
                // готовом результате стоимости тоже нет.
                const cost = await estimate(config.higgsfield, model.path, paramsOf(draft));

                const plan: Plan = {
                    ...draft,
                    usd: cost.usd,
                    credits: cost.credits,
                    email: who.email,
                    at: Math.floor(Date.now() / 1000)
                };

                return text(
                    [
                        `Что будет сделано: ${model.label}`,
                        `Стоимость: ${money(cost.usd)} (${cost.credits} кредита)`,
                        draft.imageUrl ? `Исходное фото: ${draft.imageUrl}` : 'Без исходного фото',
                        model.kind === 'video' ? `Длительность: ${draft.seconds ?? 6} с` : '',
                        '',
                        'Промт:',
                        draft.prompt,
                        '',
                        'ПОКАЖИТЕ ЭТО ЧЕЛОВЕКУ И ДОЖДИТЕСЬ ЯВНОГО СОГЛАСИЯ.',
                        'После «да» — media_generate с этой строкой:',
                        encodePlan(plan)
                    ]
                        .filter(Boolean)
                        .join('\n')
                );
            } catch (e) {
                return fail(explain(e));
            }
        })
    );

    server.registerTool(
        'media_generate',
        {
            title: 'Запустить согласованную генерацию',
            description:
                'Второй шаг. Принимает ТОЛЬКО план из media_plan — своих параметров у него нет, поэтому запустится ровно то, ' +
                'что видел человек. Вызывать можно лишь после его прямого согласия. Ставит в очередь и возвращает номер: ' +
                'картинка считается около трёх минут, ролик дольше, результат забирается через media_result.',
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

            const model = MODELS[plan.what];
            try {
                const job = await submit(config.higgsfield, model.path, paramsOf(plan));
                return text(
                    [
                        `Запущено: ${model.label}`,
                        `Списывается: ${money(plan.usd)} (${plan.credits} кредита)`,
                        `Номер задачи: ${job.requestId}`,
                        '',
                        'Через пару минут — media_result с этим номером.',
                        'Готовый файл живёт семь дней, нужное сразу сохраняйте себе.'
                    ].join('\n')
                );
            } catch (e) {
                return fail(explain(e));
            }
        })
    );

    server.registerTool(
        'media_result',
        {
            title: 'Забрать результат генерации',
            description:
                'Готова ли генерация и ссылка на файл. Пока считается — отвечает «в работе», это нормально: ' +
                'картинка занимает около трёх минут, ролик дольше.',
            inputSchema: {
                requestId: z.string().min(8).describe('Номер задачи из media_generate')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('media_result', async (args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            const id = args.requestId.trim();
            const statusUrl = `https://platform.higgsfield.ai/requests/${encodeURIComponent(id)}/status`;

            try {
                const r = await check(config.higgsfield, statusUrl);

                if (!isTerminal(r.status)) {
                    return text(`Ещё в работе (${r.status}). Спросите снова через минуту-другую.`);
                }
                if (r.status === 'nsfw') {
                    return text('Отклонено проверкой содержимого. Деньги не списаны — можно переформулировать и повторить.');
                }
                if (r.status === 'failed') {
                    return text(`Не получилось: ${r.error ?? 'причина не указана'}. Деньги не списаны.`);
                }
                if (r.status === 'canceled') return text('Задача отменена.');
                if (r.urls.length === 0) {
                    return text('Готово, но файлов в ответе нет — похоже на сбой на их стороне.');
                }

                return text(
                    [
                        'Готово:',
                        ...r.urls.map(u => `   ${u}`),
                        '',
                        'Ссылки живут семь дней. Что нужно оставить — скачайте и положите в Google Drive.'
                    ].join('\n')
                );
            } catch (e) {
                return fail(explain(e));
            }
        })
    );
}
