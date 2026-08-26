/**
 * Разбирает пачку токенов Wildberries и говорит, какой к какому кабинету
 * относится и что им можно делать. Сами токены никуда не выводятся.
 *
 *   npx tsx scripts/inspect-tokens.ts tokens.txt
 *   npx tsx scripts/inspect-tokens.ts tokens.txt --env
 *
 * Формат файла — по одному токену в строке, пустые строки и строки с # игнорируются.
 * Можно подписать: `main = eyJhbGci...`
 */
import { readFileSync } from 'node:fs';
import { CATEGORY_NAMES, daysLeft, parseToken, TokenParseError, type CategoryKey, type TokenInfo } from '../src/wb/token.js';

const KIND_LABEL: Record<string, string> = {
    personal: 'персональный',
    basic: 'базовый',
    test: 'тестовый',
    service: 'сервисный',
    unknown: 'неизвестный'
};

const REQUIRED: CategoryKey[] = ['feedbacks', 'chat'];

interface Entry {
    name: string | null;
    info: TokenInfo;
    token: string;
}

const [, , file, ...flags] = process.argv;
if (!file) {
    console.error('Использование: npx tsx scripts/inspect-tokens.ts <файл> [--env]');
    process.exit(1);
}

const lines = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

const entries: Entry[] = [];
const failures: string[] = [];

for (const [index, line] of lines.entries()) {
    const match = /^([A-Za-z0-9_-]{1,24})\s*=\s*(.+)$/.exec(line);
    const name = match ? match[1]!.toLowerCase() : null;
    const token = (match ? match[2]! : line).trim();
    try {
        entries.push({ name, info: parseToken(token), token });
    } catch (e) {
        failures.push(`строка ${index + 1}: ${e instanceof TokenParseError ? e.message : String(e)}`);
    }
}

if (entries.length === 0) {
    console.error('Ни одного токена разобрать не удалось.');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
}

// ─── Отчёт ───────────────────────────────────────────────────────────────────

console.log(`Разобрано токенов: ${entries.length}\n`);

const bySeller = new Map<string, Entry[]>();

entries.forEach((entry, index) => {
    const { info } = entry;
    const label = entry.name ?? `токен ${index + 1}`;
    const days = daysLeft(info);
    const seller = info.sellerId ?? 'неизвестен';

    const list = bySeller.get(seller) ?? [];
    list.push(entry);
    bySeller.set(seller, list);

    const cats = [...info.categories].map(c => CATEGORY_NAMES[c]);
    const missing = REQUIRED.filter(c => !info.categories.has(c));

    console.log(`▸ ${label}`);
    console.log(`   тип:        ${KIND_LABEL[info.kind] ?? info.kind}`);
    console.log(`   продавец:   ${seller}`);
    console.log(`   доступ:     ${info.readOnly ? 'ТОЛЬКО ЧТЕНИЕ' : 'чтение и запись'}`);
    console.log(
        `   истекает:   ${info.expiresAt ? info.expiresAt.toISOString().slice(0, 10) : '?'}` +
            (days === null ? '' : ` (осталось ${days} дн.)`)
    );
    console.log(`   категорий:  ${cats.length} — ${cats.join(', ') || 'нет'}`);

    const verdict: string[] = [];
    if (missing.length > 0) verdict.push(`НЕ хватает категорий: ${missing.map(c => CATEGORY_NAMES[c]).join(', ')}`);
    if (info.readOnly) verdict.push('нельзя отвечать покупателям');
    if (info.kind === 'basic') verdict.push('базовый: лимиты 5 запросов в час — непригоден');
    if (days !== null && days < 14) verdict.push(`скоро истекает`);
    if (cats.length > REQUIRED.length + 1) verdict.push(`шире необходимого: достаточно двух категорий`);

    console.log(`   ${verdict.length === 0 ? '✓ ГОДИТСЯ для коннектора' : '✗ ' + verdict.join('; ')}`);
    console.log();
});

// ─── Кабинеты ────────────────────────────────────────────────────────────────

console.log(`Разных кабинетов (по ID продавца): ${bySeller.size}`);
for (const [seller, list] of bySeller) {
    const names = list.map((e, i) => e.name ?? `токен ${i + 1}`).join(', ');
    console.log(`  ${seller}: ${names}${list.length > 1 ? '  ← несколько токенов на один кабинет' : ''}`);
}

if (failures.length > 0) {
    console.log('\nНе разобрано:');
    for (const f of failures) console.log('  ' + f);
}

// ─── Готовые строки для .env ─────────────────────────────────────────────────

if (flags.includes('--env')) {
    const good = entries.filter(e => !e.info.readOnly && REQUIRED.every(c => e.info.categories.has(c)));
    if (good.length === 0) {
        console.log('\nПригодных токенов нет — строки для .env не генерирую.');
    } else {
        const slugs = good.map((e, i) => e.name ?? `cab${i + 1}`);
        console.log('\n─── вставьте в /opt/mcp-wb/.env ───');
        console.log(`WB_CABINETS=${slugs.join(',')}`);
        good.forEach((entry, i) => {
            const slug = slugs[i]!.toUpperCase().replaceAll('-', '_');
            console.log(`WB_LABEL_${slug}=${slugs[i]}`);
            console.log(`WB_TOKEN_${slug}=${entry.token}`);
        });
        console.log('───────────────────────────────────');
        console.log('(токены выведены только здесь, в вашем терминале)');
    }
}
