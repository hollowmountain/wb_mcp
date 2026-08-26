import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const csv = (v: string | undefined): string[] =>
    (v ?? '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

const schema = z.object({
    PUBLIC_URL: z.url(),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('127.0.0.1'),

    WB_TOKEN: z.string().min(1, 'WB_TOKEN обязателен: персональный токен из ЛК продавца'),
    WB_SANDBOX: z
        .string()
        .default('false')
        .transform(v => v === 'true'),

    IDENTITY_PROVIDER: z.enum(['google', 'yandex', 'invite']).default('google'),
    ALLOWED_EMAIL_DOMAINS: z.string().default(''),
    ALLOWED_EMAILS: z.string().default(''),
    RESPONDER_EMAILS: z.string().default(''),
    ADMIN_EMAILS: z.string().default(''),

    GOOGLE_CLIENT_ID: z.string().default(''),
    GOOGLE_CLIENT_SECRET: z.string().default(''),
    YANDEX_CLIENT_ID: z.string().default(''),
    YANDEX_CLIENT_SECRET: z.string().default(''),

    DB_PATH: z.string().default('./data/mcp-wb.db'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET: минимум 32 символа, сгенерируйте `openssl rand -hex 32`'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
    LOG_LEVEL: z.string().default('info')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${issues}`);
}
const env = parsed.data;

const publicUrl = new URL(env.PUBLIC_URL);
// Канонический URI ресурса по RFC 8707 — без хвостового слэша и фрагмента.
const resourceUrl = new URL('/mcp', publicUrl);

function providerCredentials(): void {
    if (env.IDENTITY_PROVIDER === 'google' && !(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)) {
        throw new Error('IDENTITY_PROVIDER=google требует GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET');
    }
    if (env.IDENTITY_PROVIDER === 'yandex' && !(env.YANDEX_CLIENT_ID && env.YANDEX_CLIENT_SECRET)) {
        throw new Error('IDENTITY_PROVIDER=yandex требует YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET');
    }
}
providerCredentials();

const allowedDomains = csv(env.ALLOWED_EMAIL_DOMAINS);
const allowedEmails = csv(env.ALLOWED_EMAILS);
const adminEmails = csv(env.ADMIN_EMAILS);

if (allowedDomains.length === 0 && allowedEmails.length === 0 && env.IDENTITY_PROVIDER !== 'invite') {
    throw new Error(
        'Пустой список доступа: задайте ALLOWED_EMAIL_DOMAINS или ALLOWED_EMAILS, иначе коннектором сможет пользоваться кто угодно'
    );
}

export const config = {
    publicUrl,
    issuerUrl: publicUrl,
    resourceUrl,
    port: env.PORT,
    host: env.HOST,

    wb: {
        token: env.WB_TOKEN,
        sandbox: env.WB_SANDBOX
    },

    identityProvider: env.IDENTITY_PROVIDER,
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    yandex: { clientId: env.YANDEX_CLIENT_ID, clientSecret: env.YANDEX_CLIENT_SECRET },

    access: {
        domains: allowedDomains,
        emails: allowedEmails,
        responders: csv(env.RESPONDER_EMAILS),
        admins: adminEmails
    },

    dbPath: env.DB_PATH,
    sessionSecret: env.SESSION_SECRET,
    accessTokenTtl: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtl: env.REFRESH_TOKEN_TTL_SECONDS,
    logLevel: env.LOG_LEVEL
} as const;

export type Role = 'reader' | 'responder' | 'admin';

/** Пускаем ли этот email в коннектор вообще. */
export function isAllowedEmail(email: string): boolean {
    const e = email.toLowerCase();
    if (config.access.emails.includes(e)) return true;
    const domain = e.split('@')[1];
    return domain !== undefined && config.access.domains.includes(domain);
}

/** Роль определяет, может ли человек отправлять ответы клиентам. */
export function roleForEmail(email: string): Role {
    const e = email.toLowerCase();
    if (config.access.admins.includes(e)) return 'admin';
    if (config.access.responders.includes(e)) return 'responder';
    return 'reader';
}

export function canSend(role: Role): boolean {
    return role === 'responder' || role === 'admin';
}
