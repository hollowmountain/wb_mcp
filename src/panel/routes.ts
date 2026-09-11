import express, { Router } from 'express';

import { toolUsage } from '../audit.js';
import { areasOf, config } from '../config.js';
import { db, kvGet, kvSet } from '../db/index.js';
import { logger } from '../logger.js';
import type { Cabinet } from '../wb/cabinets.js';
import {
    countUnansweredFeedbacks,
    countUnansweredQuestions,
    getSellerInfo,
    listChats,
    type SellerInfo
} from '../wb/api.js';
import { WbApiError } from '../wb/client.js';
import { getOzonSellerInfo, probeOzonAccess } from '../ozon/client.js';
import { listUploads, saveUpload, UploadError } from '../media/uploads.js';
import { renderPanel, type CabinetStatus, type OzonStatus, type PanelData } from './render.js';
import { beginPanelLogin, clearSession, readSession } from './session.js';

/**
 * Данные о продавце меняются раз в год, а лимиты WB тратить жалко:
 * держим их в памяти процесса.
 */
const sellerCache = new Map<string, SellerInfo>();

async function sellerOf(cabinet: Cabinet): Promise<SellerInfo | null> {
    const cached = sellerCache.get(cabinet.slug);
    if (cached) return cached;
    try {
        const info = await getSellerInfo(cabinet);
        sellerCache.set(cabinet.slug, info);
        return info;
    } catch {
        return null;
    }
}

async function statusOf(cabinet: Cabinet): Promise<CabinetStatus> {
    const seller = await sellerOf(cabinet);
    try {
        const [feedbacks, questions] = await Promise.all([
            countUnansweredFeedbacks(cabinet),
            countUnansweredQuestions(cabinet)
        ]);

        let chats: number | null = null;
        try {
            chats = (await listChats(cabinet)).length;
        } catch {
            chats = null;
        }

        return {
            cabinet,
            seller,
            error: null,
            counts: {
                feedbacksUnanswered: feedbacks.countUnanswered,
                feedbacksToday: feedbacks.countUnansweredToday,
                questionsUnanswered: questions.countUnanswered,
                questionsToday: questions.countUnansweredToday,
                chats
            }
        };
    } catch (e) {
        return {
            cabinet,
            seller,
            counts: null,
            error: e instanceof WbApiError ? e.toUserMessage() : String(e)
        };
    }
}

/**
 * Состояние кабинетов Ozon. Каждое обращение — четыре запроса к Ozon, а панель
 * сама обновляется раз в две минуты, поэтому держим результат полчаса.
 */
const OZON_TTL_MS = 30 * 60 * 1000;

async function ozonStatuses(): Promise<OzonStatus[]> {
    if (config.ozon.length === 0) return [];

    const cached = kvGet('panel.ozon');
    if (cached) {
        try {
            const parsed = JSON.parse(cached) as { at: number; rows: OzonStatus[] };
            if (Date.now() - parsed.at < OZON_TTL_MS) return parsed.rows;
        } catch {
            // Повреждённый кэш не повод падать — соберём заново.
        }
    }

    const rows = await Promise.all(
        config.ozon.map(async (cab): Promise<OzonStatus> => {
            try {
                const [info, access] = await Promise.all([getOzonSellerInfo(cab), probeOzonAccess(cab)]);
                return {
                    slug: cab.slug,
                    company: info.company?.name ?? null,
                    legalName: info.company?.legal_name ?? null,
                    subscriptionType: info.subscription?.type ?? null,
                    isPremium: Boolean(info.subscription?.is_premium),
                    access,
                    error: null
                };
            } catch (e) {
                return {
                    slug: cab.slug,
                    company: null,
                    legalName: null,
                    subscriptionType: null,
                    isPremium: false,
                    access: null,
                    error: e instanceof Error ? e.message : String(e)
                };
            }
        })
    );
    kvSet('panel.ozon', JSON.stringify({ at: Date.now(), rows }));
    return rows;
}

