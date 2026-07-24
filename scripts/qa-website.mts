import { chromium } from 'playwright-core'; import { readdirSync, mkdirSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
mkdirSync('/home/user/Elara/web-shots',{recursive:true});
const PX='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'jq',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Harbor Homes',country:'US'});
B('POST','/units',{id:'u1',code:'A1',label:'Harbor Loft 1'});
B('POST','/units',{id:'u2',code:'A2',label:'Harbor Loft 2'});
const content={ heroTitle:'Stay on the Harbor', heroSubtitle:'Design-led homes, book direct — no fees.',
  about:'Six curated waterfront homes steps from the marina.', seoDescription:'Book Harbor Homes direct — live availability & instant pricing.',
  galleryPhotos:[PX,PX,'https://cdn.example.com/hero.jpg',PX,PX,PX],
  highlights:['Rooftop pool','24/7 concierge','Pet friendly','EV charging','In-unit laundry','Secure parking'],
  location:{address:'1200 Harbor Ave, Downtown',neighborhood:'A walkable waterfront district with cafés and transit.',mapsQuery:'Downtown Harbor Ave'},
  policies:[{label:'Check-in',value:'From 3 PM'},{label:'Check-out',value:'By 11 AM'},{label:'Pets',value:'Welcome (2)'}],
  faqs:[{q:'Is parking included?',a:'Yes, one covered space per home.'},{q:'How do I check in?',a:'Smart-lock code by email.'}],
  testimonials:[{quote:'Spotless and the view is unreal!',name:'María G.',location:'Buenos Aires'},{quote:'Seamless check-in.',name:'James P.',location:'London'}],
  units:{ u1:{published:true,headline:'Frontline sunset views',bedrooms:2,bathrooms:2,maxGuests:4,areaSqm:78,amenities:['Wi-Fi','A/C','Balcony','Pool'],photoDataUrl:PX,photos:[PX,PX]},
          u2:{published:true,headline:'Cozy studio',bedrooms:0,bathrooms:1,maxGuests:2,areaSqm:35,amenities:['Wi-Fi','Kitchenette'],photoDataUrl:PX,photos:[PX]} } };
const r=B('PUT','/site-content',{content}); console.log('PUT /site-content status', r.status);
const s=createHttpServer(app); await new Promise<void>(res=>s.listen(0,()=>res())); const port=(s.address() as any).port;

// 1) SEO: the served HTML must carry injected meta + JSON-LD (crawlers/social).
const raw=await (await fetch(`http://127.0.0.1:${port}/site/jq`)).text();
console.log('SEO og:title present:', /property="og:title" content="Stay on the Harbor · Harbor Homes"/.test(raw));
console.log('SEO description present:', /name="description" content="Book Harbor Homes direct/.test(raw));
console.log('SEO og:image (https) present:', /property="og:image" content="https:\/\/cdn.example.com\/hero.jpg"/.test(raw));
console.log('SEO JSON-LD present:', /application\/ld\+json/.test(raw) && /LodgingBusiness/.test(raw));

const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const errs:string[]=[];
const pg=await (await b.newContext({viewport:{width:1180,height:900}})).newPage();
pg.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION_RESET|ERR_ABORTED|Failed to load resource/.test(m.text()))errs.push(m.text());}); pg.on('pageerror',e=>errs.push('PE:'+e.message));
await pg.goto(`http://127.0.0.1:${port}/site/jq`);
await pg.waitForFunction(()=>document.getElementById('brandName')?.textContent!=='Loading…',{timeout:15000});
await pg.waitForTimeout(500);
const vis=(id:string)=>pg.evaluate((i)=>{const e=document.getElementById(i) as any; return !!e && e.style.display!=='none';},id);
console.log('sections →',
  'gallery:',await vis('gallerySec'),'| features:',await vis('featSec'),'| about:',await vis('aboutSec'),
  '| location:',await vis('locSec'),'| good-to-know:',await vis('polSec'),'| faq:',await vis('faqSec'),
  '| reviews:',await vis('revSec'),'| contact:',await vis('contactSec'));
console.log('unit cards:', await pg.evaluate(()=>document.querySelectorAll('#results .card').length));
await pg.screenshot({path:'/home/user/Elara/web-shots/site-full.png',fullPage:true});
// open detail overlay
await pg.evaluate(()=>{ (document.querySelector('#results .card') as any).click(); });
await pg.waitForTimeout(400);
const overlayOn=await pg.evaluate(()=>document.getElementById('detail')?.classList.contains('on'));
const carImgs=await pg.evaluate(()=>document.querySelectorAll('#dCar img, #dCar .nav').length);
console.log('detail overlay open:', overlayOn, '| carousel elements:', carImgs);
await pg.screenshot({path:'/home/user/Elara/web-shots/site-detail.png'});
// lightbox
await pg.evaluate(()=>{ (document.querySelector('#dCar img') as any)?.click(); });
await pg.waitForTimeout(300);
console.log('lightbox open:', await pg.evaluate(()=>document.getElementById('lb')?.classList.contains('on')));
await pg.screenshot({path:'/home/user/Elara/web-shots/site-lightbox.png'});
console.log(errs.length?('ERRORS:'+errs.join('|')):'NO CONSOLE ERRORS');
await b.close(); s.close();
