/** Минимальные HTML-страницы для шагов входа. Никаких внешних ресурсов. */

export function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function shell(title: string, body: string): string {
    return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: Canvas; color: CanvasText; padding: 24px; }
  main { max-width: 30rem; width: 100%; }
  h1 { font-size: 1.35rem; margin: 0 0 .6rem; }
  p { margin: 0 0 1rem; color: color-mix(in srgb, CanvasText 72%, Canvas); }
  code { background: color-mix(in srgb, CanvasText 8%, Canvas); padding: .1em .35em; border-radius: 4px; }
  input { width: 100%; padding: .7rem .8rem; font-size: 1rem; box-sizing: border-box;
          border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); border-radius: 8px;
          background: Canvas; color: CanvasText; }
  button { margin-top: .9rem; width: 100%; padding: .75rem 1rem; font-size: 1rem; font-weight: 600;
           border: 0; border-radius: 8px; background: #3b6cf0; color: #fff; cursor: pointer; }
  .err { color: #c0392b; font-weight: 500; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** Сколько живёт заявка на вход. Форма входа вполне может провисеть дольше. */
export const PENDING_TTL_SECONDS = 30 * 60;

export function errorPage(title: string, detail: string): string {
    return shell(title, `<h1>${escapeHtml(title)}</h1><p class="err">${escapeHtml(detail)}</p>`);
}

export function deniedPage(email: string): string {
    return shell(
        'Доступ не предоставлен',
        `<h1>Доступ не предоставлен</h1>
         <p>Учётная запись <code>${escapeHtml(email)}</code> не входит в список тех, кому разрешён этот коннектор.</p>
         <p>Попросите администратора добавить вас в <code>ALLOWED_EMAILS</code> или войдите с корпоративной почтой.</p>`
    );
}

export function invitePage(pendingId: string, error?: string): string {
    return shell(
        'Вход в коннектор Wildberries',
        `<h1>Вход в коннектор Wildberries</h1>
         <p>Введите одноразовый код, который выдал администратор.</p>
         ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
         <form method="post" action="/idp/invite">
           <input type="hidden" name="pendingId" value="${escapeHtml(pendingId)}">
           <input name="code" autocomplete="one-time-code" autofocus placeholder="Код приглашения" required>
           <button type="submit">Войти</button>
         </form>`
    );
}
