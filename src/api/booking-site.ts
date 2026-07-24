// The guest-facing booking microsite — a self-contained, zero-dependency HTML
// page served publicly at /site/:tenant. It reads its tenant from the URL, calls
// the public /site/:tenant/{config,availability,inquire} endpoints, and renders
// the operator-authored storefront: a branded hero, floorplan + unit cards with
// photo galleries, a click-through unit DETAIL overlay (photo carousel +
// lightbox, full amenities, live availability + dynamic pricing, request-to-book),
// plus optional Gallery / Highlights / Location / Good-to-know / FAQ /
// Testimonials / About / Contact sections. No auth, no PII, no payment (v1) — a
// booking request drops a lead into the operator's pipeline.
//
// SEO: the served HTML carries a `<!--SEO-->` placeholder that the HTTP layer
// replaces with real <title>/<meta>/OpenGraph/JSON-LD (see siteSeo + http.ts) so
// shared links and crawlers see content before the page hydrates client-side.

export const SEO_PLACEHOLDER = '<!--SEO-->';

export function bookingSiteHtml(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
${SEO_PLACEHOLDER}
<title>Book your stay</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20128%20128%22%3E%3Crect%20width%3D%22128%22%20height%3D%22128%22%20rx%3D%2230%22%20fill%3D%22%236d8bff%22%2F%3E%3C%2Fsvg%3E"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet"/>
<style>
  :root{ --bg:#f5f6fb; --card:#fff; --line:#e6e8f0; --text:#151a2e; --muted:#5b6480; --accent:#6d8bff; --accent2:#8b6cff; --ok:#3aa76d; --radius:12px; --herobg:linear-gradient(135deg,#6d8bff,#8b6cff);
    --brand-body:"Inter",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --brand-display:"Plus Jakarta Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  *{ box-sizing:border-box; } html,body{ margin:0; }
  body{ background:var(--bg); color:var(--text); font:15px/1.55 var(--brand-body); font-variant-numeric:tabular-nums; }
  h1,h2,h3,.price{ font-family:var(--brand-display); letter-spacing:-.01em; }
  body.font-all, body.font-all input, body.font-all .btn, body.font-all textarea{ font-family:var(--font-body,inherit); }
  body.font-display h1, body.font-display h2, body.font-display h3, body.font-display .price{ font-family:var(--font-display,inherit); }
  a{ color:var(--accent); }
  .wrap{ max-width:1080px; margin:0 auto; padding:24px 18px 60px; }
  header.hero{ padding:40px 0 26px; }
  .brand{ display:flex; align-items:center; gap:12px; }
  .logo{ width:34px; height:34px; }
  h1{ font-size:32px; margin:14px 0 6px; letter-spacing:-.02em; }
  h2{ font-size:21px; margin:0 0 14px; letter-spacing:-.01em; }
  section{ margin-top:40px; scroll-margin-top:20px; }
  .sub{ color:var(--muted); margin:0; }
  .lede{ color:var(--muted); font-size:16px; margin:2px 0 0; max-width:60ch; }
  .searchbar{ display:flex; gap:12px; flex-wrap:wrap; align-items:end; background:var(--card); border:1px solid var(--line); border-radius:calc(var(--radius) + 4px); padding:16px; margin:22px 0 8px; box-shadow:0 8px 24px rgba(20,26,46,.05); }
  .field{ display:flex; flex-direction:column; gap:5px; } label{ font-size:12px; color:var(--muted); font-weight:600; }
  input,textarea{ font:inherit; padding:10px 12px; border-radius:var(--radius); border:1px solid var(--line); background:var(--bg); color:var(--text); }
  .btn{ font:inherit; font-weight:600; padding:11px 18px; border-radius:var(--radius); border:0; cursor:pointer; color:#fff;
        background:linear-gradient(135deg,var(--accent),var(--accent2)); }
  .btn:disabled{ opacity:.5; cursor:not-allowed; }
  .btn.ghost{ background:transparent; border:1px solid var(--line); color:var(--text); }
  .btn.block{ width:100%; text-align:center; }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:16px; margin-top:6px; }
  body[data-cards="wide"] #results.grid{ grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:20px; }
  body[data-cards="list"] #results.grid{ grid-template-columns:1fr; gap:14px; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:calc(var(--radius) + 4px); overflow:hidden; display:flex; flex-direction:column; transition:transform .15s ease, box-shadow .15s ease; }
  .card.clickable{ cursor:pointer; } .card.clickable:hover{ transform:translateY(-3px); box-shadow:0 16px 34px rgba(20,26,46,.12); }
  body[data-cards="list"] #results .card{ flex-direction:row; }
  body[data-cards="list"] #results .photo{ width:38%; min-width:210px; height:auto; min-height:180px; }
  @media (max-width:640px){ body[data-cards="list"] #results .card{ flex-direction:column; } body[data-cards="list"] #results .photo{ width:100%; height:170px; } }
  .photo{ height:190px; background:linear-gradient(135deg,var(--accent),var(--accent2)); opacity:.95; display:flex; align-items:center; justify-content:center; color:#fff; font-size:34px; flex:none; position:relative; }
  body[data-cards="wide"] #results .photo{ height:210px; }
  .photo img{ width:100%; height:100%; object-fit:cover; display:block; }
  .photo .count{ position:absolute; right:10px; bottom:10px; background:rgba(10,12,18,.62); color:#fff; font-size:12px; font-weight:600; padding:3px 9px; border-radius:999px; backdrop-filter:blur(4px); }
  /* --- hero layout variants ------------------------------------------------ */
  body[data-hero="banner"] header.hero{ background:var(--heroimg,var(--herobg)); background-size:cover; background-position:center; border-radius:calc(var(--radius) + 6px); padding:60px 30px 30px; margin-top:14px; position:relative; overflow:hidden; }
  body[data-hero="banner"] header.hero::before{ content:""; position:absolute; inset:0; background:linear-gradient(180deg,rgba(10,12,18,.28),rgba(10,12,18,.52)); border-radius:inherit; }
  body[data-hero="banner"] header.hero > *{ position:relative; }
  body[data-hero="banner"] h1, body[data-hero="banner"] .lede, body[data-hero="banner"] .brand{ color:#fff; }
  body[data-hero="banner"] .lede{ opacity:.95; }
  body[data-hero="split"] header.hero{ display:grid; grid-template-columns:1.1fr .9fr; gap:26px; align-items:center; }
  body[data-hero="split"] .hero-visual{ background:var(--heroimg,var(--herobg)); background-size:cover; background-position:center; border-radius:calc(var(--radius) + 6px); min-height:280px; }
  body[data-hero="split"] .searchbar{ grid-column:1 / -1; }
  @media (max-width:760px){ body[data-hero="split"] header.hero{ grid-template-columns:1fr; } body[data-hero="split"] .hero-visual{ min-height:160px; } }
  body[data-hero="minimal"] header.hero{ padding:26px 0 10px; border-bottom:1px solid var(--line); margin-bottom:6px; }
  body[data-hero="minimal"] h1{ font-size:25px; margin:16px 0 4px; }
  body[data-hero="minimal"] .searchbar{ background:transparent; border:0; padding:14px 0 4px; box-shadow:none; }
  body[data-hero="editorial"] header.hero{ border-top:3px solid var(--text); border-bottom:1px solid var(--line); padding:34px 0 26px; }
  body[data-hero="editorial"] h1{ font-size:clamp(40px,6vw,60px); line-height:1.05; margin:18px 0 10px; }
  body[data-hero="editorial"] .brand strong{ text-transform:uppercase; letter-spacing:.14em; font-size:13px; }
  .card .body{ padding:15px; flex:1; display:flex; flex-direction:column; gap:8px; }
  .card h3{ margin:0; font-size:16.5px; }
  .headline{ color:var(--muted); font-size:13.5px; margin:-3px 0 0; }
  .badges{ display:flex; gap:14px; color:var(--muted); font-size:13px; flex-wrap:wrap; }
  .chips{ display:flex; gap:6px; flex-wrap:wrap; }
  .chips span{ font-size:12px; padding:4px 10px; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:var(--bg); }
  .desc{ color:var(--muted); font-size:13.5px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .price{ font-weight:700; font-size:19px; margin-top:auto; } .price small{ color:var(--muted); font-weight:500; font-size:12.5px; }
  .pill{ align-self:flex-start; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding:3px 9px; border-radius:999px; }
  .pill.ok{ background:rgba(58,167,109,.16); color:var(--ok); } .pill.no{ background:rgba(224,90,90,.16); color:#e05a5a; }
  .muted{ color:var(--muted); } .center{ text-align:center; }
  .panel{ background:var(--card); border:1px solid var(--line); border-radius:calc(var(--radius) + 4px); padding:20px; }
  /* --- gallery ------------------------------------------------------------- */
  .gallery{ display:grid; grid-template-columns:repeat(4,1fr); grid-auto-rows:150px; gap:10px; }
  .gallery .g{ overflow:hidden; border-radius:var(--radius); cursor:pointer; background:var(--card); }
  .gallery .g:first-child{ grid-column:span 2; grid-row:span 2; }
  .gallery .g img{ width:100%; height:100%; object-fit:cover; display:block; transition:transform .3s ease; }
  .gallery .g:hover img{ transform:scale(1.05); }
  @media (max-width:640px){ .gallery{ grid-template-columns:repeat(2,1fr); grid-auto-rows:120px; } .gallery .g:first-child{ grid-column:span 2; grid-row:span 1; } }
  /* --- highlights / good-to-know ------------------------------------------ */
  .feat{ display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:10px; }
  .feat .f{ display:flex; align-items:center; gap:10px; background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:12px 14px; font-weight:600; font-size:14px; }
  .feat .f .dot{ width:8px; height:8px; border-radius:999px; background:var(--accent); flex:none; }
  .kv{ display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }
  .kv .k{ font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .kv .v{ margin-top:2px; }
  /* --- faq ----------------------------------------------------------------- */
  details.faq{ background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:14px 16px; margin-bottom:10px; }
  details.faq summary{ cursor:pointer; font-weight:600; list-style:none; display:flex; justify-content:space-between; gap:12px; }
  details.faq summary::-webkit-details-marker{ display:none; }
  details.faq summary::after{ content:"+"; color:var(--accent); font-weight:700; }
  details.faq[open] summary::after{ content:"–"; }
  details.faq .a{ color:var(--muted); margin-top:10px; white-space:pre-wrap; }
  /* --- testimonials -------------------------------------------------------- */
  .quotes{ display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
  .quotes .q{ background:var(--card); border:1px solid var(--line); border-radius:calc(var(--radius) + 2px); padding:18px; }
  .quotes .q p{ margin:0 0 12px; font-size:14.5px; }
  .quotes .q .by{ font-weight:700; font-size:13.5px; } .quotes .q .loc{ color:var(--muted); font-size:12.5px; }
  .stars{ color:#f5a623; letter-spacing:2px; margin-bottom:8px; }
  .contact{ display:flex; gap:18px; flex-wrap:wrap; }
  .contact a{ text-decoration:none; font-weight:600; }
  /* --- unit detail overlay + carousel + lightbox -------------------------- */
  .overlay{ position:fixed; inset:0; z-index:70; background:rgba(10,12,18,.55); display:none; align-items:flex-start; justify-content:center; overflow:auto; padding:24px 14px; }
  .overlay.on{ display:flex; }
  .sheet{ background:var(--card); border-radius:calc(var(--radius) + 6px); max-width:820px; width:100%; overflow:hidden; box-shadow:0 30px 80px rgba(0,0,0,.4); }
  .sheet .close{ position:absolute; top:16px; right:16px; z-index:2; width:38px; height:38px; border-radius:999px; border:0; background:rgba(10,12,18,.55); color:#fff; font-size:20px; cursor:pointer; }
  .car{ position:relative; background:#0b0d12; aspect-ratio:16/10; }
  .car img{ width:100%; height:100%; object-fit:cover; display:block; cursor:zoom-in; }
  .car .nav{ position:absolute; top:50%; transform:translateY(-50%); width:42px; height:42px; border-radius:999px; border:0; background:rgba(255,255,255,.85); color:#111; font-size:20px; cursor:pointer; }
  .car .prev{ left:12px; } .car .next{ right:12px; }
  .car .dots{ position:absolute; bottom:12px; left:0; right:0; display:flex; gap:6px; justify-content:center; }
  .car .dots i{ width:7px; height:7px; border-radius:999px; background:rgba(255,255,255,.5); } .car .dots i.on{ background:#fff; }
  .sheet .sbody{ padding:22px; }
  .sheet h2{ margin:0 0 4px; }
  .lightbox{ position:fixed; inset:0; z-index:90; background:rgba(6,8,12,.94); display:none; align-items:center; justify-content:center; }
  .lightbox.on{ display:flex; }
  .lightbox img{ max-width:94vw; max-height:90vh; object-fit:contain; border-radius:8px; }
  .lightbox .lb-nav{ position:absolute; top:50%; transform:translateY(-50%); width:52px; height:52px; border-radius:999px; border:0; background:rgba(255,255,255,.14); color:#fff; font-size:24px; cursor:pointer; }
  .lightbox .lb-prev{ left:18px; } .lightbox .lb-next{ right:18px; } .lightbox .lb-close{ top:20px; right:20px; transform:none; }
  footer{ margin-top:52px; color:var(--muted); font-size:12.5px; text-align:center; }
  .toast{ position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:100; background:var(--text); color:#fff; border-radius:var(--radius); padding:12px 18px; box-shadow:0 10px 30px rgba(0,0,0,.3); }
</style></head><body>
<div class="wrap">
  <header class="hero">
    <div class="brand"><svg class="logo" viewBox="0 0 128 128"><defs><linearGradient id="lm" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#6d8bff"/><stop offset="1" stop-color="#8b6cff"/></linearGradient></defs><rect width="128" height="128" rx="30" fill="url(#lm)"/></svg>
      <strong id="brandName">Loading…</strong></div>
    <h1 id="heroTitle">Find your stay</h1>
    <p class="lede" id="heroLede">Live availability and instant pricing — request to book in seconds.</p>
    <div class="searchbar">
      <div class="field"><label>Check-in</label><input type="date" id="from"/></div>
      <div class="field"><label>Check-out</label><input type="date" id="to"/></div>
      <button class="btn" id="searchBtn">Check availability</button>
    </div>
  </header>
  <section id="commSec" style="display:none"><h2>Our communities</h2><div id="commBody" class="grid"></div></section>
  <section id="planSec" style="display:none"><h2>Floorplans</h2><div id="plans" class="grid"></div></section>
  <section id="unitsSec"><h2 id="unitsTitle" style="display:none">Homes</h2><div id="results" class="grid"></div></section>
  <section id="gallerySec" style="display:none"><h2>Gallery</h2><div id="galleryBody" class="gallery"></div></section>
  <section id="featSec" style="display:none"><h2 id="featTitle">Amenities &amp; features</h2><div id="featBody" class="feat"></div></section>
  <section id="aboutSec" style="display:none"><h2 id="aboutTitle">About</h2><div class="panel" id="aboutBody" style="white-space:pre-wrap"></div></section>
  <section id="locSec" style="display:none"><h2>Location</h2><div class="panel" id="locBody"></div></section>
  <section id="polSec" style="display:none"><h2>Good to know</h2><div class="panel"><div id="polBody" class="kv"></div></div></section>
  <section id="faqSec" style="display:none"><h2>Frequently asked</h2><div id="faqBody"></div></section>
  <section id="revSec" style="display:none"><h2>What guests say</h2><div id="revBody" class="quotes"></div></section>
  <section id="contactSec" style="display:none"><h2>Contact</h2><div class="panel contact" id="contactBody"></div></section>
  <footer>Powered by <strong>Unified Stay OS</strong> · <span id="foot"></span></footer>
</div>

<div class="overlay" id="detail"><div class="sheet" style="position:relative"><button class="close" id="dClose" aria-label="Close">×</button>
  <div class="car" id="dCar"></div>
  <div class="sbody">
    <h2 id="dTitle"></h2>
    <p class="headline" id="dHeadline"></p>
    <div class="badges" id="dBadges" style="margin:10px 0"></div>
    <div class="chips" id="dChips" style="margin-bottom:12px"></div>
    <p id="dDesc" class="muted" style="white-space:pre-wrap;line-height:1.6"></p>
    <div class="panel" style="margin-top:16px;background:var(--bg)">
      <div class="price" id="dPrice" style="margin:0 0 12px"></div>
      <div class="row" style="display:flex;gap:12px;flex-wrap:wrap;align-items:end">
        <div class="field"><label>Check-in</label><input type="date" id="dFrom"/></div>
        <div class="field"><label>Check-out</label><input type="date" id="dTo"/></div>
        <button class="btn ghost" id="dCheck">See price</button>
      </div>
      <div id="dAvail" class="muted" style="margin-top:10px;font-size:13.5px"></div>
      <button class="btn block" id="dBook" style="margin-top:14px">Request to book</button>
    </div>
  </div>
</div></div>

<div class="lightbox" id="lb"><button class="lb-nav lb-close" id="lbClose" aria-label="Close">×</button><button class="lb-nav lb-prev" id="lbPrev">‹</button><img id="lbImg" alt=""/><button class="lb-nav lb-next" id="lbNext">›</button></div>

<script>
  // The server injects window.__ELARA_SITE = {tenant, property} so a custom-domain
  // root (or a /p/<code> page) knows which site to load; fall back to the URL.
  var CTX = window.__ELARA_SITE || null;
  var TENANT = CTX && CTX.tenant ? CTX.tenant : decodeURIComponent(location.pathname.replace(/^\\/site\\//,"").replace(/\\/.*$/,""));
  var PROPERTY = (CTX && CTX.property) ? CTX.property
    : (function(){ var m=location.pathname.match(/^\\/site\\/[^/]+\\/p\\/([^/]+)/); return m?decodeURIComponent(m[1]):null; })()
    || new URLSearchParams(location.search).get("property");
  var cfg = null, detailsById = {}, curUnit = null, carPhotos = [], carIdx = 0, lbList = [], lbIdx = 0;
  function money(cents){ if(cents==null) return "—"; try{ return new Intl.NumberFormat((cfg&&cfg.brand&&cfg.brand.locale)||undefined,{style:"currency",currency:(cfg&&cfg.currency)||"USD"}).format(cents/100); }catch(e){ return (cents/100).toFixed(2)+" "+((cfg&&cfg.currency)||""); } }
  function api(path, opts){ var u="/site/"+TENANT+path; if(PROPERTY){ u += (u.indexOf("?")<0?"?":"&")+"property="+encodeURIComponent(PROPERTY); } return fetch(u, opts).then(function(r){ return r.json().then(function(j){ return {status:r.status, body:j}; }); }); }
  function toast(m){ var t=document.createElement("div"); t.className="toast"; t.textContent=m; document.body.appendChild(t); setTimeout(function(){ t.remove(); },3200); }
  function el(tag, attrs, kids){ var e=document.createElement(tag); attrs=attrs||{}; Object.keys(attrs).forEach(function(k){ if(k==="html") e.innerHTML=attrs[k]; else if(k.slice(0,2)==="on"&&typeof attrs[k]==="function") e.addEventListener(k.slice(2),attrs[k]); else if(attrs[k]!=null) e.setAttribute(k, attrs[k]); }); (kids||[]).forEach(function(c){ if(c==null) return; e.appendChild(typeof c==="string"?document.createTextNode(c):c); }); return e; }
  function photosOf(d){ d=d||{}; var out=[]; if(d.photoDataUrl) out.push(d.photoDataUrl); (d.photos||[]).forEach(function(p){ if(out.indexOf(p)<0) out.push(p); }); return out; }

  function today(o){ var d=new Date(Date.now()+(o||0)*86400000); return d.toISOString().slice(0,10); }
  document.getElementById("from").value = today(7);
  document.getElementById("to").value = today(10);

  var PQS = new URLSearchParams(location.search);
  var PREVIEW = PQS.get("template");
  var PPARAMS = "";
  if(PREVIEW || PQS.get("demo")){
    var pq = new URLSearchParams();
    if(PREVIEW) pq.set("template", PREVIEW);
    ["radius","font","hero","cards","demo"].forEach(function(k){ var v = PQS.get(k); if(v) pq.set(k, v); });
    PPARAMS = "?" + pq.toString();
  }
  api("/config" + PPARAMS).then(function(r){
    if(r.status!==200){ document.getElementById("heroTitle").textContent="This site isn't published yet."; document.getElementById("brandName").textContent="Booking"; document.getElementById("heroLede").textContent=""; return; }
    cfg = r.body; document.getElementById("brandName").textContent = cfg.displayName;
    document.getElementById("foot").textContent = cfg.displayName;
    var content = cfg.content || {};
    var b = cfg.brand || {};
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
      if(cfg.previewTemplate||cfg.sampleData){ var rb=document.createElement("div"); rb.textContent=(cfg.sampleData?"Sample content — publish your own units to replace it. ":"")+(cfg.previewTemplate?("Design preview: "+(th.name||cfg.previewTemplate)+" — not saved. Pick it in your Website settings to apply."):"Design preview."); rb.style.cssText="position:fixed;left:0;right:0;bottom:0;z-index:80;background:#111827;color:#fff;font:600 13px system-ui;padding:9px 16px;text-align:center;opacity:.94"; document.body.appendChild(rb); }
    }
    if(b.logoDataUrl){ var l=document.querySelector(".logo"); if(l){ var img=document.createElement("img"); img.src=b.logoDataUrl; img.alt=cfg.displayName; img.style.cssText="height:34px;width:auto;border-radius:6px"; l.replaceWith(img); } }
    if(content.heroTitle){ document.getElementById("heroTitle").textContent = content.heroTitle; }
    var lede = content.heroSubtitle || b.tagline;
    if(lede){ document.getElementById("heroLede").textContent = lede; }
    document.title = (content.heroTitle || "Book your stay") + " · " + cfg.displayName;

    if(content.about){ document.getElementById("aboutSec").style.display=""; document.getElementById("aboutTitle").textContent="About "+cfg.displayName; document.getElementById("aboutBody").textContent = content.about; }
    renderCommunities(cfg.directory||[]);
    renderFloorplans(cfg.floorplans||[]);
    (cfg.units||[]).forEach(function(u){ detailsById[u.id] = u.details || {}; });
    renderUnits((cfg.units||[]).map(function(u){ return { unitId:u.id, label:u.label, available:true, nightlyCents:u.fromCents, from:true }; }));
    if((cfg.units||[]).length) document.getElementById("unitsTitle").style.display="";
    renderGallery(content.galleryPhotos||[]);
    renderHighlights(content.highlights||[]);
    renderLocation(content.location);
    renderPolicies(content.policies||[]);
    renderFaqs(content.faqs||[]);
    renderTestimonials(content.testimonials||[]);
    renderContact(content);
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

  // The portfolio directory — a card per community linking to its own site (its
  // custom domain if set, else /site/<tenant>/p/<code>). On a directory page the
  // individual homes live on each community's page, so the flat unit list, the
  // floorplans and the availability search are hidden.
  function renderCommunities(list){
    if(!list.length) return;
    var wrap=document.getElementById("commBody"); wrap.innerHTML="";
    list.forEach(function(c){
      var href = c.domain ? ("https://"+c.domain) : ("/site/"+TENANT+"/p/"+encodeURIComponent(c.code));
      var photo = c.cover ? el("div",{class:"photo"},[el("img",{src:c.cover,alt:c.name,loading:"lazy"})]) : el("div",{class:"photo"},["🏙️"]);
      var kids=[ el("h3",{},[c.name]) ];
      if(c.subtitle) kids.push(el("p",{class:"headline"},[c.subtitle]));
      kids.push(el("div",{class:"badges"},[ el("span",{},[c.unitCount+(c.unitCount===1?" home":" homes")+" available"]) ]));
      kids.push(c.fromCents!=null ? el("div",{class:"price"},[ el("span",{},[money(c.fromCents)]), el("small",{},[" from / night"]) ]) : el("div",{class:"price"},[ el("span",{class:"muted"},["Contact for rates"]) ]));
      kids.push(el("div",{class:"muted",style:"font-size:12.5px;font-weight:600;color:var(--accent)"},["Explore "+c.name+" →"]));
      wrap.appendChild(el("a",{class:"card clickable",href:href,style:"text-decoration:none;color:inherit"},[ photo, el("div",{class:"body"}, kids) ]));
    });
    document.getElementById("commSec").style.display="";
    document.getElementById("unitsSec").style.display="none";
    var ps=document.getElementById("planSec"); if(ps) ps.style.display="none";
    var sb=document.querySelector(".searchbar"); if(sb) sb.style.display="none";
  }
  function renderGallery(list){
    if(!list.length) return;
    var g=document.getElementById("galleryBody");
    list.slice(0,12).forEach(function(src,i){
      g.appendChild(el("div",{class:"g",onclick:function(){ openLightbox(list,i); }},[ el("img",{src:src,alt:"Photo "+(i+1),loading:"lazy"}) ]));
    });
    document.getElementById("gallerySec").style.display="";
  }
  function renderHighlights(list){
    if(!list.length) return;
    var f=document.getElementById("featBody");
    list.forEach(function(h){ f.appendChild(el("div",{class:"f"},[ el("span",{class:"dot"},[]), h ])); });
    document.getElementById("featSec").style.display="";
  }
  function renderLocation(loc){
    if(!loc || (!loc.address && !loc.neighborhood && !loc.mapsQuery)) return;
    var body=document.getElementById("locBody"), kids=[];
    if(loc.address) kids.push(el("div",{style:"font-weight:600;font-size:16px"},[loc.address]));
    if(loc.neighborhood) kids.push(el("p",{class:"muted",style:"margin:8px 0 0;white-space:pre-wrap;line-height:1.6"},[loc.neighborhood]));
    var q=loc.mapsQuery||loc.address;
    if(q) kids.push(el("div",{style:"margin-top:14px"},[ el("a",{class:"btn ghost",style:"text-decoration:none;display:inline-block",href:"https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(q),target:"_blank",rel:"noopener"},["Get directions ↗"]) ]));
    kids.forEach(function(k){ body.appendChild(k); });
    document.getElementById("locSec").style.display="";
  }
  function renderPolicies(list){
    if(!list.length) return;
    var body=document.getElementById("polBody");
    list.forEach(function(p){ body.appendChild(el("div",{},[ el("div",{class:"k"},[p.label]), el("div",{class:"v"},[p.value]) ])); });
    document.getElementById("polSec").style.display="";
  }
  function renderFaqs(list){
    if(!list.length) return;
    var body=document.getElementById("faqBody");
    list.forEach(function(f){ body.appendChild(el("details",{class:"faq"},[ el("summary",{},[f.q]), el("div",{class:"a"},[f.a]) ])); });
    document.getElementById("faqSec").style.display="";
  }
  function renderTestimonials(list){
    if(!list.length) return;
    var body=document.getElementById("revBody");
    list.forEach(function(t){ body.appendChild(el("div",{class:"q"},[ el("div",{class:"stars"},["★★★★★"]), el("p",{},['“'+t.quote+'”']), el("div",{class:"by"},[t.name]), t.location? el("div",{class:"loc"},[t.location]) : null ])); });
    document.getElementById("revSec").style.display="";
  }

  function badgesOf(d){
    var out=[];
    if(d.bedrooms!=null) out.push("🛏 "+d.bedrooms+" bd");
    if(d.bathrooms!=null) out.push("🛁 "+d.bathrooms+" ba");
    if(d.maxGuests!=null) out.push("👥 up to "+d.maxGuests);
    if(d.areaSqm!=null) out.push("📐 "+d.areaSqm+" m²");
    return out;
  }
  function unitCard(u){
    var d = detailsById[u.unitId] || {};
    var ph = photosOf(d);
    var photo = ph.length
      ? el("div",{class:"photo"},[ el("img",{src:ph[0],alt:u.label,loading:"lazy"}), ph.length>1? el("span",{class:"count"},["📷 "+ph.length]) : null ])
      : el("div",{class:"photo"},["🏠"]);
    var kids=[ el("h3",{},[u.label]) ];
    if(d.headline) kids.push(el("p",{class:"headline"},[d.headline]));
    kids.push(u.from? el("span",{class:"pill ok"},["Available"]) : el("span",{class:"pill "+(u.available?"ok":"no")},[u.available?"Available":"Booked"]));
    var badges=badgesOf(d);
    if(badges.length) kids.push(el("div",{class:"badges"}, badges.map(function(bb){ return el("span",{},[bb]); })));
    if(d.amenities && d.amenities.length){
      var shown=d.amenities.slice(0,4), extra=d.amenities.length-shown.length;
      kids.push(el("div",{class:"chips"}, shown.map(function(a){ return el("span",{},[a]); }).concat(extra>0?[el("span",{},["+"+extra+" more"])]:[])));
    }
    if(d.description) kids.push(el("p",{class:"desc"},[d.description]));
    kids.push(u.from
      ? el("div",{class:"price"},[ u.nightlyCents!=null? el("span",{},[money(u.nightlyCents)]) : el("span",{class:"muted"},["Contact for rates"]), el("small",{},[" from / night"]) ])
      : el("div",{class:"price"},[ money(u.nightlyCents), el("small",{},[" / night · "+money(u.totalCents)+" total"]) ]));
    kids.push(el("div",{class:"muted",style:"font-size:12.5px;font-weight:600;color:var(--accent)"},["View details →"]));
    return el("div",{class:"card clickable",onclick:function(){ openDetail(u); }},[ photo, el("div",{class:"body"}, kids) ]);
  }
  function renderUnits(units){
    var wrap=document.getElementById("results"); wrap.innerHTML="";
    if(!units.length){ wrap.appendChild(el("p",{class:"muted center"},["No homes published yet."])); return; }
    units.forEach(function(u){ wrap.appendChild(unitCard(u)); });
  }

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

  // ---- unit detail overlay ------------------------------------------------
  var overlay=document.getElementById("detail");
  function openDetail(u){
    curUnit = u;
    var d = detailsById[u.unitId] || {};
    document.getElementById("dTitle").textContent = u.label;
    var hl=document.getElementById("dHeadline"); hl.textContent = d.headline||""; hl.style.display = d.headline?"":"none";
    var bd=document.getElementById("dBadges"); bd.innerHTML=""; badgesOf(d).forEach(function(x){ bd.appendChild(el("span",{},[x])); });
    var ch=document.getElementById("dChips"); ch.innerHTML=""; (d.amenities||[]).forEach(function(a){ ch.appendChild(el("span",{},[a])); }); ch.style.display=(d.amenities&&d.amenities.length)?"":"none";
    var ds=document.getElementById("dDesc"); ds.textContent=d.description||""; ds.style.display=d.description?"":"none";
    // carousel photos
    carPhotos = photosOf(d); carIdx = 0; drawCar();
    // pricing + dates
    document.getElementById("dFrom").value = document.getElementById("from").value;
    document.getElementById("dTo").value = document.getElementById("to").value;
    var pr=document.getElementById("dPrice");
    pr.innerHTML=""; pr.appendChild(u.nightlyCents!=null? el("span",{},[money(u.nightlyCents)]) : el("span",{class:"muted"},["Contact for rates"])); pr.appendChild(el("small",{},[u.from?" from / night":" / night"]));
    document.getElementById("dAvail").textContent="";
    document.getElementById("dBook").disabled=false;
    overlay.classList.add("on"); document.body.style.overflow="hidden";
  }
  function closeDetail(){ overlay.classList.remove("on"); document.body.style.overflow=""; }
  document.getElementById("dClose").addEventListener("click", closeDetail);
  overlay.addEventListener("click", function(e){ if(e.target===overlay) closeDetail(); });

  function drawCar(){
    var c=document.getElementById("dCar"); c.innerHTML="";
    if(!carPhotos.length){ c.appendChild(el("div",{style:"width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:52px"},["🏠"])); return; }
    c.appendChild(el("img",{src:carPhotos[carIdx],alt:"",onclick:function(){ openLightbox(carPhotos, carIdx); }}));
    if(carPhotos.length>1){
      c.appendChild(el("button",{class:"nav prev","aria-label":"Previous",onclick:function(e){ e.stopPropagation(); carIdx=(carIdx-1+carPhotos.length)%carPhotos.length; drawCar(); }},["‹"]));
      c.appendChild(el("button",{class:"nav next","aria-label":"Next",onclick:function(e){ e.stopPropagation(); carIdx=(carIdx+1)%carPhotos.length; drawCar(); }},["›"]));
      c.appendChild(el("div",{class:"dots"}, carPhotos.map(function(_,i){ return el("i",{class:i===carIdx?"on":""},[]); })));
    }
  }
  document.getElementById("dCheck").addEventListener("click", function(){
    var from=document.getElementById("dFrom").value, to=document.getElementById("dTo").value;
    if(!from||!to) return toast("Pick check-in and check-out dates");
    api("/availability",{ method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({from:from,to:to}) }).then(function(r){
      if(r.status!==200) return toast((r.body&&r.body.error)||"Could not check availability");
      var found=(r.body.units||[]).filter(function(x){ return x.unitId===curUnit.unitId; })[0];
      var av=document.getElementById("dAvail"), pr=document.getElementById("dPrice");
      if(!found){ av.textContent=""; return; }
      pr.innerHTML=""; pr.appendChild(el("span",{},[money(found.nightlyCents)])); pr.appendChild(el("small",{},[" / night · "+money(found.totalCents)+" total ("+found.nights+" nights)"]));
      if(found.available){ av.innerHTML=""; av.appendChild(el("span",{class:"pill ok"},["Available for these dates"])); document.getElementById("dBook").disabled=false; }
      else { av.innerHTML=""; av.appendChild(el("span",{class:"pill no"},["Booked for these dates"])); document.getElementById("dBook").disabled=true; }
    });
  });
  document.getElementById("dBook").addEventListener("click", function(){
    var from=document.getElementById("dFrom").value, to=document.getElementById("dTo").value;
    if(!from||!to) return toast("Pick your dates first");
    var name=prompt("Your name?"); if(!name) return;
    var email=prompt("Your email?"); if(!email) return;
    api("/inquire",{ method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ unitId:curUnit.unitId, from:from, to:to, name:name.trim(), email:email.trim() }) }).then(function(r){
      if(r.status===201){ toast("Request sent! The host will be in touch."); closeDetail(); }
      else toast((r.body&&r.body.error)||"Could not send request");
    });
  });

  // ---- lightbox -----------------------------------------------------------
  var lb=document.getElementById("lb");
  function openLightbox(list, i){ lbList=list; lbIdx=i; document.getElementById("lbImg").src=list[i]; lb.classList.add("on"); }
  function lbStep(n){ if(!lbList.length) return; lbIdx=(lbIdx+n+lbList.length)%lbList.length; document.getElementById("lbImg").src=lbList[lbIdx]; }
  document.getElementById("lbClose").addEventListener("click", function(){ lb.classList.remove("on"); });
  document.getElementById("lbPrev").addEventListener("click", function(){ lbStep(-1); });
  document.getElementById("lbNext").addEventListener("click", function(){ lbStep(1); });
  lb.addEventListener("click", function(e){ if(e.target===lb) lb.classList.remove("on"); });
  document.addEventListener("keydown", function(e){
    if(lb.classList.contains("on")){ if(e.key==="Escape") lb.classList.remove("on"); if(e.key==="ArrowLeft") lbStep(-1); if(e.key==="ArrowRight") lbStep(1); return; }
    if(overlay.classList.contains("on") && e.key==="Escape") closeDetail();
  });

  // ---- top availability search -------------------------------------------
  document.getElementById("searchBtn").addEventListener("click", function(){
    var from=document.getElementById("from").value, to=document.getElementById("to").value;
    if(!from||!to) return toast("Pick check-in and check-out dates");
    api("/availability",{ method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({from:from,to:to}) }).then(function(r){
      if(r.status!==200) return toast((r.body&&r.body.error)||"Could not check availability");
      renderUnits(r.body.units.map(function(u){ u.from=false; return u; }));
      var t=document.getElementById("unitsTitle"); t.style.display=""; t.textContent="Available "+from+" → "+to;
    });
  });
</script></body></html>`;
}
