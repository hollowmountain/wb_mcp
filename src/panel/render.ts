import { escapeHtml } from '../auth/pages.js';
import { config } from '../config.js';
import type { Cabinet } from '../wb/cabinets.js';
import { CATEGORY_NAMES, daysLeft, type TokenInfo } from '../wb/token.js';
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

export interface OzonStatus {
    slug: string;
    company: string | null;
    legalName: string | null;
    subscriptionType: string | null;
    isPremium: boolean;
    access: { reviews: boolean; questions: boolean; chats: boolean } | null;
    error: string | null;
}

export interface PanelData {
    session: PanelSession;
    cabinets: CabinetStatus[];
    users: Array<{ email: string; name: string | null; last_seen: number; role: string; scope: string; areas: string }>;
    audit: Array<{ ts: number; cabinet: string | null; actor: string; action: string; target: string | null; outcome: string }>;
    drafts: { pending: number; sent: number; failed: number };
    draftsByCabinet: Array<{ cabinet: string; pending: number }>;
    ozon: OzonStatus[];
    /** Администратор видит организацию целиком, остальные — только своё. */
    isAdmin: boolean;
    generatedAt: number;
}

const ts = (seconds: number): string => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Лимиты и назначение каждого API WB, который использует сервер. */
const API_TABLE: Array<{ host: string; category: string; token: string; limit: string; used: string }> = [
    {
        host: 'feedbacks-api.wildberries.ru',
        category: 'Вопросы и отзывы',
        token: 'ответов',
        limit: '3 запроса/сек, всплеск 6',
        used: 'отзывы, вопросы, ответы на них'
    },
    {
        host: 'buyer-chat-api.wildberries.ru',
        category: 'Чат с покупателями',
        token: 'ответов',
        limit: '10 запросов/10 сек',
        used: 'список чатов, лента событий, отправка сообщений'
    },
    {
        host: 'common-api.wildberries.ru',
        category: 'любая',
        token: 'ответов',
        limit: '10 запросов/10 сек',
        used: 'информация о продавце'
    },
    {
        host: 'returns-api.wildberries.ru',
        category: 'Возвраты покупателями',
        token: 'данных',
        limit: '20 запросов/мин',
        used: 'заявки покупателей на возврат'
    },
    {
        host: 'content-api.wildberries.ru',
        category: 'Контент',
        token: 'данных',
        limit: 'сдержанно, точный лимит WB не публикует',
        used: 'карточки товаров, характеристики, размеры'
    },
    {
        host: 'discounts-prices-api.wildberries.ru',
        category: 'Цены и скидки',
        token: 'данных',
        limit: 'сдержанно, точный лимит WB не публикует',
        used: 'цены, скидки, артикул по номенклатуре'
    },
    {
        host: 'marketplace-api.wildberries.ru',
        category: 'Маркетплейс',
        token: 'данных',
        limit: 'сдержанно, точный лимит WB не публикует',
        used: 'сборочные задания FBS, склады'
    },
    {
        host: 'seller-analytics-api.wildberries.ru',
        category: 'Аналитика',
        token: 'данных',
        limit: '10 запросов/мин',
        used: 'остатки по складам, продажи по географии'
    },
    {
        host: 'statistics-api.wildberries.ru',
        category: 'Статистика',
        token: 'данных',
        limit: '1 запрос в 5 минут — так отвечает сам WB',
        used: 'заказы и продажи по датам, отчёт о реализации'
    },
    {
        host: 'supplies-api.wildberries.ru',
        category: 'Поставки',
        token: 'данных',
        limit: 'сдержанно, точный лимит WB не публикует',
        used: 'поставки FBW'
    },
    {
        host: 'finance-api.wildberries.ru',
        category: 'Финансы',
        token: 'данных',
        limit: 'сдержанно, точный лимит WB не публикует',
        used: 'баланс продавца'
    }
];

