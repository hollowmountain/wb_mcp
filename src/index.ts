import express from 'express';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';

import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { completeAuthorization, wbOAuthProvider, SUPPORTED_SCOPES } from './auth/provider.js';
import { identity } from './auth/identity/index.js';
import { actorFromAuthInfo } from './auth/provider.js';
import { pruneAudit } from './audit.js';
import { config } from './config.js';
import { cleanupExpired } from './db/index.js';
import { logger } from './logger.js';
import { createMcpServer } from './mcp/server.js';
import { prune as pruneMedia, read as readMedia } from './media/store.js';
import { saveUpload, UploadError } from './media/uploads.js';
import { pruneUploads } from './media/uploads.js';
import { emailFromLink, linkErrorText } from './media/uploadlink.js';
import { panelRouter } from './panel/routes.js';
import { completePanelLogin, purposeOfPending } from './panel/session.js';
import { wbPing } from './wb/client.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(cookieParser());
app.use(
    pinoHttp({
        logger,
        genReqId: req => (req.headers['x-request-id'] as string) ?? randomUUID(),
        autoLogging: { ignore: req => req.url === '/healthz' }
    })
);

// ─── OAuth 2.1: /authorize, /token, /register (DCR), /revoke и оба metadata-документа ───
app.use(
    mcpAuthRouter({
        provider: wbOAuthProvider,
        issuerUrl: config.issuerUrl,
        baseUrl: config.publicUrl,
        resourceServerUrl: config.resourceUrl,
        resourceName: 'Wildberries: отзывы, вопросы и чаты',
        scopesSupported: SUPPORTED_SCOPES,
        serviceDocumentationUrl: new URL('/', config.publicUrl)
    })
);

/**
 * Страницы входа и панель браузеру кэшировать нельзя.
 *
 * Форма входа несёт одноразовый идентификатор заявки, а заявка удаляется сразу
 * после успешного входа. Safari на телефоне охотно достаёт страницу из кэша при
 * возврате назад — и подставляет форму с идентификатором, которого уже нет.
 * Человек видит «страница входа устарела», хотя всё сделал правильно.
 *
 * Панель тоже: на ней данные организации, и оставлять их в кэше телефона,
 * который можно потерять, ни к чему.
 */
app.use(['/idp', '/panel'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// ─── Возврат от провайдера личности ──────────────────────────────────────────
// Провайдер один и тот же для двух сценариев: подключение коннектора (OAuth)
// и вход в веб-панель. Разводим по назначению заявки.
app.use(
    '/idp',
    identity.routes(async (pendingId, verified, res) => {
        if (purposeOfPending(pendingId) === 'panel') {
            await completePanelLogin(pendingId, verified, res);
            return;
        }
        await completeAuthorization(pendingId, verified, res);
    })
);

// ─── Веб-панель ──────────────────────────────────────────────────────────────
app.use('/panel', panelRouter());

// ─── MCP ─────────────────────────────────────────────────────────────────────
const requireAuth = requireBearerAuth({
    verifier: wbOAuthProvider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl)
});

app.post('/mcp', requireAuth, express.json({ limit: '4mb' }), async (req, res) => {
    // Без сессий: на каждый запрос свой сервер и транспорт. Так данные одного
    // сотрудника не могут утечь в соединение другого.
    const server = createMcpServer(actorFromAuthInfo(req.auth));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
        void transport.close();
        void server.close();
    });

    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (e) {
        logger.error({ err: e }, 'mcp request failed');
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Внутренняя ошибка сервера' },
                id: null
            });
        }
    }
});

// В stateless-режиме поток от сервера к клиенту не поддерживается.
const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
    res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: сервер работает без сессий, используйте POST /mcp' },
        id: null
    });
};
app.get('/mcp', requireAuth, methodNotAllowed);
app.delete('/mcp', requireAuth, methodNotAllowed);

// ─── Готовые картинки ────────────────────────────────────────────────────────
// Без входа в панель, но по подписанной ссылке: менеджер открывает её прямо
// из переписки, а перебором чужую карточку до публикации не достать.
app.get('/media/:id', (req, res) => {
    const signature = typeof req.query.s === 'string' ? req.query.s : '';
    const found = readMedia(req.params.id, signature);
    if (!found) {
        res.status(404).type('text/plain; charset=utf-8').send('Картинка не найдена или ссылка устарела.');
        return;
    }
    res.type(found.mime)
        .set('Cache-Control', 'private, max-age=86400')
        .set('Content-Disposition', `inline; filename="${req.params.id}"`)
        .send(found.bytes);
});

// ─── Загрузка своего фото по ссылке из чата ──────────────────────────────────
// Входа в панель здесь нет намеренно: человек уже опознан коннектором, а
// ссылка сама несёт подписанную почту и срок. Барьер с кодом убран — он
// стоил менеджеру больше, чем давал.
app.get('/u/:token', (req, res) => {
    const who = emailFromLink(req.params.token);
    if (who === 'битая' || who === 'подделана' || who === 'просрочена') {
        res.status(410).type('html').send(uploadPage(null, linkErrorText(who)));
        return;
    }
    res.type('html').send(uploadPage(req.params.token, null));
});

app.post('/u/:token', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '25mb' }), (req, res) => {
    const who = emailFromLink(req.params.token);
    if (who === 'битая' || who === 'подделана' || who === 'просрочена') {
        res.status(410).json({ error: linkErrorText(who) });
        return;
    }
    try {
        const mime = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
        const note = typeof req.query.note === 'string' ? req.query.note.slice(0, 120) : undefined;
        const upload = saveUpload(who, req.body as Buffer, mime, note);
        res.json({ code: upload.code });
    } catch (e) {
        const message = e instanceof UploadError ? e.message : 'Не удалось сохранить файл.';
        if (!(e instanceof UploadError)) logger.error({ err: e }, 'upload failed');
        res.status(400).json({ error: message });
    }
});

