import { escapeHtml } from '../auth/pages.js';
import { config } from '../config.js';
import type { Cabinet } from '../wb/cabinets.js';
import { CATEGORY_NAMES, daysLeft } from '../wb/token.js';
import type { SellerInfo } from '../wb/api.js';
import type { PanelSession } from './session.js';

export interface CabinetStatus {
    cabinet: Cabinet;
    seller: SellerInfo | null;
    counts: {
        feedbacksUnanswered: number;
        feedbacksToday: number;
        questionsUnanswered: number;
        questionsToday: number;
        chats: number | null;
    } | null;
    error: string | null;
}

export interface PanelData {
    session: PanelSession;
    cabinets: CabinetStatus[];
    users: Array<{ email: string; name: string | null; last_seen: number; role: string }>;
    audit: Array<{ ts: number; cabinet: string | null; actor: string; action: string; target: string | null; outcome: string }>;
    drafts: { pending: number; sent: number; failed: number };
    generatedAt: number;
}

const ts = (seconds: number): string => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Лимиты и назначение каждого API WB, который использует сервер. */
const API_TABLE: Array<{ host: string; category: string; limit: string; used: string }> = [
    {
        host: 'feedbacks-api.wildberries.ru',
        category: 'Вопросы и отзывы',
        limit: '3 запроса/сек, всплеск 6',
        used: 'отзывы, вопросы, ответы на них'
    },
    {
        host: 'buyer-chat-api.wildberries.ru',
        category: 'Чат с покупателями',
        limit: '10 запросов/10 сек, всплеск 10',
        used: 'список чатов, лента событий, отправка сообщений'
    },
    {
        host: 'common-api.wildberries.ru',
        category: 'любая',
        limit: '10 запросов/10 сек',
        used: 'информация о продавце'
    },
    {
        host: 'returns-api.wildberries.ru',
        category: 'Возвраты покупателями',
        limit: '20 запросов/мин',
        used: 'не подключено в этой версии'
    }
];