/** Что коннектор умеет — списком, для тех, кто его не настраивал. */
const TOOLS: Array<{ name: string; what: string; writes: boolean }> = [
    { name: 'Сводка обращений', what: 'сколько отзывов и вопросов ждут ответа, сколько открытых чатов', writes: false },
    { name: 'Отзывы и вопросы', what: 'списки, поиск по номеру, архив, непросмотренные', writes: false },
    { name: 'Чаты с покупателями', what: 'список чатов и лента сообщений', writes: false },
    { name: 'Карточка товара', what: 'характеристики, состав, размеры, штрихкоды, габариты, цена со скидкой', writes: false },
    { name: 'Остатки на складах', what: 'сколько лежит на каждом складе WB, отдельно — что едет покупателям', writes: false },
    { name: 'Заказы FBS', what: 'сборочные задания со склада продавца', writes: false },
    { name: 'Заявки на возврат', what: 'что возвращают, почему, на какую сумму', writes: false },
    { name: 'Продажи по географии', what: 'страны, округа, регионы, города — суммы, штуки, доли', writes: false },
    { name: 'Ответ покупателю', what: 'готовит черновик; отправка — отдельным подтверждением человека', writes: true }
];

/**
 * Человеческие названия действий. Заодно видно, какие из них вообще
 * не привязаны к кабинету: вход авторизует человека целиком.
 */
const ACTION_LABELS: Record<string, string> = {
    'oauth.login': 'вход в коннектор',
    'oauth.token.issued': 'выдан доступ',
    'panel.login': 'вход в панель',
    'draft.create.feedback': 'черновик ответа на отзыв',
    'draft.create.feedback_edit': 'черновик правки ответа',
    'draft.create.question': 'черновик ответа на вопрос',
    'draft.create.chat': 'черновик сообщения в чат',
    'draft.send.feedback': 'ОТПРАВЛЕН ответ на отзыв',
    'draft.send.feedback_edit': 'ОТПРАВЛЕНА правка ответа',
    'draft.send.question': 'ОТПРАВЛЕН ответ на вопрос',
    'draft.send.chat': 'ОТПРАВЛЕНО сообщение в чат',
    'draft.discard': 'черновик отменён',
    'question.reject': 'вопрос отклонён',
    'question.viewed': 'вопрос отмечен просмотренным'
};

/** Действия, которые по своей природе не относятся к кабинету. */
const CABINET_AGNOSTIC = new Set(['oauth.login', 'oauth.token.issued', 'panel.login']);

function actionCell(action: string): string {
    const label = ACTION_LABELS[action];
    return label ? escapeHtml(label) : `<code>${escapeHtml(action)}</code>`;
}

function cabinetCell(action: string, cabinet: string | null): string {
    if (cabinet) return escapeHtml(cabinet);
    if (CABINET_AGNOSTIC.has(action)) return '<span class="muted">не относится</span>';
    return '<span class="muted">—</span>';
}

