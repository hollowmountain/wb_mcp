import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Actor } from '../../auth/provider.js';
import { inArea } from '../../auth/provider.js';
import { config } from '../../config.js';
import { check, estimate, isTerminal, MODELS, submit, HiggsfieldError } from '../../media/higgsfield.js';
import { actorOf, fail, guarded, text } from './common.js';

/** Дороже этого — не запускаем молча, а спрашиваем. */
const ASK_ABOVE_USD = 0.5;

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

/** Ошибку площадки показываем человеческими словами, а не как есть. */
const explain = (e: unknown): string =>
    e instanceof HiggsfieldError ? e.toUserMessage() : e instanceof Error ? e.message : String(e);

export function registerMediaTools(server: McpServer, actor: Actor): void {
    if (!available(actor)) return;

    server.registerTool(
        'media_generate',
        {
            title: 'Сгенерировать картинку или видео',
            description:
                'Ставит генерацию в очередь и возвращает номер задачи. Результат забирается отдельно, инструментом media_result: ' +
                'даже картинка считается около трёх минут, а ролик дольше, и ждать внутри одного вызова нельзя. ' +
                'ВАЖНО про товары: модель рисует похожий предмет и дописывает на него выдуманные буквы, поэтому ' +
                'для карточек с настоящим товаром она не годится — только фоны, сцены и оживление готового фото.',
            inputSchema: {
                what: z
                    .enum(['photo', 'video_fast', 'video'])
                    .describe(
                        'photo — картинка по описанию (0,05 кредита); ' +
                            'video_fast — ролик из готового фото подешевле (~3 кредита); ' +
                            'video — ролик из фото поплавнее (~3,4 кредита)'
                    ),
                prompt: z.string().min(3).describe('Что должно получиться, словами'),
                imageUrl: z
                    .string()
                    .optional()
                    .describe('Ссылка на исходное фото. Обязательна для video и video_fast.'),
                seconds: z.number().int().optional().describe('Длительность ролика: 6 или 10. По умолчанию 6.'),
                confirmCost: z
                    .boolean()
                    .optional()
                    .describe('Подтверждение, если оценка вышла дороже половины доллара')
            },
            annotations: { readOnlyHint: false, openWorldHint: true }
        },
        guarded('media_generate', async (args, extra) => {
            const who = actorOf(extra);
            const no = denied(who);
            if (no) return fail(no);

            const model = MODELS[args.what];
            if (model.needsImage && !args.imageUrl) {
                return fail(`Для «${model.label}» нужна ссылка на исходное фото — параметр imageUrl.`);
            }

            const params: Record<string, unknown> = { prompt: args.prompt };
            if (args.imageUrl) params.image_url = args.imageUrl;
            if (model.kind === 'video') params.duration = args.seconds ?? 6;

            try {
                // Считаем цену до запуска. Ни остатка на счёте, ни стоимости
                // в готовом результате API не отдаёт — если не спросить
                // сейчас, узнать будет негде.
                const cost = await estimate(config.higgsfield, model.path, params);

                if (cost.usd > ASK_ABOVE_USD && !args.confirmCost) {
                    return text(
                        `Эта генерация стоит ${money(cost.usd)} (${cost.credits} кредита) — дороже обычного.\n` +
                            'Если запускаем, повторите вызов с confirmCost: true.'
                    );
                }

                const job = await submit(config.higgsfield, model.path, params);

                return text(
                    [
                        `Поставлено в очередь: ${model.label}`,
                        `Стоимость: ${money(cost.usd)} (${cost.credits} кредита)`,
                        `Номер задачи: ${job.requestId}`,
                        '',
                        'Через пару минут спросите результат: media_result с этим номером.',
                        'Готовый файл Higgsfield хранит семь дней, потом удаляет — нужное сразу сохраняйте себе.'
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
