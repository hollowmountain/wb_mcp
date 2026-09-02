import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import type { OzonCabinet } from './ozon/client.js';
import { buildCabinet, CabinetRegistry, type Cabinet } from './wb/cabinets.js';

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

    WB_TOKEN: z.string().default(''),
    WB_CABINETS: z.string().default(''),
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
    NEPSELL_TOKEN: z.string().default(''),
    NEPSELL_EMAILS: z.string().default(''),

    ONEC_BASE_URL: z.string().default(''),
    ONEC_USER: z.string().default(''),
    ONEC_PASSWORD: z.string().default(''),
    ONEC_EMAILS: z.string().default(''),
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


/**
 * Кабинеты задаются так:
 *   WB_CABINETS=main,opt
 *   WB_LABEL_MAIN=Основной кабинет
 *   WB_TOKEN_MAIN=eyJ...            узкий токен с записью: отзывы и чат
 *   WB_DATA_TOKEN_MAIN=eyJ...       широкий токен только на чтение: данные
 *   WB_TOKEN_OPT=eyJ...
 *
 * Второй токен необязателен: без него кабинет работает как раньше, но
 * инструменты по заказам, карточкам и остаткам для него недоступны.
 * Почему токенов два — см. комментарий к Cabinet в wb/cabinets.ts.
 *
 * Для совместимости одиночный WB_TOKEN превращается в кабинет `main`.
 */
function buildRegistry(): CabinetRegistry {
    const slugs = csv(env.WB_CABINETS);
    const cabinets: Cabinet[] = [];

    if (slugs.length === 0) {
        if (!env.WB_TOKEN) {
            throw new Error(
                'Не настроен ни один кабинет Wildberries. Задайте WB_CABINETS и WB_TOKEN_<SLUG>, либо одиночный WB_TOKEN.'
            );
        }
        cabinets.push(buildCabinet('main', 'Кабинет Wildberries', env.WB_TOKEN, process.env.WB_DATA_TOKEN?.trim()));
        return new CabinetRegistry(cabinets);
    }

    for (const slug of slugs) {
        const key = slug.toUpperCase().replaceAll('-', '_');
        const token = process.env[`WB_TOKEN_${key}`]?.trim();
        if (!token) {
            throw new Error(`Кабинет «${slug}» объявлен в WB_CABINETS, но переменная WB_TOKEN_${key} пуста`);
        }
        cabinets.push(
            buildCabinet(
                slug,
                process.env[`WB_LABEL_${key}`]?.trim() ?? '',
                token,
                process.env[`WB_DATA_TOKEN_${key}`]?.trim()
            )
        );
    }
    return new CabinetRegistry(cabinets);
}

/**
 * Кабинеты Ozon задаются так:
 *   OZON_CABINETS=beauty,harbez
 *   OZON_CLIENT_ID_BEAUTY=12345
 *   OZON_API_KEY_BEAUTY=...
 *
 * Слаги имеет смысл держать теми же, что у WB: одно юрлицо — один слаг.
 */
function buildOzonCabinets(): OzonCabinet[] {
    const out: OzonCabinet[] = [];
    for (const slug of csv(process.env.OZON_CABINETS)) {
        const key = slug.toUpperCase().replaceAll('-', '_');
        const clientId = process.env[`OZON_CLIENT_ID_${key}`]?.trim();
        const apiKey = process.env[`OZON_API_KEY_${key}`]?.trim();
        if (!clientId || !apiKey) {
            throw new Error(
                `Кабинет Ozon «${slug}» объявлен в OZON_CABINETS, но OZON_CLIENT_ID_${key} или OZON_API_KEY_${key} пуст`
            );
        }
        out.push({ slug, clientId, apiKey });
    }
    return out;
}

export const config = {
    publicUrl,
    issuerUrl: publicUrl,
    resourceUrl,
    port: env.PORT,
    host: env.HOST,

    wb: {
        sandbox: env.WB_SANDBOX
    },
    cabinets: buildRegistry(),
    /** Кабинеты Ozon. Пусто — Ozon не настроен, панель просто не покажет раздел. */
    ozon: buildOzonCabinets(),
    /** Пустой токен — Nepsell выключен, инструменты не появляются ни у кого. */
    nepsell: { token: env.NEPSELL_TOKEN },
    /** Пустой адрес — 1С выключена. */
    onec: {
        baseUrl: env.ONEC_BASE_URL.replace(/\/+$/, ''),
        user: env.ONEC_USER,
        password: env.ONEC_PASSWORD
    },

    identityProvider: env.IDENTITY_PROVIDER,
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    yandex: { clientId: env.YANDEX_CLIENT_ID, clientSecret: env.YANDEX_CLIENT_SECRET },

    access: {
        domains: allowedDomains,
        emails: allowedEmails,
        responders: csv(env.RESPONDER_EMAILS),
        nepsell: csv(env.NEPSELL_EMAILS),
        onec: csv(env.ONEC_EMAILS),
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

/**
 * Кому открыт Nepsell. Отдельный список, а не роль: там себестоимость и
 * экономика, и видеть их должен не тот, кто отвечает на отзывы, а тот, кому
 * это по работе. Администраторы видят всегда.
 */
export function canUseNepsell(email: string): boolean {
    if (!config.nepsell.token) return false;
    const e = email.toLowerCase();
    return config.access.admins.includes(e) || config.access.nepsell.includes(e);
}

/**
 * Кому открыта 1С. Список отдельный от Nepsell: это разные источники и
 * разная чувствительность. В базе «Красота» зарплата не ведётся — все
 * зарплатные объекты пустые, проверено, — но справочники сотрудников и
 * физических лиц там есть, поэтому список держим коротким.
 */
export function canUseOnec(email: string): boolean {
    if (!config.onec.baseUrl || !config.onec.user) return false;
    const e = email.toLowerCase();
    return config.access.admins.includes(e) || config.access.onec.includes(e);
}