function badge(text: string, tone: 'ok' | 'warn' | 'bad' | 'mute'): string {
    return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function cabinetCard(status: CabinetStatus): string {
    const { cabinet, seller, counts, error } = status;
    const info = cabinet.info;
    const left = daysLeft(info);

    const rights = info.readOnly ? badge('только чтение', 'warn') : badge('чтение и запись', 'ok');
    const kind = info.kind === 'personal' ? badge('персональный', 'ok') : badge(info.kind, 'bad');
    const expiry =
        left === null
            ? badge('срок неизвестен', 'mute')
            : left < 14
              ? badge(`истекает через ${left} дн.`, 'bad')
              : left < 45
                ? badge(`истекает через ${left} дн.`, 'warn')
                : badge(`${left} дн. до истечения`, 'mute');

    const cats = [...info.categories].map(k => CATEGORY_NAMES[k]);
    const extra = cats.length > 2 ? badge(`категорий ${cats.length} — шире необходимого`, 'warn') : '';

    const numbers = error
        ? `<p class="err">${escapeHtml(error)}</p>`
        : counts
          ? `<div class="nums">
               <div><b>${counts.feedbacksUnanswered}</b><span>отзывов без ответа</span></div>
               <div><b>${counts.questionsUnanswered}</b><span>вопросов без ответа</span></div>
               <div><b>${counts.chats ?? '—'}</b><span>чатов</span></div>
             </div>`
          : '';

    return `<article class="card">
  <header>
    <h3>${escapeHtml(cabinet.label)}</h3>
    <code>${escapeHtml(cabinet.slug)}</code>
  </header>
  ${seller ? `<p class="muted">${escapeHtml(seller.name)} · бренд ${escapeHtml(seller.tradeMark)} · ИНН ${escapeHtml(seller.tin)}</p>` : ''}
  <p>${kind} ${rights} ${expiry} ${extra}</p>
  <p class="muted">Категории токена: ${escapeHtml(cats.join(', ') || 'нет')}</p>
  ${cabinet.problems.length > 0 ? `<p class="err">${escapeHtml(cabinet.problems.join('; '))}</p>` : ''}
  ${numbers}
</article>`;
}

export function renderPanel(data: PanelData): string {
    const totals = data.cabinets.reduce(
        (acc, c) => {
            if (!c.counts) return acc;
            acc.feedbacks += c.counts.feedbacksUnanswered;
            acc.questions += c.counts.questionsUnanswered;
            acc.chats += c.counts.chats ?? 0;
            return acc;
        },
        { feedbacks: 0, questions: 0, chats: 0 }
    );

    const apiRows = API_TABLE.map(
        r => `<tr><td><code>${escapeHtml(r.host)}</code></td><td>${escapeHtml(r.category)}</td>
              <td>${escapeHtml(r.limit)}</td><td class="muted">${escapeHtml(r.used)}</td></tr>`
    ).join('');

    const userRows = data.users
        .map(
            u => `<tr><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.role)}</td>
                  <td class="muted">${ts(u.last_seen)}</td></tr>`
        )
        .join('');

    const auditRows = data.audit
        .map(
            a => `<tr><td class="muted">${ts(a.ts)}</td><td>${escapeHtml(a.actor)}</td>
                  <td><code>${escapeHtml(a.action)}</code></td>
                  <td>${escapeHtml(a.cabinet ?? '—')}</td>
                  <td>${a.outcome === 'ok' ? badge('ok', 'ok') : a.outcome === 'denied' ? badge('отказ', 'warn') : badge('ошибка', 'bad')}</td></tr>`
        )
        .join('');

    return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>Панель коннектора Wildberries</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, CanvasText 14%, Canvas);
          --muted: color-mix(in srgb, CanvasText 60%, Canvas);
          --soft: color-mix(in srgb, CanvasText 5%, Canvas); }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         margin: 0; background: Canvas; color: CanvasText; }
  .wrap { max-width: 68rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  header.top { display: flex; flex-wrap: wrap; gap: .75rem; align-items: baseline;
               justify-content: space-between; margin-bottom: .35rem; }
  h1 { font-size: 1.4rem; margin: 0; }
  h2 { font-size: 1.05rem; margin: 2.5rem 0 .75rem; padding-bottom: .4rem; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1rem; margin: 0; }
  .muted { color: var(--muted); }
  .err { color: #c0392b; }
  code { background: var(--soft); padding: .1em .35em; border-radius: 4px; font-size: .9em; }
  a { color: inherit; }

  .summary { display: flex; flex-wrap: wrap; gap: 1.5rem; padding: 1rem 1.25rem;
             background: var(--soft); border-radius: 10px; margin-top: 1rem; }
  .summary div { display: flex; flex-direction: column; }
  .summary b { font-size: 1.6rem; font-variant-numeric: tabular-nums; }
  .summary span { color: var(--muted); font-size: .85rem; }

  .cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; }
  .card header { display: flex; align-items: baseline; gap: .6rem; margin-bottom: .5rem; }
  .card p { margin: .4rem 0; }
  .nums { display: flex; gap: 1.25rem; margin-top: .8rem; padding-top: .8rem; border-top: 1px solid var(--line); }
  .nums div { display: flex; flex-direction: column; }
  .nums b { font-size: 1.3rem; font-variant-numeric: tabular-nums; }
  .nums span { color: var(--muted); font-size: .8rem; }

  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px;
           font-size: .78rem; white-space: nowrap; border: 1px solid transparent; }
  .badge.ok   { background: color-mix(in srgb, #2e7d32 16%, Canvas); color: #2e7d32; }
  .badge.warn { background: color-mix(in srgb, #b26a00 16%, Canvas); color: #b26a00; }
  .badge.bad  { background: color-mix(in srgb, #c0392b 16%, Canvas); color: #c0392b; }
  .badge.mute { background: var(--soft); color: var(--muted); }

  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; white-space: nowrap; }
</style>
</head>
<body><div class="wrap">

<header class="top">
  <h1>Панель коннектора Wildberries</h1>
  <span class="muted">${escapeHtml(data.session.email)} · ${escapeHtml(data.session.role)} · <a href="/panel/logout">выйти</a></span>
</header>
<p class="muted">Данные на ${ts(data.generatedAt)}. Страница обновляется сама каждые 2 минуты.</p>

<div class="summary">
  <div><b>${totals.feedbacks}</b><span>отзывов ждут ответа</span></div>
  <div><b>${totals.questions}</b><span>вопросов ждут ответа</span></div>
  <div><b>${totals.chats}</b><span>чатов с покупателями</span></div>
  <div><b>${data.cabinets.length}</b><span>кабинетов подключено</span></div>
  <div><b>${data.drafts.pending}</b><span>черновиков ждут отправки</span></div>
</div>

<h2>Кабинеты и права токенов</h2>
<div class="cards">${data.cabinets.map(cabinetCard).join('')}</div>

<h2>Какие API Wildberries используются</h2>
<div class="scroll"><table>
  <tr><th>Хост</th><th>Категория токена</th><th>Лимит (персональный)</th><th>Что берём</th></tr>
  ${apiRows}
</table></div>
<p class="muted">Лимиты считаются на аккаунт продавца, поэтому у каждого кабинета свои счётчики.</p>

<h2>Кто имеет доступ</h2>
<div class="scroll"><table>
  <tr><th>Почта</th><th>Роль</th><th>Последний вход</th></tr>
  ${userRows || '<tr><td colspan="3" class="muted">Пока никто не подключался</td></tr>'}
</table></div>
<p class="muted">Роль <code>reader</code> может только читать: токен без права <code>wb:write</code>, отправка недоступна.</p>

<h2>Последние действия</h2>
<div class="scroll"><table>
  <tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Кабинет</th><th>Итог</th></tr>
  ${auditRows || '<tr><td colspan="5" class="muted">Записей нет</td></tr>'}
</table></div>

<h2>Подключение</h2>
<p>Адрес MCP для Claude: <code>${escapeHtml(config.resourceUrl.href)}</code></p>
<p class="muted">Вход сотрудников: ${escapeHtml(config.identityProvider)}. Черновиков отправлено: ${data.drafts.sent}, с ошибкой: ${data.drafts.failed}.</p>

</div></body>
</html>`;
}
