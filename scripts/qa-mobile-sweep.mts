import { chromium } from 'playwright-core';
import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
mkdirSync('/home/user/Elara/msweep',{recursive:true});
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'t',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Meridian',country:'US'}); B('POST','/demo/seed',{variant:'portfolio'});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
// iPhone 12/13 viewport
const p=await (await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})).newPage();
const errs:string[]=[]; p.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text()))errs.push(m.text());}); p.on('pageerror',e=>errs.push('PE:'+e.message));
const shot=async(n:string)=>{await p.waitForTimeout(300);await p.screenshot({path:`/home/user/Elara/msweep/${n}.png`,fullPage:true});console.log('shot',n);};
async function nav(term:string){ await p.click('.mobilebar .burger'); await p.waitForTimeout(300); const it=p.locator('nav button.item',{hasText:term}).first(); if(await it.count()){await it.click();} else {await p.click('.nav-scrim',{position:{x:360,y:400}}).catch(()=>{});} await p.waitForTimeout(700); }
// check horizontal overflow: is document wider than viewport?
async function overflow(){ return await p.evaluate(()=> document.documentElement.scrollWidth - document.documentElement.clientWidth); }
await p.goto(`http://127.0.0.1:${port}`); await p.evaluate(()=>localStorage.setItem('usos.token','o')); await p.reload();
await p.waitForSelector('.mobilebar',{timeout:20000}); await p.waitForTimeout(700);
await shot('01-home'); console.log('home overflow px:', await overflow());
await nav('Leases'); await p.waitForTimeout(400); await shot('02-leases'); console.log('leases overflow px:', await overflow());
// tap a lease row → inspector stacks below
await p.click('.ag-list tbody tr').catch(()=>{}); await p.waitForTimeout(400); await shot('03-leases-inspector');
await nav('Reports'); await p.waitForTimeout(500); await shot('04-reports'); console.log('reports overflow px:', await overflow());
await nav('Pipeline'); await shot('05-pipeline'); console.log('pipeline overflow px:', await overflow());
// finance workspace via switcher
await p.click('.mobilebar .burger'); await p.waitForTimeout(300); await p.click('.wsswitch summary').catch(()=>{}); await p.waitForTimeout(200); await p.click('.wsswitch .wopt:has-text("Finance")').catch(()=>{}); await p.waitForTimeout(700);
await shot('06-finance-home'); 
await nav('Bills'); await shot('07-bills'); console.log('bills overflow px:', await overflow());
// open a pay dialog on mobile
const pay=p.locator('button:has-text("Pay outstanding")').first(); if(await pay.count()){ await pay.click(); await p.waitForTimeout(400); await shot('08-pay-dialog'); await p.keyboard.press('Escape'); }
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close();
