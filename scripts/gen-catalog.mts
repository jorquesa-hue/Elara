import { chromium } from 'playwright-core'; import { readdirSync, writeFileSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
import { templateGallery } from '../src/site-templates.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'jq',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
app.dispatch({method:'PUT',path:'/config',bearer:'Bearer o',body:{displayName:'Aria Residences',country:'US'}});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const pg=await (await b.newContext({viewport:{width:1100,height:720},deviceScaleFactor:1})).newPage();
const gallery=templateGallery();
const shots:Record<string,string>={};
for(const t of gallery){
  await pg.goto(`http://127.0.0.1:${port}/site/jq?template=${t.id}&demo=1`);
  await pg.waitForFunction(()=>document.getElementById('brandName')?.textContent!=='Loading…',{timeout:15000}).catch(()=>{});
  await pg.evaluate(()=>{ const r=document.querySelector('div[style*="position:fixed"]'); }); // noop
  await pg.waitForTimeout(600);
  // hide the preview ribbon so the thumbnail is clean
  await pg.evaluate(()=>{ document.querySelectorAll('div').forEach(d=>{ if(/Design preview:/.test(d.textContent||'')&&(d as HTMLElement).style.position==='fixed')(d as HTMLElement).style.display='none'; }); });
  const buf=await pg.screenshot({type:'jpeg',quality:70,clip:{x:0,y:0,width:1100,height:720}});
  shots[t.id]='data:image/jpeg;base64,'+buf.toString('base64');
  process.stdout.write('.');
}
console.log(' shots done');
writeFileSync('/home/user/Elara/scratchpad-catalog.json', JSON.stringify({ gallery, shots }));
await b.close(); s.close();
