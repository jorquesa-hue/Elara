import { chromium } from 'playwright-core'; import { readdirSync, writeFileSync } from 'node:fs';
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';const d=readdirSync(r).find(x=>/^chromium-\d/.test(x))!;return `${r}/${d}/chrome-linux/chrome`;}
const b=await chromium.launch({executablePath:fc(),args:['--no-sandbox']});
const pg=await (await b.newContext({viewport:{width:1200,height:760}})).newPage();
await pg.setContent('<canvas id="c" width="1200" height="760"></canvas>');
const CODE = String.raw`(function(){
  var W=1200,H=760,out={};
  var cv=document.getElementById('c'), x=cv.getContext('2d');
  var seed=1; function rnd(){ seed=(seed*16807)%2147483647; return (seed-1)/2147483646; }
  function grain(a){ var im=x.getImageData(0,0,W,H),d=im.data,i; for(i=0;i<d.length;i+=4){ var n=(rnd()-0.5)*a; d[i]+=n; d[i+1]+=n; d[i+2]+=n; } x.putImageData(im,0,0); }
  function vignette(){ var g=x.createRadialGradient(W/2,H*0.55,H*0.2,W/2,H*0.55,H*0.95); g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,.34)'); x.fillStyle=g; x.fillRect(0,0,W,H); }
  function sky(stops){ var g=x.createLinearGradient(0,0,0,H); stops.forEach(function(s){ g.addColorStop(s[0],s[1]); }); x.fillStyle=g; x.fillRect(0,0,W,H); }
  function glow(cx,cy,r,col){ var g=x.createRadialGradient(cx,cy,0,cx,cy,r); g.addColorStop(0,col); g.addColorStop(1,'rgba(0,0,0,0)'); x.fillStyle=g; x.fillRect(0,0,W,H); }
  function towers(baseY,cols,lit,density){ var px=-40; while(px<W+40){ var w=40+rnd()*90, h=120+rnd()*(H-baseY-40)*1.7, top=baseY-h; x.fillStyle=cols[Math.floor(rnd()*cols.length)]; x.fillRect(px,top,w,h+80); for(var wy=top+14; wy<baseY-8; wy+=16){ for(var wx=px+7; wx<px+w-7; wx+=13){ if(rnd()<density){ x.fillStyle=lit; x.globalAlpha=.35+rnd()*.5; x.fillRect(wx,wy,5,7); x.globalAlpha=1; } } } px+=w+8+rnd()*10; } }
  function hills(baseY,col,amp){ x.beginPath(); x.moveTo(0,H); for(var i=0;i<=W;i+=8){ var y=baseY+Math.sin(i*0.008+seed*0.001)*amp - rnd()*6; x.lineTo(i,y); } x.lineTo(W,H); x.closePath(); x.fillStyle=col; x.fill(); }
  function reset(s){ seed=s; x.clearRect(0,0,W,H); }
  reset(7); sky([[0,'#0a1734'],[.5,'#243a66'],[.8,'#7b5a86'],[1,'#c9772f']]); glow(W*0.72,H*0.74,520,'rgba(255,190,120,.55)'); towers(H*0.86,['#0b1428','#111c38','#0e1830'],'#ffd98a',.5); grain(9); vignette(); out.skyline=cv.toDataURL('image/jpeg',0.82);
  reset(21); sky([[0,'#f2c063'],[.42,'#eaa24e'],[.62,'#3f9fb0'],[1,'#1c6f86']]); glow(W*0.5,H*0.4,420,'rgba(255,240,200,.7)'); hills(H*0.62,'#2f8ba0',10); hills(H*0.7,'#20748c',14); grain(7); vignette(); out.coast=cv.toDataURL('image/jpeg',0.82);
  reset(33); sky([[0,'#dfe7d6'],[.5,'#b7c7a6'],[1,'#5c7148']]); glow(W*0.4,H*0.3,460,'rgba(255,255,240,.6)'); hills(H*0.58,'#8aa06f',16); hills(H*0.68,'#5f7a49',20); hills(H*0.8,'#3c5330',24); grain(8); vignette(); out.forest=cv.toDataURL('image/jpeg',0.82);
  reset(45); sky([[0,'#e9e9ea'],[1,'#cfd0d2']]); x.fillStyle='#dedfe1'; x.fillRect(0,H*0.5,W,H*0.5); x.fillStyle='rgba(0,0,0,.06)'; for(var i2=0;i2<6;i2++){ x.fillRect(0,H*0.5+i2*40,W,1);} x.save(); x.translate(W*0.62,H*0.2); x.rotate(0.06); var gg=x.createLinearGradient(0,0,300,600); gg.addColorStop(0,'#f4f4f5'); gg.addColorStop(1,'#c4c5c8'); x.fillStyle=gg; x.fillRect(0,0,360,620); x.fillStyle='rgba(0,0,0,.07)'; for(var wy2=20; wy2<600; wy2+=54){ x.fillRect(14,wy2,332,30);} x.restore(); grain(6); vignette(); out.concrete=cv.toDataURL('image/jpeg',0.82);
  reset(57); sky([[0,'#f3d9a8'],[.45,'#e6a765'],[.7,'#b56a3f'],[1,'#7d4a34']]); glow(W*0.3,H*0.32,480,'rgba(255,235,190,.7)'); hills(H*0.66,'#a9612f',16); hills(H*0.78,'#7d4326',22); grain(9); vignette(); out.desert=cv.toDataURL('image/jpeg',0.82);
  reset(69); sky([[0,'#0c0a0a'],[.6,'#1a1512'],[1,'#332318']]); glow(W*0.78,H*0.7,420,'rgba(214,178,106,.5)'); towers(H*0.9,['#0e0c0b','#171310'],'#e8c684',.45); grain(8); vignette(); out.night=cv.toDataURL('image/jpeg',0.82);
  return out;
})()`;
const scenes:any = await pg.evaluate(CODE);
writeFileSync('/home/user/Elara/scenes.json', JSON.stringify(scenes));
for(const k of Object.keys(scenes)){ writeFileSync(`/home/user/Elara/scene-${k}.jpg`, Buffer.from(scenes[k].split(',')[1],'base64')); }
console.log('scenes:', Object.keys(scenes).join(','), '| kb:', Object.values(scenes).map((u:any)=>Math.round(u.length/1366)).join(','));
await b.close();