export function panelRouter(): Router {
    const router = Router();

    router.get('/login', (req, res) => {
        // Уже вошёл — форма не нужна. Так кэшированная ссылка на вход
        // не выкидывает человека из панели, в которой он сидит.
        if (readSession(req)) {
            res.redirect('/panel');
            return;
        }
        beginPanelLogin(res);
    });

    // ─── Свои исходники для генерации ───────────────────────────────────────
    // Файл принимаем сырым телом, а не формой: multipart пришлось бы разбирать
    // руками, а браузер и так умеет слать байты с нужным Content-Type.
    router.post('/reference', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '25mb' }), (req, res) => {
        const session = readSession(req);
        if (!session) {
            res.status(401).json({ error: 'Войдите в панель заново.' });
            return;
        }
        try {
            const mime = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
            const note = typeof req.query.note === 'string' ? req.query.note.slice(0, 120) : undefined;
            const upload = saveUpload(session.email, req.body as Buffer, mime, note);
            res.json({ code: upload.code, bytes: upload.bytes });
        } catch (e) {
            const message = e instanceof UploadError ? e.message : 'Не удалось сохранить файл.';
            if (!(e instanceof UploadError)) logger.error({ err: e }, 'upload failed');
            res.status(400).json({ error: message });
        }
    });

    router.get('/reference', (req, res) => {
        const session = readSession(req);
        if (!session) {
            res.redirect('/panel/login');
            return;
        }
        res.type('html').send(renderUploadPage(listUploads(session.email)));
    });

    router.get('/logout', (_req, res) => {
        clearSession(res);
        res.redirect('/panel/login');
    });

    router.get('/', async (req, res) => {
        const session = readSession(req);
        if (!session) {
            res.redirect('/panel/login');
            return;
        }

        try {
            const visible = config.cabinets
                .all()
                .filter(c => session.cabinets === null || session.cabinets.includes(c.slug));
            const cabinets = await Promise.all(visible.map(statusOf));

            // Список сотрудников — сведения о всей организации. Их видит только
            // администратор; ограниченный сотрудник видит одну свою строку.
            const isAdmin = session.role === 'admin';
            // Видеть работу коллег и иметь право отправлять покупателям — разные
            // вещи, а раньше их давала одна роль администратора. Теперь это
            // отдельная область: её можно выдать, не открывая отправку.
            const areasRow = db.prepare('SELECT areas FROM users WHERE email = ?').get(session.email) as
                | { areas: string | null }
                | undefined;
            const seesEveryone = isAdmin || areasOf(session.email, areasRow?.areas).includes('people');
            const users = (
                seesEveryone
                    ? db.prepare('SELECT email, name, last_seen FROM users ORDER BY last_seen DESC LIMIT 50').all()
                    : db.prepare('SELECT email, name, last_seen FROM users WHERE email = ?').all(session.email)
            ) as Array<{ email: string; name: string | null; last_seen: number }>;

            const areasOfUser = (email: string): string => {
                const row = db.prepare('SELECT areas FROM users WHERE email = ?').get(email) as
                    | { areas: string | null }
                    | undefined;
                const list = areasOf(email, row?.areas);
                return row?.areas ? list.join(', ') : `${list.join(', ')} (по умолчанию)`;
            };

            const scopeOf = (email: string): string => {
                const row = db.prepare('SELECT cabinets FROM users WHERE email = ?').get(email) as
                    | { cabinets: string | null }
                    | undefined;
                return row?.cabinets ? row.cabinets : 'все';
            };

            // Журнал: администратору целиком, остальным — только свои действия
            // и события своих кабинетов. Чужая активность не показывается.
            const allowed = session.cabinets;
            const audit = (
                seesEveryone || allowed === null
                    ? db
                          .prepare('SELECT ts, cabinet, actor, action, target, outcome FROM audit ORDER BY ts DESC LIMIT 40')
                          .all()
                    : db
                          .prepare(
                              `SELECT ts, cabinet, actor, action, target, outcome FROM audit
                               WHERE actor = ? OR cabinet IN (${allowed.map(() => '?').join(',')})
                               ORDER BY ts DESC LIMIT 40`
                          )
                          .all(session.email, ...allowed)
            ) as PanelData['audit'];

            // Счётчики черновиков — тоже в пределах доступных кабинетов.
            const counts = (
                allowed === null
                    ? db.prepare('SELECT status, COUNT(*) AS n FROM drafts GROUP BY status').all()
                    : db
                          .prepare(
                              `SELECT status, COUNT(*) AS n FROM drafts
                               WHERE cabinet IN (${allowed.map(() => '?').join(',')}) GROUP BY status`
                          )
                          .all(...allowed)
            ) as Array<{ status: string; n: number }>;
            const byStatus = (s: string): number => counts.find(c => c.status === s)?.n ?? 0;

            // Очередь черновиков в разрезе кабинетов: видно, где накопилось.
            const perCabinet = (
                allowed === null
                    ? db
                          .prepare("SELECT cabinet, COUNT(*) AS n FROM drafts WHERE status = 'pending' GROUP BY cabinet")
                          .all()
                    : db
                          .prepare(
                              `SELECT cabinet, COUNT(*) AS n FROM drafts WHERE status = 'pending'
                               AND cabinet IN (${allowed.map(() => '?').join(',')}) GROUP BY cabinet`
                          )
                          .all(...allowed)
            ) as Array<{ cabinet: string; n: number }>;

            // Ozon показываем только администратору: это сведения об организации.
            const ozon = isAdmin ? await ozonStatuses().catch(() => []) : [];

            res.type('html').send(
                renderPanel({
                    session,
                    cabinets,
                    users: users.map(u => ({ ...u, role: roleLabel(u.email), scope: scopeOf(u.email), areas: areasOfUser(u.email) })),
                    isAdmin: seesEveryone,
                    // Как и журнал: администратору по всем, остальным — только своё.
                    usage: toolUsage(7, seesEveryone ? undefined : session.email),
                    audit,
                    drafts: { pending: byStatus('pending'), sent: byStatus('sent'), failed: byStatus('failed') },
                    draftsByCabinet: perCabinet
                        .map(r => ({ cabinet: r.cabinet, pending: r.n }))
                        .sort((a, b) => b.pending - a.pending),
                    ozon,
                    generatedAt: Math.floor(Date.now() / 1000)
                })
            );
        } catch (e) {
            logger.error({ err: e }, 'panel render failed');
            res.status(500).type('text/plain').send('Не удалось собрать данные панели. Смотрите логи сервера.');
        }
    });

    return router;
}

