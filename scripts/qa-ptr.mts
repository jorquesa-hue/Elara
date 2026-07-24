import { chromium } from 'playwright-core'; import { readdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'t',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Meridian',country:'US'}); B('POST','/demo/seed',{variant:'portfolio'});
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
// pull sequence dispatched as synthetic touch events
const pull = `(function(){
  function mk(y){ return new Touch({identifier:1,target:document.body,clientX:120,clientY:y}); }
  function ev(type,y){ var e=new TouchEvent(type,{cancelable:true,bubbles:true,touches:type==='touchend'?[]:[mk(y)],changedTouches:[mk(y)],targetTouches:type==='touchend'?[]:[mk(y)]}); document.dispatchEvent(e); }
  window.scrollTo(0,0);
  ev('touchstart',20); ev('touchmove',60); ev('touchmove',130); ev('touchend',130);
  return !!document.querySelector('.ptr.spin');
})()`;
// MOBILE
const pm=await (await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})).newPage();
const errs:string[]=[]; pm.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED/.test(m.text()))errs.push(m.text());}); pm.on('pageerror',e=>errs.push('PE:'+e.message));
await pm.goto(`http://127.0.0.1:${port}`); await pm.evaluate(()=>localStorage.setItem('usos.token','o')); await pm.reload();
await pm.waitForSelector('.mobilebar',{timeout:20000}); await pm.waitForTimeout(700);
const spinning = await pm.evaluate(pull);
console.log('MOBILE pull → spinner active:', spinning);
await pm.waitForTimeout(300);
await pm.screenshot({path:'/home/user/Elara/msweep/m-ptr.png'});
await pm.waitForTimeout(600);
console.log('MOBILE indicator cleared after refresh:', await pm.evaluate(()=>{const p=document.querySelector('.ptr') as any; return p? p.style.opacity==='0'||!p.classList.contains('spin') : true;}));
// DESKTOP no-op
const pd=await (await b.newContext({viewport:{width:1300,height:850}})).newPage();
await pd.goto(`http://127.0.0.1:${port}`); await pd.evaluate(()=>localStorage.setItem('usos.token','o')); await pd.reload();
await pd.waitForSelector('aside',{timeout:15000}); await pd.waitForTimeout(400);
const deskSpin = await pd.evaluate(pull);
console.log('DESKTOP pull → spinner active (want false):', deskSpin);
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close();
