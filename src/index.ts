import express from 'express';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';

import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { completeAuthorization, wbOAuthProvider, SUPPORTED_SCOPES } from './auth/provider.js';
import { identity } from './auth/identity/index.js';
import { config } from './config.js';
import { cleanupExpired } from './db/index.js';
import { logger } from './logger.js';
import { createMcpServer } from './mcp/server.js';
import { wbPing } from './wb/client.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

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

// ─── Возврат от провайдера личности ──────────────────────────────────────────
app.use('/idp', identity.routes(completeAuthorization));

// ─── MCP ─────────────────────────────────────────────────────────────────────
const requireAuth = requireBearerAuth({
    verifier: wbOAuthProvider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl)
});

app.post('/mcp', requireAuth, express.json({ limit: '4mb' }), async (req, res) => {
    // Без сессий: на каждый запрос свой сервер и транспорт. Так данные одного
    // сотрудника не могут утечь в соединение другого.
    const server = createMcpServer();
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
</body></html>`);
});

// ─── Запуск ──────────────────────────────────────────────────────────────────
setInterval(cleanupExpired, 10 * 60 * 1000).unref();

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
