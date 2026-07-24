import { readFileSync, writeFileSync } from 'node:fs';
const { gallery, shots } = JSON.parse(readFileSync('/home/user/Elara/scratchpad-catalog.json','utf8')) as any;
const LIVE='https://elarapms.com/site/jq';
const FEELS:[string,string,string][]=[
  ['editorial','Editorial','Magazine-grade layouts — oversized display type, accent overlines, quiet structure. For flagship communities and luxury listings.'],
  ['boutique','Boutique','Hushed hospitality: centered headings with fine rules and restrained accents. For design-led stays and boutique portfolios.'],
  ['resort','Resort','Warm and photo-led, with rounded cards and generous space. For vacation rentals and lifestyle properties.'],
  ['minimal','Minimal','Architectural restraint — whitespace, hairlines and uppercase micro-labels. For contemporary, design-forward inventory.'],
  ['corporate','Corporate','Clean and trustworthy with clear hierarchy. For furnished-housing and multi-property operators.'],
];
const esc=(x:string)=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function card(t:any){
  const href=`${LIVE}?template=${encodeURIComponent(t.id)}&demo=1`;
  return `<a class="card" href="${href}" target="_blank" rel="noopener">
    <div class="thumb"><img loading="lazy" src="${shots[t.id]}" alt="${esc(t.name)} template preview"/></div>
    <div class="meta">
      <div class="row"><h3>${esc(t.name)}</h3><span class="live">Preview ↗</span></div>
      <p class="desc">${esc(t.description)}</p>
      <p class="insp">Inspired by ${esc(t.inspiration)}</p>
    </div>
  </a>`;
}
const sections=FEELS.map(([key,label,blurb])=>{
  const items=gallery.filter((t:any)=>t.feel===key);
  if(!items.length) return '';
  return `<section class="feel">
    <header class="feelhead">
      <div class="eyebrow">${esc(label)} <span class="count">${items.length}</span></div>
      <p class="blurb">${esc(blurb)}</p>
    </header>
    <div class="grid">${items.map(card).join('')}</div>
  </section>`;
}).join('');

const html=`<style>
  :root{
    --bg:#f4f5fb; --surface:#ffffff; --ink:#151829; --muted:#5a6280; --line:#e3e6f1;
    --accent:#5468f2; --accent2:#8a6bff; --chip:#edf0fe; --shadow:0 1px 2px rgba(20,26,54,.05),0 14px 30px rgba(20,26,54,.07);
  }
  @media (prefers-color-scheme:dark){ :root{ --bg:#0c0e15; --surface:#151824; --ink:#eef0f8; --muted:#98a0ba; --line:#242838; --chip:#1b2036; --accent:#7b8cff; --accent2:#a488ff; --shadow:0 1px 2px rgba(0,0,0,.4),0 18px 40px rgba(0,0,0,.4); } }
  :root[data-theme="dark"]{ --bg:#0c0e15; --surface:#151824; --ink:#eef0f8; --muted:#98a0ba; --line:#242838; --chip:#1b2036; --accent:#7b8cff; --accent2:#a488ff; --shadow:0 1px 2px rgba(0,0,0,.4),0 18px 40px rgba(0,0,0,.4); }
  :root[data-theme="light"]{ --bg:#f4f5fb; --surface:#ffffff; --ink:#151829; --muted:#5a6280; --line:#e3e6f1; --accent:#5468f2; --accent2:#8a6bff; --chip:#edf0fe; --shadow:0 1px 2px rgba(20,26,54,.05),0 14px 30px rgba(20,26,54,.07); }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; font-variant-numeric:tabular-nums; }
  .wrap{ max-width:1200px; margin:0 auto; padding:clamp(28px,5vw,64px) clamp(18px,4vw,40px) 80px; }
  header.top{ display:flex; flex-direction:column; gap:14px; padding-bottom:26px; border-bottom:1px solid var(--line); }
  .brand{ display:flex; align-items:center; gap:11px; font-weight:700; letter-spacing:-.01em; }
  .mark{ width:30px; height:30px; border-radius:8px; background:linear-gradient(135deg,var(--accent),var(--accent2)); flex:none; }
  h1{ font-size:clamp(28px,4.4vw,44px); line-height:1.08; letter-spacing:-.025em; margin:6px 0 0; text-wrap:balance; max-width:20ch; }
  .lede{ color:var(--muted); font-size:clamp(15px,1.6vw,18px); max-width:64ch; margin:0; }
  .stat{ display:inline-flex; align-items:center; gap:8px; font-size:13px; color:var(--muted); font-weight:600; }
  .dot{ width:6px; height:6px; border-radius:99px; background:var(--accent); }
  .feel{ margin-top:clamp(40px,6vw,64px); }
  .feelhead{ display:flex; flex-direction:column; gap:6px; margin-bottom:20px; padding-left:2px; border-left:3px solid var(--accent); padding-left:14px; }
  .eyebrow{ text-transform:uppercase; letter-spacing:.16em; font-size:12.5px; font-weight:700; color:var(--ink); display:flex; align-items:center; gap:10px; }
  .eyebrow .count{ letter-spacing:0; font-size:11px; color:var(--muted); background:var(--chip); border-radius:99px; padding:2px 9px; }
  .blurb{ color:var(--muted); font-size:14.5px; margin:0; max-width:70ch; }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:20px; }
  .card{ display:flex; flex-direction:column; background:var(--surface); border:1px solid var(--line); border-radius:16px; overflow:hidden; text-decoration:none; color:inherit; box-shadow:var(--shadow); transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
  .card:hover{ transform:translateY(-4px); border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); box-shadow:0 8px 18px rgba(20,26,54,.10),0 26px 50px rgba(20,26,54,.14); }
  .card:focus-visible{ outline:2px solid var(--accent); outline-offset:3px; }
  .thumb{ aspect-ratio:1100/620; overflow:hidden; background:var(--chip); border-bottom:1px solid var(--line); }
  .thumb img{ width:100%; height:100%; object-fit:cover; object-position:top center; display:block; }
  .meta{ padding:15px 16px 17px; display:flex; flex-direction:column; gap:7px; }
  .row{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
  h3{ font-size:17px; margin:0; letter-spacing:-.01em; }
  .live{ font-size:12px; font-weight:700; color:var(--accent); flex:none; }
  .desc{ color:var(--muted); font-size:13.5px; margin:0; line-height:1.5; }
  .insp{ color:var(--muted); font-size:12px; margin:2px 0 0; opacity:.8; }
  footer{ margin-top:60px; padding-top:22px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
  @media (prefers-reduced-motion:reduce){ .card{ transition:none; } .card:hover{ transform:none; } }
</style>
<div class="wrap">
  <header class="top">
    <div class="brand"><span class="mark"></span> Elara</div>
    <h1>Website designs for your properties</h1>
    <p class="lede">Thirty finished designs for your guest-facing booking sites — each a complete look with its own typography, palette and personality. Pick one per property; your logo, brand color and content flow in automatically.</p>
    <span class="stat"><span class="dot"></span> 30 designs · 5 styles · click any to preview it live</span>
  </header>
  ${sections}
  <footer>Previews open the live sample site on elarapms.com. In the builder, choose a design per property under <strong>Website → pick a template</strong>.</footer>
</div>`;
writeFileSync('/tmp/claude-0/-home-user-Elara/8362700f-e9b3-5f80-9d7c-fe02ed300b4d/scratchpad/template-catalog.html', html);
console.log('catalog written, bytes:', html.length, '| templates:', gallery.length);
