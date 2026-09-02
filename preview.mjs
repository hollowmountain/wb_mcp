process.env.PUBLIC_URL ||= 'https://mcpwb.harbez.com/';
process.env.SESSION_SECRET ||= 'x'.repeat(40);
process.env.IDENTITY_PROVIDER ||= 'invite';
process.env.WB_CABINETS ||= '';
process.env.WB_TOKEN ||= '';
import { readFileSync, writeFileSync } from 'node:fs';
const tk = JSON.parse(readFileSync(new URL('./mocktokens.json', import.meta.url), 'utf8'));
process.env.WB_CABINETS = 'beauty,harbez,pixeltap';
for (const s of ['BEAUTY','HARBEZ','PIXELTAP']) {
  process.env['WB_TOKEN_' + s] = tk.write;
  process.env['WB_DATA_TOKEN_' + s] = tk.data;
  process.env['WB_LABEL_' + s] = { BEAUTY:'Your Beauty', HARBEZ:'HARBEZ', PIXELTAP:'PixelTap' }[s];
}
const { config } = await import('./dist/src/config.js');
const { renderPanel } = await import('./dist/src/panel/render.js');
const cab = (slug) => config.cabinets.resolve(slug);
const now = Math.floor(Date.now()/1000);
const html = renderPanel({
  session: { email: 'tartaria4545@gmail.com', role: 'admin', cabinets: null },
  isAdmin: true,
  generatedAt: now,
  cabinets: [
    { cabinet: cab('beauty'),  seller: { name:'ООО "КРАСОТА"', tradeMark:'Your Beauty', tin:'2311215683', sid:'1' }, error:null, counts:{feedbacksUnanswered:9,feedbacksToday:2,questionsUnanswered:1,questionsToday:0,chats:300} },
    { cabinet: cab('harbez'),  seller: { name:'ИП Арасланов А. Г.', tradeMark:'HARBEZ', tin:'744403658154', sid:'2' }, error:null, counts:{feedbacksUnanswered:13,feedbacksToday:3,questionsUnanswered:1,questionsToday:0,chats:206} },
    { cabinet: cab('pixeltap'),seller: { name:'ИП Арасланова З. Г.', tradeMark:'PixelTap', tin:'744402248532', sid:'3' }, error:null, counts:{feedbacksUnanswered:0,feedbacksToday:0,questionsUnanswered:1,questionsToday:0,chats:288} }
  ],
  ozon: [
    { slug:'beauty',  company:'Pixeltap',   legalName:'ООО "КРАСОТА"', subscriptionType:'PREMIUM', isPremium:true, access:{reviews:false,questions:false,chats:true}, error:null },
    { slug:'harbez',  company:'HARBEZ',     legalName:'Арасланов Альберт Гильмуллович', subscriptionType:'PREMIUM', isPremium:true, access:{reviews:false,questions:false,chats:true}, error:null },
    { slug:'pixeltap',company:'Pixeltapic', legalName:'Арасланова Зульфия Гильмулловна', subscriptionType:'PREMIUM', isPremium:true, access:{reviews:false,questions:false,chats:true}, error:null }
  ],
  users: [
    { email:'tartaria4545@gmail.com', name:null, last_seen:now-120, role:'admin', scope:'все' },
    { email:'wb-beauty@harbez.com', name:null, last_seen:now-8000, role:'responder', scope:'beauty,pixeltap' },
    { email:'wb-harbez@harbez.com', name:null, last_seen:now-400, role:'responder', scope:'harbez' }
  ],
  audit: [
    { ts:now-100, cabinet:null, actor:'tartaria4545@gmail.com', action:'panel.login', target:null, outcome:'ok' },
    { ts:now-900, cabinet:'harbez', actor:'wb-harbez@harbez.com', action:'draft.send.feedback', target:'x', outcome:'ok' },
    { ts:now-1800, cabinet:'beauty', actor:'wb-beauty@harbez.com', action:'draft.create.question', target:'y', outcome:'ok' }
  ],
  drafts: { pending:38, sent:42, failed:0 },
  draftsByCabinet: [ {cabinet:'pixeltap',pending:17}, {cabinet:'beauty',pending:11}, {cabinet:'harbez',pending:9}, {cabinet:'main',pending:1} ]
});
writeFileSync(new URL('./panel-preview.html', import.meta.url), html);
console.log('  готово, размер:', html.length, 'символов');
