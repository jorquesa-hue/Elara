import { chromium } from 'playwright-core'; import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
mkdirSync('/home/user/Elara/web-shots',{recursive:true});
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'jq',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Harbor Homes',country:'US'});
B('POST','/units',{id:'u1',code:'A1',label:'Harbor Loft 1'});
B('POST','/units',{id:'u2',code:'A2',label:'Harbor Loft 2'});
const s=createHttpServer(app); await new Promise<void>(res=>s.listen(0,()=>res())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const errs:string[]=[];
const pg=await (await b.newContext({viewport:{width:1280,height:1000}})).newPage();
pg.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED|Failed to load resource/.test(m.text()))errs.push(m.text());}); pg.on('pageerror',e=>errs.push('PE:'+e.message));
await pg.goto(`http://127.0.0.1:${port}`); await pg.evaluate(()=>localStorage.setItem('usos.token','o')); await pg.reload();
await pg.waitForSelector('aside',{timeout:15000});
// jump straight to the website view via the hash router
await pg.goto(`http://127.0.0.1:${port}/#/commercial/website`);
await pg.waitForFunction("(document.getElementById('main')||{}).innerHTML && document.getElementById('main').innerHTML.includes('Sections')",undefined,{timeout:20000});
const has=(t:string)=>pg.evaluate("document.getElementById('main').innerHTML.includes("+JSON.stringify(t)+")");
console.log('editor sections →','Sections:',await has('Sections'),'| Photo gallery:',await has('Photo gallery'),
  '| Location:',await has('Location'),'| Good to know:',await has('Good to know'),
  '| FAQ:',await has('Frequently asked questions'),'| Reviews:',await has('Guest reviews'),'| Gallery photos (unit):',await has('Gallery photos'));
// add a FAQ row via the "+ Add question" button
await pg.evaluate(()=>{ const btns=[...document.querySelectorAll('button')]; const add=btns.find(b=>/Add question/.test(b.textContent||'')); (add as any)?.click(); });
await pg.waitForTimeout(200);
const faqInputs=await pg.evaluate(()=>document.querySelectorAll('textarea,input').length);
console.log('added a FAQ row, total form fields:', faqInputs);
await pg.screenshot({path:'/home/user/Elara/web-shots/editor.png',fullPage:true});
// Save
await pg.evaluate(()=>{ const btns=[...document.querySelectorAll('button')]; const save=btns.find(b=>/Save website/.test(b.textContent||'')); (save as any)?.click(); });
await pg.waitForTimeout(600);
console.log('save toast:', await pg.evaluate(()=>document.body.innerText.includes('Website saved')));
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close();
