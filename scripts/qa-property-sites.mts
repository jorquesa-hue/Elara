import { chromium } from 'playwright-core'; import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
mkdirSync('/home/user/Elara/web-shots',{recursive:true});
const PX='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'jq',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Harbor Homes',country:'US'});
B('POST','/properties',{code:'CURRAL',name:'Praia do Curral'});
B('POST','/properties',{code:'VILA',name:'Vila & Pereque'});
B('POST','/units',{id:'c1',code:'C1',label:'Curral Loft 1',propertyId:'prop-curral'});
B('POST','/units',{id:'c2',code:'C2',label:'Curral Loft 2',propertyId:'prop-curral'});
B('POST','/units',{id:'v1',code:'V1',label:'Vila House 1',propertyId:'prop-vila'});
// per-property site content: distinct hero + a unit photo, and a custom domain
B('PUT','/site-content',{content:{heroTitle:'Harbor — all communities'}});
B('PUT','/site-content',{propertyId:'prop-curral',content:{heroTitle:'Praia do Curral — beachfront',heroSubtitle:'Just for Curral',domain:'stay.curral.com',highlights:['Beach access','Pool'],units:{c1:{published:true,headline:'Sunset loft',bedrooms:2,photoDataUrl:PX}}}});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;

// 1) per-property public page: SEO + only that property's units
const raw=await (await fetch(`http://127.0.0.1:${port}/site/jq/p/CURRAL`)).text();
console.log('per-property SEO title:', /og:title" content="Praia do Curral — beachfront/.test(raw));
console.log('per-property __ELARA_SITE property:', /__ELARA_SITE=\{"tenant":"jq","property":"CURRAL"\}/.test(raw));

const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const errs:string[]=[];
const pg=await (await b.newContext({viewport:{width:1180,height:900}})).newPage();
pg.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED|Failed to load resource/.test(m.text()))errs.push(m.text());}); pg.on('pageerror',e=>errs.push('PE:'+e.message));
// property site
await pg.goto(`http://127.0.0.1:${port}/site/jq/p/CURRAL`);
await pg.waitForFunction(()=>document.getElementById('brandName')?.textContent!=='Loading…',{timeout:15000});
await pg.waitForTimeout(400);
console.log('CURRAL hero:', await pg.evaluate(()=>document.getElementById('heroTitle')?.textContent));
console.log('CURRAL unit cards (want 2):', await pg.evaluate(()=>document.querySelectorAll('#results .card').length));
await pg.screenshot({path:'/home/user/Elara/web-shots/prop-curral.png'});
// portfolio site
await pg.goto(`http://127.0.0.1:${port}/site/jq`);
await pg.waitForFunction(()=>document.getElementById('brandName')?.textContent!=='Loading…',{timeout:15000});
await pg.waitForTimeout(300);
console.log('PORTFOLIO hero:', await pg.evaluate(()=>document.getElementById('heroTitle')?.textContent));
console.log('PORTFOLIO unit cards (want 3):', await pg.evaluate(()=>document.querySelectorAll('#results .card').length));

// 2) editor scope switch
await pg.goto(`http://127.0.0.1:${port}`); await pg.evaluate("localStorage.setItem('usos.token','o')"); await pg.reload();
await pg.waitForSelector('aside',{timeout:15000});
await pg.goto(`http://127.0.0.1:${port}/#/commercial/website`);
await pg.waitForFunction("(document.getElementById('main')||{}).innerHTML && document.getElementById('main').innerHTML.includes('Which site are you building')",undefined,{timeout:20000});
// select the Curral property in the scope dropdown
await pg.evaluate(`(function(){ var p=[...document.querySelectorAll('#main .panel')].find(x=>/Which site are you building/.test(x.textContent)); var sel=p.querySelector('select'); var opt=[...sel.options].find(o=>/Praia do Curral/.test(o.textContent)); sel.value=opt.value; sel.dispatchEvent(new Event('change')); })()`);
await pg.waitForFunction("document.getElementById('main').innerHTML.includes('Editing: Praia do Curral site')",undefined,{timeout:15000});
const link=await pg.evaluate(`(document.querySelector('#main input[readonly]')||{}).value`);
console.log('editor scoped link:', link);
console.log('editor shows /p/CURRAL:', String(link).includes('/site/jq/p/CURRAL'));
console.log('editor custom-domain prefilled:', await pg.evaluate(`[...document.querySelectorAll('#main input')].some(i=>i.value==='stay.curral.com')`));
await pg.screenshot({path:'/home/user/Elara/web-shots/prop-editor.png',fullPage:true});
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close();
