import { chromium } from 'playwright-core'; import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
mkdirSync('/home/user/Elara/tabbar-shots',{recursive:true});
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'t',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Meridian',country:'US'}); B('POST','/demo/seed',{variant:'portfolio'});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const errs:string[]=[];
// MOBILE 390
const pm=await (await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})).newPage();
pm.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text()))errs.push(m.text());}); pm.on('pageerror',e=>errs.push('PE:'+e.message));
await pm.goto(`http://127.0.0.1:${port}`); await pm.evaluate(()=>localStorage.setItem('usos.token','o')); await pm.reload();
await pm.waitForSelector('.mobilebar',{timeout:20000}); await pm.waitForTimeout(700);
const bar = await pm.evaluate(()=>{ const n=document.querySelector('.mobiletabs') as any; if(!n) return null; const vis=getComputedStyle(n).display!=='none'; const tabs=[...n.querySelectorAll('.mtab')].map(t=>({label:(t.querySelector('span:last-child')as any)?.textContent, on:t.classList.contains('on')})); return {vis,tabs}; });
console.log('MOBILE tab bar visible:', bar?.vis, '| tabs:', JSON.stringify(bar?.tabs));
await pm.screenshot({path:'/home/user/Elara/tabbar-shots/m-tabbar.png'});
// tap the 2nd tab → view changes
const secondLabel = bar?.tabs?.[1]?.label;
await pm.evaluate(()=>{ (document.querySelectorAll('.mtab')[1] as any).click(); });
await pm.waitForTimeout(500);
const afterTap = await pm.evaluate(()=>{ const on=[...document.querySelectorAll('.mtab')].findIndex(t=>t.classList.contains('on')); return on; });
console.log('MOBILE tapped tab index 1 ('+secondLabel+') → active index now:', afterTap);
await pm.screenshot({path:'/home/user/Elara/tabbar-shots/m-tabbar-tapped.png'});
// tap More → drawer opens
await pm.evaluate(()=>{ const t=[...document.querySelectorAll('.mtab')]; (t[t.length-1] as any).click(); });
await pm.waitForTimeout(400);
const drawerOpen = await pm.evaluate(()=>document.body.classList.contains('nav-open'));
console.log('MOBILE More → drawer open:', drawerOpen);
await pm.screenshot({path:'/home/user/Elara/tabbar-shots/m-more-drawer.png'});
// DESKTOP hidden
const pd=await (await b.newContext({viewport:{width:1300,height:850}})).newPage();
pd.on('console',m=>{if(m.type()==='error')errs.push('D:'+m.text());}); pd.on('pageerror',e=>errs.push('DPE:'+e.message));
await pd.goto(`http://127.0.0.1:${port}`); await pd.evaluate(()=>localStorage.setItem('usos.token','o')); await pd.reload();
await pd.waitForSelector('aside',{timeout:15000}); await pd.waitForTimeout(400);
const deskHidden = await pd.evaluate(()=>{ const n=document.querySelector('.mobiletabs') as any; return !n || getComputedStyle(n).display==='none'; });
console.log('DESKTOP tab bar hidden (want true):', deskHidden);
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close();
