import { chromium } from 'playwright-core'; import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
mkdirSync('/home/user/Elara/tpl-shots',{recursive:true});
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'jq',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Belmont Residences',country:'US'});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const errs:string[]=[];
const pg=await (await b.newContext({viewport:{width:1240,height:900},deviceScaleFactor:1})).newPage();
pg.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED|Failed to load resource|fonts.g/.test(m.text()))errs.push(m.text());}); pg.on('pageerror',e=>errs.push('PE:'+e.message));
const check=async(tpl:string)=>{
  await pg.goto(`http://127.0.0.1:${port}/site/jq?template=${tpl}&demo=1`);
  await pg.waitForFunction(()=>document.getElementById('brandName')?.textContent!=='Loading…',{timeout:15000});
  await pg.waitForTimeout(500);
  const info=await pg.evaluate(()=>{
    const b=document.body; const cs=getComputedStyle(document.getElementById('heroTitle')||b);
    return { hero:b.getAttribute('data-hero'), cards:b.getAttribute('data-cards'),
      headingFont:cs.fontFamily, bg:getComputedStyle(b).backgroundColor,
      units:document.querySelectorAll('#results .card').length, hasDirectory:!!document.querySelector('#commBody .card') };
  });
  console.log(tpl.padEnd(12), '| hero='+info.hero, '| cards='+info.cards, '| units='+info.units, '| heading='+String(info.headingFont).slice(0,28));
  await pg.screenshot({path:`/home/user/Elara/tpl-shots/${tpl}.png`});
  return info;
};
for(const t of ['belmont','sablewood','saltair','maison','highline','onyx']) await check(t);
// preview must show CONTENT (units), not a bare directory
const bel=await check('belmont');
console.log('preview shows units (not directory):', bel.units>0 && !bel.hasDirectory);
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close();
