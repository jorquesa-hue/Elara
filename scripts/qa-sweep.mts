import { chromium } from 'playwright-core';
import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
mkdirSync('/home/user/Elara/sweep-shots',{recursive:true});
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'t',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Meridian',country:'US'}); B('POST','/demo/seed',{variant:'portfolio'});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const p=await (await b.newContext({viewport:{width:1440,height:900},deviceScaleFactor:2})).newPage();
const errs:string[]=[]; p.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text()))errs.push(m.text());}); p.on('pageerror',e=>errs.push('PE:'+e.message));
const shot=async(n:string)=>{await p.waitForTimeout(300);await p.screenshot({path:`/home/user/Elara/sweep-shots/${n}.png`,fullPage:true});console.log('shot',n);};
async function palette(term:string){ await p.keyboard.press('Control+k'); await p.waitForSelector('.cmdk'); await p.fill('.cmdk-in input',term); await p.waitForTimeout(250); await p.keyboard.press('Enter'); await p.waitForTimeout(700); }
await p.goto(`http://127.0.0.1:${port}`); await p.evaluate(()=>localStorage.setItem('usos.token','o')); await p.reload();
await p.waitForSelector('aside',{timeout:20000}); await p.waitForTimeout(800);
// switch to operator lens for a rich home
await p.click('.wsswitch summary'); await p.waitForTimeout(150); await p.click('.wsswitch .wopt:has-text("Property operator")'); await p.waitForTimeout(900);
await shot('01-operator-home');
await palette('leases'); await p.click('.ag-list tbody tr'); await p.waitForTimeout(400); await shot('02-agreements-inspector');
await palette('bills'); await shot('03-bills');
await palette('reports'); await p.waitForTimeout(500); await shot('04-reports');
await palette('pipeline'); await shot('05-pipeline');
await palette('revenue'); await shot('06-revenue');
await palette('users'); await shot('07-users');
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close();