/**
 * Страница загрузки. Нарочно простая: её открывают раз в месяц, когда
 * пришла новая съёмка, и всё, что от неё нужно, — отдать короткий код.
 */
function renderUploadPage(uploads: ReturnType<typeof listUploads>): string {
    const rows =
        uploads.length === 0
            ? '<p class="empty">Пока ничего не загружено.</p>'
            : `<table>
        <tr><th>Код</th><th>Что это</th><th>Размер</th><th>Загружено</th></tr>
        ${uploads
            .map(
                u => `<tr>
          <td><code>${u.code}</code></td>
          <td>${u.note ? escapeHtml(u.note) : '—'}</td>
          <td>${Math.round(u.bytes / 1024)} КБ</td>
          <td>${new Date(u.createdAt * 1000).toLocaleString('ru-RU')}</td>
        </tr>`
            )
            .join('')}
      </table>`;

    return `<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Свои фото товара</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; color: #1b1f2a; }
  h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
  p.lead { color: #5a5f6e; margin-top: 0; }
  .drop { border: 2px dashed #c9cfdb; border-radius: 6px; padding: 2rem; text-align: center; background: #fafbfd; }
  .drop input { margin-top: .75rem; }
  label { display: block; margin: 1rem 0 .25rem; font-size: .9rem; color: #5a5f6e; }
  input[type=text] { width: 100%; padding: .5rem; border: 1px solid #c9cfdb; border-radius: 4px; font: inherit; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: .95rem; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid #e6e9f0; }
  th { font-weight: 600; color: #5a5f6e; font-size: .85rem; }
  code { background: #f1f3f8; padding: .15rem .4rem; border-radius: 3px; font-size: .95rem; }
  .ok { background: #eefaf0; border: 1px solid #b7e2c0; padding: .75rem 1rem; border-radius: 5px; margin-top: 1rem; }
  .err { background: #fdeeee; border: 1px solid #f0bcbc; padding: .75rem 1rem; border-radius: 5px; margin-top: 1rem; }
  .empty { color: #8a8f9c; }
  a { color: #2c5aa0; }
</style>
<h1>Свои фото товара</h1>
<p class="lead">Загрузите студийный снимок — он подойдёт для генерации лучше, чем кадр из карточки,
где на товар наложена инфографика. После загрузки вы получите короткий код: назовите его в чате,
и Claude возьмёт этот файл как исходник.</p>

<div class="drop">
  <div>JPEG, PNG или WebP, до 25 МБ</div>
  <input type="file" id="file" accept="image/jpeg,image/png,image/webp">
</div>
<label for="note">Что это за товар (чтобы потом узнать код в списке)</label>
<input type="text" id="note" placeholder="Ланолин 50 г, съёмка на белом" maxlength="120">
<div id="out"></div>

${rows}
<p style="margin-top:2rem"><a href="/panel">← В панель</a></p>

<script>
  const file = document.getElementById('file');
  const note = document.getElementById('note');
  const out = document.getElementById('out');
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    out.innerHTML = '<div class="ok">Загружаю…</div>';
    try {
      const url = '/panel/reference' + (note.value ? '?note=' + encodeURIComponent(note.value) : '');
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': f.type }, body: f });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'не получилось');
      out.innerHTML = '<div class="ok">Готово. Код исходника: <code>' + data.code +
        '</code><br>Скажите в чате: «возьми исходник ' + data.code + '».</div>';
      setTimeout(() => location.reload(), 2500);
    } catch (e) {
      out.innerHTML = '<div class="err">' + (e && e.message ? e.message : 'Не удалось загрузить') + '</div>';
    }
  });
</script>
</html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function roleLabel(email: string): string {
    const e = email.toLowerCase();
    if (config.access.admins.includes(e)) return 'admin';
    if (config.access.responders.includes(e)) return 'responder';
    return 'reader';
}
