// Batch-7 QA: the ⌘K palette searches live lease records. Type a resident name
// → the lease shows as a result → Enter opens it in the split-view inspector.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
const T='t';const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:T,role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'M',country:'US'});
B('POST','/demo/seed',{variant:'portfolio'});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const p=await (await b.newContext({viewport:{width:1340,height:900},deviceScaleFactor:2})).newPage();
const errs:string[]=[]; p.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text()))errs.push(m.text());}); p.on('pageerror',e=>errs.push('PE:'+e.message));
const fail=(m:string)=>{throw new Error(m);};
await p.goto(`http://127.0.0.1:${port}`); await p.evaluate(()=>localStorage.setItem('usos.token','o')); await p.reload();
await p.waitForSelector('aside',{timeout:20000}); await p.waitForTimeout(800);
// find a real resident name from the agreements list
const first:any = await p.evaluate(async ()=>{ const r=await fetch('/agreements',{headers:{authorization:'Bearer o'}}); const j=await r.json(); const a=(j.agreements||[]).find((x:any)=>x.residentName); return a?{name:a.residentName,id:a.id}:null; });
console.log('probe resident:', JSON.stringify(first));
if(!first) fail('no resident name in seed');
const term = first.name.split(' ')[0]; // first name
await p.keyboard.press('Control+k'); await p.waitForSelector('.cmdk',{timeout:5000});
await p.fill('.cmdk-in input', term); await p.waitForTimeout(500);
// a record row (tagged with unit/community, not "Action"/workspace) should appear
const rowTexts = await p.locator('.cmdk-row .cr-l').allTextContents();
console.log('palette results for "'+term+'":', JSON.stringify(rowTexts.slice(0,6)));
const hit = rowTexts.some(t=>t.indexOf(first.name)>=0);
if(!hit) fail('resident "'+first.name+'" not found in palette');
await p.screenshot({path:'/home/user/Elara/rs-shots-01.png',fullPage:true});
// click the matching row
await p.locator('.cmdk-row', {hasText:first.name}).first().click();
await p.waitForTimeout(700);
const h1 = await p.locator('main h1').first().textContent();
const iid = await p.locator('.ag-insp .insp-hd .iid').count();
const hdr = await p.locator('.ag-insp .insp-hd h3').textContent().catch(()=>'');
console.log('after pick — view h1:', h1, '| inspector id present:', iid, '| header:', JSON.stringify(hdr));
if(!iid) fail('inspector did not open for the picked record');
await p.screenshot({path:'/home/user/Elara/rs-shots-02.png',fullPage:true});
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close(); process.exit(errs.length?1:0);
