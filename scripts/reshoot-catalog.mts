import { chromium } from 'playwright-core'; import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { App, StaticTokenAuthenticator, ConfigStore, RoleRegistry, MasterData, createHttpServer } from '../src/index.ts';
import { templateGallery } from '../src/site-templates.ts';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
const S=JSON.parse(readFileSync('/home/user/Elara/scenes.json','utf8')); // {skyline,coast,forest,concrete,desert,night}
function L(hex:string){ const n=parseInt(hex.slice(1),16); const r=(n>>16)&255,g=(n>>8)&255,b=n&255; return (0.299*r+0.587*g+0.114*b)/255; }
function hue(hex:string){ const n=parseInt(hex.slice(1),16); let r=((n>>16)&255)/255,g=((n>>8)&255)/255,b=(n&255)/255; const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn; let h=0; if(d){ if(mx===r)h=((g-b)/d)%6; else if(mx===g)h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if(h<0)h+=360; } const s=mx===0?0:d/mx; return {h,s}; }
function pickScene(bg:string,accent:string){ const lum=L(bg); const {h,s}=hue(accent);
  if(h>=80&&h<=165&&s>0.12) return S.forest;
  if(h>=10&&h<=45&&s>0.25) return lum<0.3?S.night:S.desert;
  if(h>165&&h<=200) return S.coast;
  if(lum<0.28) return (h>=35&&h<=62)?S.night:S.skyline;
  if(h>=38&&h<=62&&s>0.2) return S.desert;
  if(h>=200&&h<=265) return lum<0.32?S.skyline:S.coast;
  return S.concrete; }
const auth=new StaticTokenAuthenticator({o:{actor:'a',tenantId:'jq',role:'owner'}});
const app=new App({authenticator:auth,config:new ConfigStore(),roles:new RoleRegistry(),masterData:new MasterData()});
const B=(m:string,p:string,b?:any)=>app.dispatch({method:m,path:p,bearer:'Bearer o',body:b??{}});
B('PUT','/config',{displayName:'Aria Residences',country:'US'});
B('POST','/unit-types',{code:'ONE',name:'One Bedroom',bedrooms:1,bathrooms:1,maxGuests:2,areaSqm:52,baseRentCents:240000,description:'A light one-bedroom with a private balcony and open kitchen.'});
B('POST','/unit-types',{code:'TWO',name:'Two Bedroom',bedrooms:2,bathrooms:2,maxGuests:4,areaSqm:82,baseRentCents:335000,description:'A corner two-bedroom, two-bath home with skyline views.'});
B('POST','/unit-types',{code:'PH',name:'Penthouse',bedrooms:3,bathrooms:2,maxGuests:6,areaSqm:120,baseRentCents:520000,description:'A top-floor penthouse with a wraparound terrace.'});
B('POST','/units',{id:'u1',code:'0501',label:'Residence 0501',typeId:'utype-one'});
B('POST','/units',{id:'u2',code:'1204',label:'Residence 1204',typeId:'utype-two'});
B('POST','/units',{id:'u3',code:'2100',label:'The Penthouse',typeId:'utype-ph'});
const content:any={ heroTitle:'Live at Aria', heroSubtitle:'Design-led residences with skyline views — book direct, no fees.',
  about:'A collection of light-filled homes in the heart of the city, moments from the water, parks and transit.',
  contactEmail:'stay@aria.example', galleryPhotos:[S.skyline,S.coast,S.forest,S.concrete,S.desert,S.night],
  highlights:['Rooftop pool & terrace','24/7 concierge','Pet friendly','In-unit laundry','Secure parking','EV charging','Fitness center','Fibre Wi-Fi'],
  location:{address:'1200 Harbor Avenue, Downtown',neighborhood:'A walkable waterfront district — cafés, parks and transit at your doorstep.',mapsQuery:'Downtown Harbor Avenue'},
  policies:[{label:'Check-in',value:'From 3:00 PM'},{label:'Check-out',value:'By 11:00 AM'},{label:'Pets',value:'Welcome (2 max)'},{label:'Parking',value:'1 secure space'}],
  faqs:[{q:'Is parking included?',a:'Yes — one secure covered space per home, with EV charging.'},{q:'How do I check in?',a:'A smart-lock code arrives by email the morning of arrival.'}],
  testimonials:[{quote:'Beautifully finished and the rooftop view is unreal. Booking direct saved us a bundle.',name:'María G.',location:'Buenos Aires'},{quote:'Seamless self check-in and the location could not be better.',name:'James P.',location:'London'},{quote:'Felt like a boutique hotel, priced like a rental.',name:'Sofia R.',location:'Lisbon'}],
  units:{ u1:{published:true,headline:'Balcony one-bedroom',amenities:['Balcony','Wi-Fi','A/C','Dishwasher'],photoDataUrl:S.forest,photos:[S.coast,S.concrete]},
          u2:{published:true,headline:'Corner two-bedroom, skyline views',amenities:['2 baths','Skyline view','Wi-Fi','Laundry'],photoDataUrl:S.skyline,photos:[S.night,S.desert]},
          u3:{published:true,headline:'Penthouse with wraparound terrace',amenities:['Terrace','3 bed','Wi-Fi','Concierge'],photoDataUrl:S.coast,photos:[S.forest,S.skyline]} } };
const s=createHttpServer(app); await new Promise<void>(r=>s.listen(0,()=>r())); const port=(s.address() as any).port;
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const pg=await (await b.newContext({viewport:{width:1100,height:720},deviceScaleFactor:1})).newPage();
const gallery=templateGallery();
const shots:Record<string,string>={};
for(const t of gallery){
  content.heroPhotoDataUrl=pickScene(t.swatch[0], t.swatch[2]);
  B('PUT','/site-content',{content});
  await pg.goto(`http://127.0.0.1:${port}/site/jq?template=${t.id}`);
  await pg.waitForFunction(()=>document.getElementById('brandName')?.textContent!=='Loading…',{timeout:15000}).catch(()=>{});
  await pg.waitForTimeout(650);
  await pg.evaluate(()=>{ document.querySelectorAll('div').forEach(d=>{ if(/Design preview:/.test(d.textContent||'')&&(d as HTMLElement).style.position==='fixed')(d as HTMLElement).style.display='none'; }); });
  const buf=await pg.screenshot({type:'jpeg',quality:72,clip:{x:0,y:0,width:1100,height:720}});
  shots[t.id]='data:image/jpeg;base64,'+buf.toString('base64');
  process.stdout.write('.');
}
console.log(' done');
writeFileSync('/home/user/Elara/scratchpad-catalog.json', JSON.stringify({ gallery, shots }));
await b.close(); s.close();
