/**
 * Изменить доступ человеку, который уже подключился.
 *
 * `invite.ts` заводит нового; этот скрипт правит существующего, не заставляя
 * его переподключать коннектор. Сервер работает без сессий — на каждый запрос
 * актор собирается заново, — поэтому новые области видны уже в следующем чате.
 *
 *   npx tsx scripts/grant.ts ivan@company.ru --areas inbox,catalog,ads
 *   npx tsx scripts/grant.ts anna@company.ru --profile manager
 *   npx tsx scripts/grant.ts petr@company.ru --add ads
 *   npx tsx scripts/grant.ts petr@company.ru --remove money
 *   npx tsx scripts/grant.ts ivan@company.ru --cabinets oz-harbez,oz-pixeltap
 *   npx tsx scripts/grant.ts ivan@company.ru            — показать, что есть сейчас
 *
 * Ничего не меняющий вызов только печатает текущее состояние: прежде чем
 * править права, полезно увидеть, что у человека было.
 *
 * Сужение прав скрипт выполняет, но называет вслух: молча отобранный
 * инструмент читается как поломка, и человек идёт выяснять, что сломалось.
 */
import { AREAS, DEFAULT_AREAS, PROFILES, isArea, type Area } from '../src/areas.js';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';

interface UserRow {
    email: string;
    cabinets: string | null;
    areas: string | null;
}

const args = process.argv.slice(2);

/** Вынимает `--flag значение` из списка аргументов. */
function takeFlag(name: string): string | undefined {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
}

function parseAreaList(raw: string, flag: string): Area[] {
    const parts = raw
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    const bad = parts.filter(s => !isArea(s));
    if (bad.length > 0) {
        console.error(`${flag}: неизвестные области — ${bad.join(', ')}. Доступны: ${AREAS.join(', ')}`);
        process.exit(1);
    }
    return parts as Area[];
}

const profileArg = takeFlag('--profile');
const areasArg = takeFlag('--areas');
const addArg = takeFlag('--add');
const removeArg = takeFlag('--remove');
const cabinetsArg = takeFlag('--cabinets');

const email = args[0]?.trim().toLowerCase();
if (!email || !email.includes('@')) {
    console.error('Использование: npx tsx scripts/grant.ts <email> [--areas ... | --profile ... | --add ... | --remove ...] [--cabinets ...]');
    process.exit(1);
}

const user = db.prepare('SELECT email, cabinets, areas FROM users WHERE email = ?').get(email) as UserRow | undefined;
if (!user) {
    console.error(`Пользователь ${email} не найден: он ещё ни разу не входил.`);
    console.error('Новому человеку выдайте код: npx tsx scripts/invite.ts ' + email);
    process.exit(1);
}

const before: Area[] = user.areas
    ? (user.areas.split(',').filter(isArea) as Area[])
    : [...DEFAULT_AREAS];
const beforeCabinets = user.cabinets;

// Ничего не просили менять — просто показываем, что есть.
if (!profileArg && !areasArg && !addArg && !removeArg && cabinetsArg === undefined) {
    console.log(`${email}`);
    console.log(`Кабинеты: ${beforeCabinets ?? 'все'}`);
    console.log(`Области: ${before.join(', ')}${user.areas ? '' : ' (набор по умолчанию, явно не назначались)'}`);
    process.exit(0);
}

let after: Area[] = [...before];

if (profileArg !== undefined) {
    const preset = PROFILES[profileArg];
    if (!preset) {
        console.error(`Неизвестный профиль «${profileArg}». Доступны: ${Object.keys(PROFILES).join(', ')}`);
        process.exit(1);
    }
    after = [...preset.areas];
}
if (areasArg !== undefined) after = parseAreaList(areasArg, '--areas');
if (addArg !== undefined) after = [...new Set([...after, ...parseAreaList(addArg, '--add')])];
if (removeArg !== undefined) {
    const drop = new Set(parseAreaList(removeArg, '--remove'));
    after = after.filter(a => !drop.has(a));
}

if (after.includes('reply') && !after.includes('inbox')) {
    console.error('Область reply без inbox бессмысленна: отвечать не на что. Добавьте inbox.');
    process.exit(1);
}
if (after.length === 0) {
    console.error('Пустой список областей закрыл бы человеку всё. Если это и нужно — снимайте доступ целиком, а не так.');
    process.exit(1);
}

let cabinets = beforeCabinets;
if (cabinetsArg !== undefined) {
    const scope = cabinetsArg
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    const ozonSlugs = new Set(config.ozon.map(c => c.slug));
    const unknown = scope.filter(s => !config.cabinets.has(s) && !ozonSlugs.has(s));
    if (unknown.length > 0) {
        const choices = [config.cabinets.describeChoices(), [...ozonSlugs].join(', ')].filter(Boolean).join(', ');
        console.error(`Неизвестные кабинеты: ${unknown.join(', ')}`);
        console.error(`Доступны: ${choices}`);
        process.exit(1);
    }
    cabinets = scope.length > 0 ? scope.join(',') : null;
}

db.prepare('UPDATE users SET areas = ?, cabinets = ? WHERE email = ?').run(after.join(','), cabinets, email);

const gained = after.filter(a => !before.includes(a));
const lost = before.filter(a => !after.includes(a));

console.log(`${email}`);
if (cabinets !== beforeCabinets) {
    console.log(`Кабинеты: ${beforeCabinets ?? 'все'} -> ${cabinets ?? 'все'}`);
} else {
    console.log(`Кабинеты: ${cabinets ?? 'все'} (без изменений)`);
}
console.log(`Области: ${before.join(', ')}`);
console.log(`      -> ${after.join(', ')}`);
if (gained.length > 0) console.log(`Добавлено: ${gained.join(', ')}`);
if (lost.length > 0) {
    console.log(`УБРАНО: ${lost.join(', ')}`);
    console.log('Человек потеряет эти инструменты в следующем же чате. Предупредите его — иначе это выглядит как поломка.');
}
if (gained.length === 0 && lost.length === 0 && cabinets === beforeCabinets) {
    console.log('Ничего не изменилось.');
}
console.log('Переподключать коннектор не нужно: сервер собирает права на каждый запрос.');