function badge(text: string, tone: 'ok' | 'warn' | 'bad' | 'mute'): string {
    return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function tokenLine(title: string, info: TokenInfo | null, problems: string[]): string {
    if (!info) {
        return `<p class="muted">${escapeHtml(title)}: не задан</p>`;
    }
    const left = daysLeft(info);
    const rights = info.readOnly ? badge('только чтение', 'ok') : badge('чтение и запись', 'warn');
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
    return `<div class="tok">
      <div class="tok-h">${escapeHtml(title)}</div>
      <p>${kind} ${rights} ${expiry}</p>
      <p class="muted small">${escapeHtml(cats.join(', ') || 'категорий нет')}</p>
      ${problems.length > 0 ? `<p class="err small">${escapeHtml(problems.join('; '))}</p>` : ''}
    </div>`;
}

function cabinetCard(status: CabinetStatus): string {
    const { cabinet, seller, counts, error } = status;

    // У токена ответов «чтение и запись» — норма, у токена данных — наоборот
    // повод насторожиться. Поэтому цвета у них разные, см. tokenLine.
    const answers = tokenLine('Токен ответов', cabinet.info, cabinet.problems);
    const dataTok = cabinet.dataInfo
        ? tokenLine('Токен данных', cabinet.dataInfo, cabinet.dataProblems)
        : `<div class="tok"><div class="tok-h">Токен данных</div><p class="muted small">Не задан — товары, остатки, заказы и возвраты по этому кабинету недоступны.</p></div>`;

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
  ${seller ? `<p class="muted small">${escapeHtml(seller.name)} · бренд ${escapeHtml(seller.tradeMark)} · ИНН ${escapeHtml(seller.tin)}</p>` : ''}
  <div class="toks">${answers}${dataTok}</div>
  ${numbers}
</article>`;
}

function ozonCard(o: OzonStatus): string {
    if (o.error) {
        return `<article class="card">
      <header><h3>${escapeHtml(o.slug)}</h3><code>ozon</code></header>
      <p class="err">${escapeHtml(o.error)}</p>
    </article>`;
    }

    const premium = o.isPremium
        ? badge(o.subscriptionType === 'PREMIUM' ? 'Premium' : `Premium ${escapeHtml(o.subscriptionType ?? '')}`, 'ok')
        : badge('без Premium', 'warn');

    const line = (label: string, ok: boolean, need: string): string =>
        `<li>${ok ? badge('доступно', 'ok') : badge('закрыто', 'warn')} ${escapeHtml(label)}${ok ? '' : ` <span class="muted small">— нужен ${escapeHtml(need)}</span>`}</li>`;

    const access = o.access
        ? `<ul class="plain">
        ${line('Отзывы', o.access.reviews, '«Управление отзывами» или Premium Pro')}
        ${line('Вопросы', o.access.questions, 'Premium Plus')}
        ${line('Чаты — чтение', o.access.chats, 'ничего')}
      </ul>`
        : '<p class="muted small">Доступ не проверялся</p>';

    return `<article class="card">
  <header><h3>${escapeHtml(o.company ?? o.slug)}</h3><code>${escapeHtml(o.slug)}</code></header>
  ${o.legalName ? `<p class="muted small">${escapeHtml(o.legalName)}</p>` : ''}
  <p>${premium}</p>
  ${access}
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
        r => `<tr><td data-l="Хост"><code>${escapeHtml(r.host)}</code></td>
              <td data-l="Категория">${escapeHtml(r.category)}</td>
              <td data-l="Токен">${escapeHtml(r.token)}</td>
              <td data-l="Лимит">${escapeHtml(r.limit)}</td>
              <td data-l="Что берём" class="muted">${escapeHtml(r.used)}</td></tr>`
    ).join('');

    const toolRows = TOOLS.map(
        x => `<tr><td data-l="Возможность">${escapeHtml(x.name)}</td>
              <td data-l="Что даёт" class="muted">${escapeHtml(x.what)}</td>
              <td data-l="Меняет">${x.writes ? badge('с подтверждением', 'warn') : badge('только чтение', 'ok')}</td></tr>`
    ).join('');

    const userRows = data.users
        .map(
            u => `<tr><td data-l="Почта">${escapeHtml(u.email)}</td>
                  <td data-l="Кабинеты">${escapeHtml(u.scope)}</td>
                  <td data-l="Области">${escapeHtml(u.areas)}</td>
                  <td data-l="Последний вход" class="muted">${ts(u.last_seen)}</td></tr>`
        )
        .join('');

    const auditRows = data.audit
        .map(
            a => `<tr><td data-l="Когда" class="muted">${ts(a.ts)}</td>
                  <td data-l="Кто">${escapeHtml(a.actor)}</td>
                  <td data-l="Действие">${actionCell(a.action)}</td>
                  <td data-l="Кабинет">${cabinetCell(a.action, a.cabinet)}</td>
                  <td data-l="Итог">${a.outcome === 'ok' ? badge('ok', 'ok') : a.outcome === 'denied' ? badge('отказ', 'warn') : badge('ошибка', 'bad')}</td></tr>`
        )
        .join('');

    const queue = data.draftsByCabinet.length
        ? `<div class="summary tight">${data.draftsByCabinet
              .map(d => `<div><b>${d.pending}</b><span>${escapeHtml(d.cabinet)}</span></div>`)
              .join('')}</div>`
        : '<p class="muted">Очередь пуста.</p>';

    return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="refresh" content="120">
<meta name="color-scheme" content="light dark">
<title>Панель коннектора</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, CanvasText 14%, Canvas);
          --muted: color-mix(in srgb, CanvasText 60%, Canvas);
          --soft: color-mix(in srgb, CanvasText 5%, Canvas); }
  * { box-sizing: border-box; }
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         margin: 0; background: Canvas; color: CanvasText; -webkit-text-size-adjust: 100%; }
  .wrap { max-width: 68rem; margin: 0 auto;
          padding: 1.5rem max(1rem, env(safe-area-inset-left)) 4rem; }
  header.top { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: baseline;
               justify-content: space-between; margin-bottom: .35rem; }
  h1 { font-size: 1.3rem; margin: 0; }
  h2 { font-size: 1.05rem; margin: 2.25rem 0 .75rem; padding-bottom: .4rem; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1rem; margin: 0; }
  .muted { color: var(--muted); }
  .small { font-size: .85rem; }
  .err { color: #c0392b; }
  code { background: var(--soft); padding: .1em .35em; border-radius: 4px;
         font-size: .88em; overflow-wrap: anywhere; }
  a { color: inherit; }
  ul.plain { list-style: none; padding: 0; margin: .5rem 0 0; }
  ul.plain li { margin: .3rem 0; }

  .summary { display: grid; gap: .75rem 1.25rem; padding: 1rem;
             grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
             background: var(--soft); border-radius: 10px; margin-top: 1rem; }
  .summary.tight { grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr)); }
  .summary div { display: flex; flex-direction: column; }
  .summary b { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
  .summary span { color: var(--muted); font-size: .82rem; }

  .cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 1rem; }
  .card header { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; margin-bottom: .4rem; }
  .card p { margin: .35rem 0; }
  .toks { display: grid; gap: .6rem; margin-top: .7rem; }
  .tok { border: 1px solid var(--line); border-radius: 8px; padding: .55rem .7rem; }
  .tok-h { font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
  .nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem;
          margin-top: .8rem; padding-top: .8rem; border-top: 1px solid var(--line); }
  .nums div { display: flex; flex-direction: column; }
  .nums b { font-size: 1.25rem; font-variant-numeric: tabular-nums; }
  .nums span { color: var(--muted); font-size: .78rem; }

  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px;
           font-size: .78rem; white-space: nowrap; border: 1px solid transparent; }
  .badge.ok   { background: color-mix(in srgb, #2e7d32 16%, Canvas); color: #2e7d32; }
  .badge.warn { background: color-mix(in srgb, #b26a00 16%, Canvas); color: #b26a00; }
  .badge.bad  { background: color-mix(in srgb, #c0392b 16%, Canvas); color: #c0392b; }
  .badge.mute { background: var(--soft); color: var(--muted); }

  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; white-space: nowrap; }

  /* На телефоне таблицы разворачиваются в карточки: горизонтальная прокрутка
     на узком экране означает, что половину данных никто не увидит. */
  @media (max-width: 46rem) {
    .wrap { padding-top: 1rem; }
    h1 { font-size: 1.15rem; }
    thead, th { display: none; }
    table, tbody, tr, td { display: block; width: 100%; }
    tr { border: 1px solid var(--line); border-radius: 10px; padding: .35rem .1rem; margin-bottom: .6rem; }
    td { border: 0; padding: .3rem .7rem; display: grid; grid-template-columns: 8.5rem 1fr; gap: .5rem; }
    td::before { content: attr(data-l); color: var(--muted); font-size: .82rem; }
    td[colspan] { grid-template-columns: 1fr; }
    td[colspan]::before { content: none; }
    .nums { grid-template-columns: repeat(3, 1fr); }
  }
</style>
</head>
<body><div class="wrap">

<header class="top">
  <h1>Панель коннектора</h1>
  <span class="muted small">${escapeHtml(data.session.email)} · ${escapeHtml(data.session.role)} · <a href="/panel/logout">выйти</a></span>
</header>
<p class="muted small">Данные на ${ts(data.generatedAt)}. Страница обновляется сама каждые 2 минуты.</p>

<div class="summary">
  <div><b>${totals.feedbacks}</b><span>отзывов ждут ответа</span></div>
  <div><b>${totals.questions}</b><span>вопросов ждут ответа</span></div>
  <div><b>${totals.chats}</b><span>чатов с покупателями</span></div>
  <div><b>${data.cabinets.length}</b><span>кабинетов WB</span></div>
  <div><b>${data.drafts.pending}</b><span>черновиков ждут отправки</span></div>
  <div><b>${data.drafts.sent}</b><span>ответов отправлено всего</span></div>
</div>

<h2>Что умеет коннектор</h2>
<div class="scroll"><table>
  <thead><tr><th>Возможность</th><th>Что даёт</th><th>Меняет ли что-то</th></tr></thead>
  <tbody>${toolRows}</tbody>
</table></div>
<p class="muted small">Ответ покупателю всегда проходит через черновик: модель готовит текст, человек читает и подтверждает. Сама она ничего не отправляет.</p>

<h2>Кабинеты Wildberries</h2>
<div class="cards">${data.cabinets.map(cabinetCard).join('')}</div>
<p class="muted small">Токенов два намеренно. Узкий умеет отвечать, но видит только отзывы и чаты. Широкий видит товары, заказы и остатки, но ничего не может изменить.</p>

${
    data.ozon.length > 0
        ? `<h2>Кабинеты Ozon</h2>
<div class="cards">${data.ozon.map(ozonCard).join('')}</div>
<p class="muted small">Ключи выпущены с ролью «только чтение». Отзывы и вопросы Ozon отдаёт лишь по платной подписке — что именно закрыто, видно на карточке.</p>`
        : ''
}

<h2>Очередь черновиков</h2>
${queue}
<p class="muted small">Черновик ждёт человека: пока никто не подтвердил, покупателю ничего не ушло.</p>

<h2>Какие API используются</h2>
<div class="scroll"><table>
  <thead><tr><th>Хост</th><th>Категория</th><th>Токен</th><th>Лимит</th><th>Что берём</th></tr></thead>
  <tbody>${apiRows}</tbody>
</table></div>
<p class="muted small">Лимиты считаются на аккаунт продавца, поэтому у каждого кабинета свои счётчики.</p>

<h2>${data.isAdmin ? 'Кто имеет доступ' : 'Ваш доступ'}</h2>
<div class="scroll"><table>
  <thead><tr><th>Почта</th><th>Кабинеты</th><th>Что видит</th><th>Последний вход</th></tr></thead>
  <tbody>${userRows || '<tr><td colspan="4" class="muted">Пока никто не подключался</td></tr>'}</tbody>
</table></div>
<p class="muted small">Доступ складывается из двух осей: <b>кабинеты</b> — где, <b>области</b> — что. Отвечать покупателям может только тот, у кого есть область <code>reply</code>.${data.isAdmin ? '' : ' Показан только ваш доступ.'}</p>

<h2>${data.isAdmin ? 'Последние действия' : 'Ваши последние действия'}</h2>
<div class="scroll"><table>
  <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Кабинет</th><th>Итог</th></tr></thead>
  <tbody>${auditRows || '<tr><td colspan="5" class="muted">Записей нет</td></tr>'}</tbody>
</table></div>
<p class="muted small">Вход в коннектор и в панель авторизует человека целиком, поэтому кабинет у таких записей не указывается.</p>

<h2>Подключение</h2>
<p class="small">Адрес для Claude: <code>${escapeHtml(config.resourceUrl.href)}</code></p>
<p class="muted small">Вход сотрудников: ${escapeHtml(config.identityProvider)}. Черновиков с ошибкой: ${data.drafts.failed}.</p>

</div></body>
</html>`;
}
