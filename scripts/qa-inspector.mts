// Batch-6 QA: the agreements list is a split view — click a row → a sticky
// inspector shows the lease detail beside the list. Deep-link full detail still
// works. Fails on any console/page error.
import { chromium } from 'playwright-core';
import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function findChrome(){ const root=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers'; const d=readdirSync(root).find(x=>/^chromium-\d/.test(x))!; return `${root}/${d}/chrome-linux/chrome`; }
mkdirSync('/home/user/Elara/insp-shots',{recursive:true});
const T='t-demo';
const auth=new StaticTokenAuthenticator({'owner-demo':{actor:'ana@demo',tenantId:T,role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer owner-demo',body:b??{}});
B('PUT','/config',{displayName:'Meridian',country:'US'});
B('POST','/demo/seed',{variant:'portfolio'});
const server=createHttpServer(app); await new Promise<void>(r=>server.listen(0,()=>r()));
const port=(server.address() as any).port; const base=`http://127.0.0.1:${port}`;
const b=await chromium.launch({executablePath:findChrome(),args:['--no-sandbox']});
const p=await (await b.newContext({viewport:{width:1360,height:1000},deviceScaleFactor:2})).newPage();
const errs:string[]=[]; p.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text()))errs.push(m.text());}); p.on('pageerror',e=>errs.push('PE:'+e.message));
const shot=async(n:string)=>{await p.waitForTimeout(200);await p.screenshot({path:`/home/user/Elara/insp-shots/${n}.png`,fullPage:true});console.log('shot',n);};
const fail=(m:string)=>{throw new Error(m);};
await p.goto(base); await p.evaluate(()=>localStorage.setItem('usos.token','owner-demo')); await p.reload();
await p.waitForSelector('aside',{timeout:20000}); await p.waitForTimeout(800);
// go to a workspace that has leases, via palette
await p.keyboard.press('Control+k'); await p.waitForSelector('.cmdk',{timeout:5000});
await p.fill('.cmdk-in input','leases'); await p.waitForTimeout(200); await p.keyboard.press('Enter');
await p.waitForTimeout(900);
// split present?
if(!(await p.locator('.ag-split').count())) fail('no split view');
if(!(await p.locator('.ag-insp .insp-empty').count())) fail('no empty inspector');
await shot('01-split-empty');
// click first row → inspector populates
await p.click('.ag-list tbody tr'); await p.waitForTimeout(500);
const iid=await p.locator('.ag-insp .insp-hd .iid').count();
if(!iid) fail('inspector did not populate on row click');
const cells=await p.locator('.ag-insp .insp-cell').count();
console.log('inspector cells:',cells);
if(cells<6) fail('inspector missing cells');
const sel=await p.locator('.ag-list tbody tr.sel').count();
console.log('selected rows:',sel);
if(sel!==1) fail('row not marked selected');
await shot('02-split-selected');
// open full detail
await p.click('.ag-insp .insp-act .btn.primary'); await p.waitForTimeout(600);
const bh=await p.evaluate(()=>location.hash);
console.log('after open-full hash:',bh);
await shot('03-full-detail');
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); server.close(); process.exit(errs.length?1:0);
