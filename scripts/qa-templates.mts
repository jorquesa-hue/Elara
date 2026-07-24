import { chromium } from 'playwright-core'; import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
mkdirSync('/home/user/Elara/tpl-shots',{recursive:true});
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'jq',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
app.dispatch({method:'PUT',path:'/config',bearer:'Bearer o',body:{displayName:'Belmont Residences',country:'US'}});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const errs:string[]=[];
const pg=await (await b.newContext({viewport:{width:1240,height:900}})).newPage();
pg.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED|Failed to load resource|fonts.g/.test(m.text()))errs.push(m.text());}); pg.on('pageerror',e=>errs.push('PE:'+e.message));
// one representative template per feel
const set=[['belmont','editorial'],['noir','boutique'],['horizon','resort'],['archer','minimal'],['bluecorp','corporate'],['onyx','minimal'],['maison','boutique'],['highline','editorial']];
for(const [tpl,feel] of set){
  await pg.goto(`http://127.0.0.1:${port}/site/jq?template=${tpl}&demo=1`);
  await pg.waitForFunction(()=>document.getElementById('brandName')?.textContent!=='Loading…',{timeout:15000});
  await pg.waitForTimeout(550);
  const info=await pg.evaluate(()=>({ feel:document.body.getAttribute('data-feel'), hero:document.body.getAttribute('data-hero'), units:document.querySelectorAll('#results .card').length }));
  console.log((tpl+' ('+feel+')').padEnd(24),'→ data-feel='+info.feel,'| hero='+info.hero,'| units='+info.units,'| feelMatch='+(info.feel===feel));
  await pg.screenshot({path:`/home/user/Elara/tpl-shots/${tpl}.png`,fullPage:true});
}
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close();
