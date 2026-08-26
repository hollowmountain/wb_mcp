/**
 * Выдать сотруднику одноразовый код входа (нужен только при IDENTITY_PROVIDER=invite).
 *   npx tsx scripts/invite.ts ivan@company.ru
 */
import { db, newId, now } from '../src/db/index.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes('@')) {
    console.error('Использование: npx tsx scripts/invite.ts <email>');
    process.exit(1);
}

const code = newId(12);
db.prepare('INSERT INTO invites (code, email, created_at, used_at) VALUES (?, ?, ?, NULL)').run(code, email, now());

console.log(`Код для ${email}: ${code}`);
console.log('Код одноразовый. Передайте его сотруднику по защищённому каналу.');