// ─── Служебное ───────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
});

app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html lang="ru"><meta charset="utf-8">
<title>MCP-коннектор Wildberries</title>
<body style="font:16px/1.6 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>MCP-коннектор Wildberries</h1>
<p>Это remote MCP-сервер для работы с отзывами, вопросами и чатами покупателей.</p>
<p>Адрес для подключения в Claude: <code>${config.resourceUrl.href}</code></p>
<p>Доступ выдаёт администратор организации. Вход — через ${config.identityProvider}.</p>
<p><a href="/panel">Панель состояния</a></p>
</body></html>`);
});

// ─── Запуск ──────────────────────────────────────────────────────────────────
setInterval(cleanupExpired, 10 * 60 * 1000).unref();

// Журнал теперь пополняется на каждый вызов инструмента, поэтому его надо
// подрезать. Раз в сутки и один раз при старте: если сервер долго не
// перезапускали, чистка всё равно случится.
pruneAudit();
setInterval(() => pruneAudit(), 24 * 60 * 60 * 1000).unref();

// Картинки тяжёлые, а диск на сервере маленький: чистим по тому же расписанию.
pruneMedia();
setInterval(() => pruneMedia(), 24 * 60 * 60 * 1000).unref();

// Исходники живут час, поэтому и убирать их надо часто: раз в сутки
// означало бы, что файл лежит на диске ещё сутки после того, как протух.
pruneUploads();
setInterval(() => pruneUploads(), 10 * 60 * 1000).unref();

/** Страница загрузки: одна кнопка, одна подпись, никакого входа. */
function uploadPage(token: string | null, error: string | null): string {
    const head = `<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Фото товара</title>
<style>
  body { font: 17px/1.55 system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1.2rem; color: #1b1f2a; }
  h1 { font-size: 1.5rem; margin: 0 0 .4rem; }
  p.lead { color: #5a5f6e; margin-top: 0; }
  .drop { border: 2px dashed #c9cfdb; border-radius: 8px; padding: 2.2rem 1rem; text-align: center; background: #fafbfd; }
  input[type=text] { width: 100%; padding: .6rem; border: 1px solid #c9cfdb; border-radius: 6px; font: inherit; margin-top: .3rem; }
  label { display: block; margin-top: 1.1rem; font-size: .92rem; color: #5a5f6e; }
  .ok { background: #eefaf0; border: 1px solid #b7e2c0; padding: .9rem 1rem; border-radius: 7px; margin-top: 1.1rem; }
  .err { background: #fdeeee; border: 1px solid #f0bcbc; padding: .9rem 1rem; border-radius: 7px; margin-top: 1.1rem; }
  .note { color: #8a8f9c; font-size: .88rem; margin-top: 1.6rem; }
</style>`;

    if (error) return `${head}<h1>Ссылка не работает</h1><div class="err">${error}</div></html>`;

    return `${head}
<h1>Фото товара</h1>
<p class="lead">Выберите снимок — и возвращайтесь в чат, там уже можно продолжать.</p>
<div class="drop">
  <div>JPEG, PNG или WebP, до 25 МБ</div>
  <input type="file" id="file" accept="image/jpeg,image/png,image/webp" style="margin-top:.8rem">
</div>
<label for="note">Что это за товар</label>
<input type="text" id="note" placeholder="Ланолин 50 г, съёмка на белом" maxlength="120">
<div id="out"></div>
<p class="note">Снимок хранится час и удаляется сам. Фото с айфона в формате HEIC не принимается — сохраните как JPEG.</p>
<script>
  const f = document.getElementById('file'), n = document.getElementById('note'), o = document.getElementById('out');
  f.addEventListener('change', async () => {
    const file = f.files && f.files[0];
    if (!file) return;
    o.innerHTML = '<div class="ok">Загружаю…</div>';
    try {
      const url = location.pathname + (n.value ? '?note=' + encodeURIComponent(n.value) : '');
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'не получилось');
      o.innerHTML = '<div class="ok"><b>Готово.</b> Вернитесь в чат и скажите, что загрузили — фото уже там.</div>';
    } catch (e) {
      o.innerHTML = '<div class="err">' + (e && e.message ? e.message : 'Не удалось загрузить') + '</div>';
    }
  });
</script>
</html>`;
}

const server = app.listen(config.port, config.host, () => {
    logger.info(
        {
            listen: `${config.host}:${config.port}`,
            publicUrl: config.publicUrl.href,
            mcpUrl: config.resourceUrl.href,
            identityProvider: config.identityProvider,
            sandbox: config.wb.sandbox,
            cabinets: config.cabinets.slugs()
        },
        'mcp-wb запущен'
    );

    for (const warning of config.cabinets.warnings) {
        logger.warn({ cabinets: true }, warning);
    }

    // Проверяем токены на старте, чтобы проблема всплыла в логах, а не у пользователя.
    for (const cabinet of config.cabinets.all()) {
        void wbPing(cabinet).then(status => {
            const payload = { cabinet: cabinet.slug, readOnly: cabinet.info.readOnly, status };
            if (status.feedbacks && (status.chat || config.wb.sandbox)) {
                logger.info(payload, `кабинет ${cabinet.slug}: токен WB принят`);
            } else {
                logger.warn(payload, `кабинет ${cabinet.slug}: токен WB работает не полностью`);
            }
        });
    }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        logger.info({ signal }, 'останавливаюсь');
        server.close(() => process.exit(0));
    });
}
