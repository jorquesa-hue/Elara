// The guest-facing booking microsite — a self-contained, zero-dependency HTML page
// served publicly at /site/:tenant. It reads its tenant from the URL, calls the
// public /site/:tenant/{config,availability,inquire} endpoints, and renders the
// operator-authored storefront: branded hero (logo/color/tagline/custom title),
// unit cards with photos + beds/baths/guests + amenities, live availability with
// dynamic pricing, an about section, a contact footer, and a booking-request form
// that drops a lead into the operator's pipeline. No auth, no PII, no payment (v1).

export function bookingSiteHtml(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Book your stay</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20128%20128%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22b%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%236D8BFF%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B6CFF%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22128%22%20height%3D%22128%22%20rx%3D%2230%22%20fill%3D%22url%28%23b%29%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M%2024.40%2029.00%20Q%2024.40%2016.00%2037.40%2016.00%20L%2090.60%2016.00%20Q%20103.60%2016.00%20103.60%2029.00%20L%20103.60%2031.51%20Q%20103.60%2044.51%2090.60%2044.51%20L%2059.92%2044.51%20Q%2056.08%2044.51%2056.08%2048.35%20L%2056.08%2048.35%20Q%2056.08%2052.19%2059.92%2052.19%20L%2074.73%2052.19%20Q%2086.73%2052.19%2086.73%2064.19%20L%2086.73%2064.19%20Q%2086.73%2076.19%2074.73%2076.19%20L%2059.73%2076.19%20Q%2056.08%2076.19%2056.08%2079.84%20L%2056.08%2079.84%20Q%2056.08%2083.49%2059.73%2083.49%20L%2090.60%2083.49%20Q%20103.60%2083.49%20103.60%2096.49%20L%20103.60%2099.00%20Q%20103.60%20112.00%2090.60%20112.00%20L%2037.40%20112.00%20Q%2024.40%20112.00%2024.40%2099.00%20Z%22%2F%3E%3C%2Fsvg%3E"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet"/>
<style>
  :root{ --bg:#f5f6fb; --card:#fff; --line:#e6e8f0; --text:#151a2e; --muted:#5b6480; --accent:#6d8bff; --accent2:#8b6cff; --ok:#3aa76d; --radius:12px; --herobg:linear-gradient(135deg,#6d8bff,#8b6cff);
    --brand-body:"Inter",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --brand-display:"Plus Jakarta Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  *{ box-sizing:border-box; } html,body{ margin:0; }
  body{ background:var(--bg); color:var(--text); font:15px/1.5 var(--brand-body); font-variant-numeric:tabular-nums; }
  h1,h2,h3,.price{ font-family:var(--brand-display); letter-spacing:-.01em; }
  body.font-all, body.font-all input, body.font-all .btn{ font-family:var(--font-body,inherit); }
  body.font-display h1, body.font-display h2, body.font-display h3, body.font-display .price{ font-family:var(--font-display,inherit); }
  .wrap{ max-width:1040px; margin:0 auto; padding:24px 18px 60px; }
  header.hero{ padding:40px 0 26px; }
  .brand{ display:flex; align-items:center; gap:12px; }
  .logo{ width:34px; height:34px; }
  h1{ font-size:30px; margin:14px 0 6px; letter-spacing:-.02em; }
  h2{ font-size:20px; margin:34px 0 12px; letter-spacing:-.01em; }
  .sub{ color:var(--muted); margin:0; }
  .searchbar{ display:flex; gap:12px; flex-wrap:wrap; align-items:end; background:var(--card); border:1px solid var(--line); border-radius:calc(var(--radius) + 4px); padding:16px; margin:22px 0 8px; }
  .field{ display:flex; flex-direction:column; gap:5px; } label{ font-size:12px; color:var(--muted); font-weight:600; }
  input{ font:inherit; padding:10px 12px; border-radius:var(--radius); border:1px solid var(--line); background:var(--bg); color:var(--text); }
  .btn{ font:inherit; font-weight:600; padding:11px 18px; border-radius:var(--radius); border:0; cursor:pointer; color:#fff;
        background:linear-gradient(135deg,var(--accent),var(--accent2)); }
  .btn.ghost{ background:transparent; border:1px solid var(--line); color:var(--text); }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:16px; margin-top:20px; }
  body[data-cards="wide"] .grid{ grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:20px; }
  body[data-cards="list"] .grid{ grid-template-columns:1fr; gap:14px; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:calc(var(--radius) + 4px); overflow:hidden; display:flex; flex-direction:column; }
  body[data-cards="list"] .card{ flex-direction:row; }
  body[data-cards="list"] .photo{ width:36%; min-width:200px; height:auto; min-height:170px; }
  @media (max-width:640px){ body[data-cards="list"] .card{ flex-direction:column; } body[data-cards="list"] .photo{ width:100%; height:150px; } }
  .photo{ height:150px; background:linear-gradient(135deg,var(--accent),var(--accent2)); opacity:.92; display:flex; align-items:center; justify-content:center; color:#fff; font-size:34px; flex:none; }
  body[data-cards="wide"] .photo{ height:190px; }
  .photo img{ width:100%; height:100%; object-fit:cover; display:block; }
  /* --- hero layout variants ------------------------------------------------ */
  body[data-hero="banner"] header.hero{ background:var(--heroimg,var(--herobg)); background-size:cover; background-position:center; border-radius:calc(var(--radius) + 6px); padding:56px 28px 30px; margin-top:14px; position:relative; overflow:hidden; }
  body[data-hero="banner"] header.hero::before{ content:""; position:absolute; inset:0; background:rgba(10,12,18,.38); border-radius:inherit; }
  body[data-hero="banner"] header.hero > *{ position:relative; }
  body[data-hero="banner"] h1, body[data-hero="banner"] .sub, body[data-hero="banner"] .brand{ color:#fff; }
  body[data-hero="banner"] .sub{ opacity:.92; }
  body[data-hero="split"] header.hero{ display:grid; grid-template-columns:1.1fr .9fr; gap:26px; align-items:center; }
  body[data-hero="split"] .hero-visual{ background:var(--heroimg,var(--herobg)); background-size:cover; background-position:center; border-radius:calc(var(--radius) + 6px); min-height:250px; }
  body[data-hero="split"] .searchbar{ grid-column:1 / -1; }
  @media (max-width:760px){ body[data-hero="split"] header.hero{ grid-template-columns:1fr; } body[data-hero="split"] .hero-visual{ min-height:150px; } }
  body[data-hero="minimal"] header.hero{ padding:26px 0 10px; border-bottom:1px solid var(--line); margin-bottom:6px; }
  body[data-hero="minimal"] h1{ font-size:23px; margin:16px 0 4px; }
  body[data-hero="minimal"] .searchbar{ background:transparent; border:0; padding:14px 0 4px; }
  body[data-hero="editorial"] header.hero{ border-top:3px solid var(--text); border-bottom:1px solid var(--line); padding:34px 0 26px; }
  body[data-hero="editorial"] h1{ font-size:clamp(38px,6vw,58px); line-height:1.05; margin:18px 0 10px; }
  body[data-hero="editorial"] .brand strong{ text-transform:uppercase; letter-spacing:.14em; font-size:13px; }
  .card .body{ padding:14px; flex:1; display:flex; flex-direction:column; gap:7px; }
  .card h3{ margin:0; font-size:16px; }
  .headline{ color:var(--muted); font-size:13px; margin:-2px 0 0; }
  .badges{ display:flex; gap:12px; color:var(--muted); font-size:12.5px; }
  .chips{ display:flex; gap:6px; flex-wrap:wrap; }
  .chips span{ font-size:11.5px; padding:3px 8px; border:1px solid var(--line); border-radius:999px; color:var(--muted); }
  .desc{ color:var(--muted); font-size:13px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .price{ font-weight:700; font-size:18px; } .price small{ color:var(--muted); font-weight:500; font-size:12.5px; }
  .pill{ align-self:flex-start; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding:3px 8px; border-radius:999px; }
  .pill.ok{ background:rgba(58,167,109,.16); color:var(--ok); } .pill.no{ background:rgba(224,90,90,.16); color:#e05a5a; }
  .muted{ color:var(--muted); } .center{ text-align:center; }
  .panel{ background:var(--card); border:1px solid var(--line); border-radius:calc(var(--radius) + 4px); padding:18px; }
  .contact{ display:flex; gap:18px; flex-wrap:wrap; }
  .contact a{ color:var(--accent); text-decoration:none; font-weight:600; }
  dialog{ border:1px solid var(--line); border-radius:calc(var(--radius) + 4px); background:var(--card); color:var(--text); max-width:420px; width:92%; padding:22px; }
  dialog::backdrop{ background:rgba(0,0,0,.5); }
  .row{ display:flex; gap:10px; align-items:center; } .stack{ display:flex; flex-direction:column; gap:12px; }
  footer{ margin-top:44px; color:var(--muted); font-size:12.5px; text-align:center; }
  .toast{ position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:12px 18px; box-shadow:0 10px 30px rgba(0,0,0,.3); }
</style></head><body>
<div class="wrap">
  <header class="hero">
    <div class="brand"><svg class="logo" viewBox="0 0 128 128"><defs><linearGradient id="lm" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#6d8bff"/><stop offset="1" stop-color="#8b6cff"/></linearGradient></defs><rect width="128" height="128" rx="30" fill="url(#lm)"/><path fill="#fff" d="M 24.40 29.00 Q 24.40 16.00 37.40 16.00 L 90.60 16.00 Q 103.60 16.00 103.60 29.00 L 103.60 31.51 Q 103.60 44.51 90.60 44.51 L 59.92 44.51 Q 56.08 44.51 56.08 48.35 L 56.08 48.35 Q 56.08 52.19 59.92 52.19 L 74.73 52.19 Q 86.73 52.19 86.73 64.19 L 86.73 64.19 Q 86.73 76.19 74.73 76.19 L 59.73 76.19 Q 56.08 76.19 56.08 79.84 L 56.08 79.84 Q 56.08 83.49 59.73 83.49 L 90.60 83.49 Q 103.60 83.49 103.60 96.49 L 103.60 99.00 Q 103.60 112.00 90.60 112.00 L 37.40 112.00 Q 24.40 112.00 24.40 99.00 Z"/></svg>
      <strong id="brandName">Loading…</strong></div>
    <h1 id="heroTitle">Find your stay</h1>
    <p class="sub">Live availability and instant pricing — request to book in seconds.</p>
    <div class="searchbar">
      <div class="field"><label>Check-in</label><input type="date" id="from"/></div>
      <div class="field"><label>Check-out</label><input type="date" id="to"/></div>
      <button class="btn" id="searchBtn">Check availability</button>
    </div>
  </header>
  <section id="planSec" style="display:none"><h2>Floorplans</h2><div id="plans" class="grid"></div></section>
  <div id="results" class="grid"></div>
  <section id="aboutSec" style="display:none"><h2 id="aboutTitle">About</h2><div class="panel" id="aboutBody" style="white-space:pre-wrap"></div></section>
  <section id="contactSec" style="display:none"><h2>Contact</h2><div class="panel contact" id="contactBody"></div></section>
  <footer>Powered by <strong>Unified Stay OS</strong> · <span id="foot"></span></footer>
</div>

<dialog id="bookDlg"><form method="dialog" class="stack">
  <strong id="dlgUnit">Request to book</strong>
  <div class="muted" id="dlgDates"></div>
  <div class="field"><label>Your name</label><input id="gName" required/></div>
  <div class="field"><label>Email</label><input id="gEmail" type="email" required/></div>
  <div class="row"><button class="btn" id="sendReq" value="send">Send request</button>
    <button class="btn ghost" value="cancel">Cancel</button></div>
</form></dialog>

<script>
  var TENANT = decodeURIComponent(location.pathname.replace(/^\\/site\\//,"").replace(/\\/.*$/,""));
  var cfg = null, curUnit = null, detailsById = {};
  function money(cents){ if(cents==null) return "—"; try{ return new Intl.NumberFormat((cfg&&cfg.brand&&cfg.brand.locale)||undefined,{style:"currency",currency:(cfg&&cfg.currency)||"USD"}).format(cents/100); }catch(e){ return (cents/100).toFixed(2)+" "+((cfg&&cfg.currency)||""); } }
  function api(path, opts){ return fetch("/site/"+TENANT+path, opts).then(function(r){ return r.json().then(function(j){ return {status:r.status, body:j}; }); }); }
  function toast(m){ var t=document.createElement("div"); t.className="toast"; t.textContent=m; document.body.appendChild(t); setTimeout(function(){ t.remove(); },3200); }
  function el(tag, attrs, kids){ var e=document.createElement(tag); attrs=attrs||{}; Object.keys(attrs).forEach(function(k){ if(k==="html") e.innerHTML=attrs[k]; else e.setAttribute(k, attrs[k]); }); (kids||[]).forEach(function(c){ e.appendChild(typeof c==="string"?document.createTextNode(c):c); }); return e; }

  function today(o){ var d=new Date(Date.now()+(o||0)*86400000); return d.toISOString().slice(0,10); }
  document.getElementById("from").value = today(7);
  document.getElementById("to").value = today(10);

  // ?template=<id> (+ optional radius/font/hero/cards) on the page URL previews
  // that design without saving it — the portal's design preview lands here.
  var PQS = new URLSearchParams(location.search);
  var PREVIEW = PQS.get("template");
  var PPARAMS = "";
  if(PREVIEW){
    var pq = new URLSearchParams({ template: PREVIEW });
    ["radius","font","hero","cards"].forEach(function(k){ var v = PQS.get(k); if(v) pq.set(k, v); });
    PPARAMS = "?" + pq.toString();
  }
  api("/config" + PPARAMS).then(function(r){
    if(r.status!==200){ document.getElementById("heroTitle").textContent="This site isn't published yet."; document.getElementById("brandName").textContent="Booking"; return; }
    cfg = r.body; document.getElementById("brandName").textContent = cfg.displayName;
    document.getElementById("foot").textContent = cfg.displayName;
    var content = cfg.content || {};
    var b = cfg.brand || {};
    // THEME: the picked template (palette, typography, radius, layouts), already
    // resolved server-side with the operator's brand accent + adjustments.
    var th = cfg.theme;
    if(th){
      var rs=document.documentElement.style, p=th.palette||{};
      ["bg","card","line","text","muted","accent","accent2"].forEach(function(k){ if(p[k]) rs.setProperty("--"+k, p[k]); });
      rs.setProperty("--radius", (th.radiusPx||12)+"px");
      rs.setProperty("--herobg", th.heroBg||"linear-gradient(135deg,var(--accent),var(--accent2))");
      if(th.font && th.font.import){ var lk=document.createElement("link"); lk.rel="stylesheet"; lk.href=th.font.import; document.head.appendChild(lk); }
      if(th.font){ if(th.font.displayOnly){ rs.setProperty("--font-display", th.font.family); document.body.classList.add("font-display"); } else { rs.setProperty("--font-body", th.font.family); document.body.classList.add("font-all"); } }
      document.body.setAttribute("data-hero", th.hero||"classic");
      document.body.setAttribute("data-cards", th.cards||"grid");
      if(content.heroPhotoDataUrl){ rs.setProperty("--heroimg", "url("+JSON.stringify(content.heroPhotoDataUrl)+")"); }
      if(th.hero==="split"){ var hv=document.createElement("div"); hv.className="hero-visual"; var hd=document.querySelector("header.hero"); hd.insertBefore(hv, hd.querySelector(".searchbar")); }
      if(cfg.previewTemplate){ var rb=document.createElement("div"); rb.textContent="Design preview: "+(th.name||cfg.previewTemplate)+" — not saved. Pick it in your Website settings to apply."; rb.style.cssText="position:fixed;left:0;right:0;bottom:0;z-index:60;background:#111827;color:#fff;font:600 13px system-ui;padding:9px 16px;text-align:center;opacity:.94"; document.body.appendChild(rb); }
    }
    // Brand: logo + tagline (accent already folded into the theme server-side).
    if(b.logoDataUrl){ var l=document.querySelector(".logo"); if(l){ var img=document.createElement("img"); img.src=b.logoDataUrl; img.alt=cfg.displayName; img.style.cssText="height:34px;width:auto;border-radius:6px"; l.replaceWith(img); } }
    if(b.tagline){ document.querySelector(".sub").textContent = b.tagline; }
    if(content.heroTitle){ document.getElementById("heroTitle").textContent = content.heroTitle; }
    document.title = (content.heroTitle || "Book your stay") + " · " + cfg.displayName;
    if(content.about){ document.getElementById("aboutSec").style.display=""; document.getElementById("aboutTitle").textContent="About "+cfg.displayName; document.getElementById("aboutBody").textContent = content.about; }
    renderContact(content);
    renderFloorplans(cfg.floorplans||[]);
    (cfg.units||[]).forEach(function(u){ detailsById[u.id] = u.details || {}; });
    renderUnits(cfg.units.map(function(u){ return { unitId:u.id, label:u.label, available:true, nightlyCents:u.fromCents, from:true }; }));
  });

  function renderContact(c){
    var links=[];
    if(c.contactEmail) links.push(el("a",{href:"mailto:"+c.contactEmail},["✉ "+c.contactEmail]));
    if(c.contactPhone) links.push(el("a",{href:"tel:"+c.contactPhone.replace(/[^+0-9]/g,"")},["☎ "+c.contactPhone]));
    if(c.whatsapp) links.push(el("a",{href:"https://wa.me/"+c.whatsapp.replace(/[^0-9]/g,""),target:"_blank",rel:"noopener"},["WhatsApp"]));
    if(c.instagram) links.push(el("a",{href:"https://instagram.com/"+c.instagram.replace(/^@/,""),target:"_blank",rel:"noopener"},["Instagram"]));
    if(c.facebook) links.push(el("a",{href:"https://facebook.com/"+c.facebook.replace(/^@/,""),target:"_blank",rel:"noopener"},["Facebook"]));
    if(!links.length) return;
    var body=document.getElementById("contactBody"); links.forEach(function(a){ body.appendChild(a); });
    document.getElementById("contactSec").style.display="";
  }

  function unitCard(u){
    var d = detailsById[u.unitId] || {};
    var photo = d.photoDataUrl
      ? el("div",{class:"photo"},[el("img",{src:d.photoDataUrl,alt:u.label,loading:"lazy"})])
      : el("div",{class:"photo"},["🏖️"]);
    var kids=[ el("h3",{},[u.label]) ];
    if(d.headline) kids.push(el("p",{class:"headline"},[d.headline]));
    kids.push(u.from? el("span",{class:"pill ok"},["Available"]) : el("span",{class:"pill "+(u.available?"ok":"no")},[u.available?"Available":"Unavailable"]));
    var badges=[];
    if(d.bedrooms!=null) badges.push("🛏 "+d.bedrooms);
    if(d.bathrooms!=null) badges.push("🛁 "+d.bathrooms);
    if(d.maxGuests!=null) badges.push("👥 up to "+d.maxGuests);
    if(badges.length) kids.push(el("div",{class:"badges"}, badges.map(function(b){ return el("span",{},[b]); })));
    if(d.amenities && d.amenities.length){
      var shown=d.amenities.slice(0,4), extra=d.amenities.length-shown.length;
      kids.push(el("div",{class:"chips"}, shown.map(function(a){ return el("span",{},[a]); }).concat(extra>0?[el("span",{},["+"+extra+" more"])]:[])));
    }
    if(d.description) kids.push(el("p",{class:"desc"},[d.description]));
    kids.push(u.from
      ? el("div",{class:"price"},[ u.nightlyCents!=null? el("span",{},[money(u.nightlyCents)]) : el("span",{class:"muted"},["Contact for rates"]), el("small",{},[" from / night"]) ])
      : el("div",{class:"price"},[ money(u.nightlyCents), el("small",{},[" / night · "+money(u.totalCents)+" total"]) ]));
    var actions = u.from
      ? el("div",{class:"muted",style:"font-size:12.5px"},["Pick dates above for live pricing"])
      : (u.available ? el("button",{class:"btn"},["Request to book"]) : el("span",{class:"pill no"},["Booked for these dates"]));
    if(!u.from && u.available){ actions.addEventListener("click", function(){ openBooking(u); }); }
    kids.push(actions);
    return el("div",{class:"card"},[ photo, el("div",{class:"body"}, kids) ]);
  }

  function renderUnits(units){
    var wrap=document.getElementById("results"); wrap.innerHTML="";
    if(!units.length){ wrap.appendChild(el("p",{class:"muted center"},["No units published yet."])); return; }
    units.forEach(function(u){ wrap.appendChild(unitCard(u)); });
  }

  // Floorplan sections — how multifamily portfolios merchandise: the plan's
  // details + market "from" price + how many residences it has, entered once.
  function renderFloorplans(plans){
    if(!plans.length) return;
    var ps=document.getElementById("plans"); ps.innerHTML="";
    plans.forEach(function(f){
      var kids=[ el("h3",{},[f.name]) ];
      var meta=[];
      if(f.bedrooms!=null) meta.push("🛏 "+f.bedrooms);
      if(f.bathrooms!=null) meta.push("🛁 "+f.bathrooms);
      if(f.areaSqm!=null) meta.push("📐 "+f.areaSqm+" m²");
      if(meta.length) kids.push(el("div",{class:"badges"}, meta.map(function(m){ return el("span",{},[m]); })));
      if(f.description) kids.push(el("p",{class:"desc"},[f.description]));
      kids.push(el("div",{class:"price"},[ f.fromCents!=null? el("span",{},[money(f.fromCents)]) : el("span",{class:"muted"},["Contact for rates"]), el("small",{},[f.fromCents!=null?" from":""]) ]));
      kids.push(el("div",{class:"muted",style:"font-size:12.5px"},[f.unitCount+(f.unitCount===1?" residence":" residences")]));
      ps.appendChild(el("div",{class:"card"},[ el("div",{class:"body"}, kids) ]));
    });
    document.getElementById("planSec").style.display="";
  }

  document.getElementById("searchBtn").addEventListener("click", function(){
    var from=document.getElementById("from").value, to=document.getElementById("to").value;
    if(!from||!to) return toast("Pick check-in and check-out dates");
    api("/availability",{ method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({from:from,to:to}) }).then(function(r){
      if(r.status!==200) return toast((r.body&&r.body.error)||"Could not check availability");
      renderUnits(r.body.units.map(function(u){ u.from=false; return u; }));
    });
  });

  var dlg=document.getElementById("bookDlg");
  function openBooking(u){
    curUnit=u; document.getElementById("dlgUnit").textContent="Request: "+u.label;
    document.getElementById("dlgDates").textContent = document.getElementById("from").value+" → "+document.getElementById("to").value+" · "+money(u.totalCents)+" total ("+u.nights+" nights)";
    dlg.showModal();
  }
  document.getElementById("sendReq").addEventListener("click", function(ev){
    var name=document.getElementById("gName").value.trim(), email=document.getElementById("gEmail").value.trim();
    if(!name||!email){ ev.preventDefault(); return toast("Enter your name and email"); }
    api("/inquire",{ method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ unitId:curUnit.unitId, from:document.getElementById("from").value, to:document.getElementById("to").value, name:name, email:email }) }).then(function(r){
      if(r.status===201){ toast("Request sent! The host will be in touch."); document.getElementById("gName").value=""; document.getElementById("gEmail").value=""; }
      else toast((r.body&&r.body.error)||"Could not send request");
    });
  });
</script></body></html>`;
}
