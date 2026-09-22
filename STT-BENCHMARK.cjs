const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('='); if (i < 1) continue;
    const k = s.slice(0,i).trim(); let v=s.slice(i+1).trim();
    if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
    if (!(k in process.env)) process.env[k]=v;
  }
}
loadEnv(path.join(process.cwd(), '.env'));

const debugDir = path.resolve(process.env.REZE_STT_DEBUG_DIR || path.join(process.cwd(), 'stt-debug'));
const count = Math.max(1, Math.min(20, Number(process.argv[2] || 5)));
const exts = new Set(['.webm','.wav','.ogg','.mp3','.m4a','.flac']);
const files = fs.existsSync(debugDir) ? fs.readdirSync(debugDir).filter(f=>exts.has(path.extname(f).toLowerCase())).map(f=>({f,p:path.join(debugDir,f),t:fs.statSync(path.join(debugDir,f)).mtimeMs})).sort((a,b)=>b.t-a.t).slice(0,count) : [];
if (!files.length) { console.error(`Brak nagrań w ${debugDir}`); process.exit(1); }

const prompt = 'Użytkownik mówi po polsku. Wypowiedź jest poleceniem do asystenta komputerowego i może zawierać nazwy własne, tytuły utworów, wykonawców, aplikacje oraz angielskie lub japońskie słowa. Transkrybuj wiernie to, co słychać. Nie tłumacz i nie dopowiadaj.';
const models = [];
if (process.env.GROQ_API_KEY) {
  models.push({provider:'Groq', model:'whisper-large-v3', url:'https://api.groq.com/openai/v1/audio/transcriptions', key:process.env.GROQ_API_KEY});
  models.push({provider:'Groq', model:'whisper-large-v3-turbo', url:'https://api.groq.com/openai/v1/audio/transcriptions', key:process.env.GROQ_API_KEY});
}
if (process.env.OPENAI_API_KEY) {
  models.push({provider:'OpenAI', model:'gpt-4o-transcribe', url:'https://api.openai.com/v1/audio/transcriptions', key:process.env.OPENAI_API_KEY});
  models.push({provider:'OpenAI', model:'gpt-4o-mini-transcribe', url:'https://api.openai.com/v1/audio/transcriptions', key:process.env.OPENAI_API_KEY});
}
if (!models.length) { console.error('Brak GROQ_API_KEY i OPENAI_API_KEY w .env.'); process.exit(1); }

function mimeFor(p){ const e=path.extname(p).toLowerCase(); return ({'.webm':'audio/webm','.wav':'audio/wav','.ogg':'audio/ogg','.mp3':'audio/mpeg','.m4a':'audio/mp4','.flac':'audio/flac'})[e]||'application/octet-stream'; }
async function transcribe(m, file) {
  const buf=fs.readFileSync(file.p); const form=new FormData();
  form.append('model',m.model); form.append('language','pl'); form.append('response_format','json'); form.append('temperature','0'); form.append('prompt',prompt);
  form.append('file',new Blob([buf],{type:mimeFor(file.p)}),file.f);
  const start=Date.now();
  const r=await fetch(m.url,{method:'POST',headers:{Authorization:`Bearer ${m.key}`},body:form});
  const raw=await r.text();
  if(!r.ok) throw new Error(`${r.status}: ${raw.slice(0,300)}`);
  let data; try{data=JSON.parse(raw)}catch{data={text:raw}}
  return {text:String(data.text||'').trim(),ms:Date.now()-start};
}
(async()=>{
  const report={createdAt:new Date().toISOString(),debugDir,files:[],models:models.map(m=>`${m.provider}/${m.model}`)};
  console.log(`\nREZE STT BENCHMARK — ${files.length} nagrań\n`);
  for(const file of files.reverse()){
    const item={file:file.f,results:[]}; console.log(`=== ${file.f} ===`);
    for(const m of models){
      process.stdout.write(`${m.provider}/${m.model}: `);
      try{ const x=await transcribe(m,file); item.results.push({...m,key:undefined,url:undefined,...x}); console.log(`${x.text}  [${x.ms} ms]`); }
      catch(e){ item.results.push({provider:m.provider,model:m.model,error:e.message}); console.log(`BŁĄD: ${e.message}`); }
    }
    report.files.push(item); console.log('');
  }
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const jsonPath=path.join(debugDir,`benchmark-${stamp}.json`); fs.writeFileSync(jsonPath,JSON.stringify(report,null,2));
  let txt=`REZE STT BENCHMARK\n${report.createdAt}\n\n`;
  for(const f of report.files){ txt+=`=== ${f.file} ===\n`; for(const r of f.results) txt+=`${r.provider}/${r.model}: ${r.error?'BŁĄD '+r.error:r.text} ${r.ms?`[${r.ms} ms]`:''}\n`; txt+='\n'; }
  const txtPath=jsonPath.replace(/\.json$/,'.txt'); fs.writeFileSync(txtPath,txt,'utf8');
  console.log(`Raport TXT: ${txtPath}\nRaport JSON: ${jsonPath}`);
  if(!process.env.OPENAI_API_KEY) console.log('\nINFO: Nie znaleziono OPENAI_API_KEY — porównano tylko modele Groq. Dodaj OPENAI_API_KEY do .env, aby dołączyć gpt-4o-transcribe i gpt-4o-mini-transcribe.');
})();
