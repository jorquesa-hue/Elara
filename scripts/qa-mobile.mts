import { chromium } from 'playwright-core';
import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
mkdirSync('/home/user/Elara/mob-shots',{recursive:true});
const T='t';const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:T,role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Meridian',country:'US'}); B('POST','/demo/seed',{variant:'portfolio'});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
// iPhone-ish viewport
const p=await (await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})).newPage();
const errs:string[]=[]; p.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text()))errs.push(m.text());}); p.on('pageerror',e=>errs.push('PE:'+e.message));
const fail=(m:string)=>{throw new Error(m);};
await p.goto(`http://127.0.0.1:${port}`); await p.evaluate(()=>localStorage.setItem('usos.token','o')); await p.reload();
await p.waitForSelector('.mobilebar',{timeout:20000}); await p.waitForTimeout(700);
// sidebar hidden by default on mobile
const asideVisible = await p.evaluate(()=>{ const a=document.querySelector('aside')!; const r=a.getBoundingClientRect(); return r.left>=0; });
console.log('sidebar on-screen before tap:', asideVisible);
if(asideVisible) fail('sidebar should be off-canvas on mobile');
await p.screenshot({path:'/home/user/Elara/mob-shots/01-home-closed.png',fullPage:true});
// tap hamburger → drawer opens
await p.click('.mobilebar .burger'); await p.waitForTimeout(400);
const open = await p.evaluate(()=>document.body.classList.contains('nav-open'));
const asideNow = await p.evaluate(()=>{ const r=document.querySelector('aside')!.getBoundingClientRect(); return r.left; });
console.log('nav-open:',open,'| aside left:',asideNow);
if(!open || asideNow<0) fail('drawer did not open');
await p.screenshot({path:'/home/user/Elara/mob-shots/02-drawer-open.png',fullPage:true});
// tap a nav item → navigates + closes drawer
await p.click('nav button.item:has-text("Leases")').catch(async()=>{ await p.click('nav button.item'); });
await p.waitForTimeout(600);
const closedAfterNav = await p.evaluate(()=>!document.body.classList.contains('nav-open'));
console.log('drawer closed after nav:',closedAfterNav);
if(!closedAfterNav) fail('drawer should close on navigate');
await p.screenshot({path:'/home/user/Elara/mob-shots/03-after-nav.png',fullPage:true});
// scrim closes too
await p.click('.mobilebar .burger'); await p.waitForTimeout(300);
await p.click('.nav-scrim',{position:{x:350,y:400}}).catch(()=>{});
await p.waitForTimeout(300);
console.log('closed via scrim:', await p.evaluate(()=>!document.body.classList.contains('nav-open')));
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close(); process.exit(errs.length?1:0);
