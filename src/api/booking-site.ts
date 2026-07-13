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
<style>
  :root{ --bg:#f5f6fb; --card:#fff; --line:#e6e8f0; --text:#151a2e; --muted:#5b6480; --accent:#6d8bff; --accent2:#8b6cff; --ok:#3aa76d; --radius:12px; --herobg:linear-gradient(135deg,#6d8bff,#8b6cff); }
  *{ box-sizing:border-box; } html,body{ margin:0; }
  body{ background:var(--bg); color:var(--text); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
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
    <div class="brand"><svg class="logo" viewBox="0 0 28 28" fill="none"><defs><linearGradient id="lm" x1="0" y1="28" x2="28" y2="0"><stop stop-color="#6d8bff"/><stop offset="1" stop-color="#8b6cff"/></linearGradient></defs><rect x="3" y="16" width="5" height="9" rx="2" fill="url(#lm)"/><rect x="11.5" y="9" width="5" height="16" rx="2" fill="url(#lm)"/><rect x="20" y="3" width="5" height="22" rx="2" fill="url(#lm)"/></svg>
      <strong id="brandName">Loading…</strong></div>
    <h1 id="heroTitle">Find your stay</h1>
    <p class="sub">Live availability and instant pricing — request to book in seconds.</p>
    <div class="searchbar">
      <div class="field"><label>Check-in</label><input type="date" id="from"/></div>
      <div class="field"><label>Check-out</label><input type="date" id="to"/></div>
      <button class="btn" id="searchBtn">Check availability</button>
    </div>
  </header>
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

  api("/config").then(function(r){
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
    }
    // Brand: logo + tagline (accent already folded into the theme server-side).
    if(b.logoDataUrl){ var l=document.querySelector(".logo"); if(l){ var img=document.createElement("img"); img.src=b.logoDataUrl; img.alt=cfg.displayName; img.style.cssText="height:34px;width:auto;border-radius:6px"; l.replaceWith(img); } }
    if(b.tagline){ document.querySelector(".sub").textContent = b.tagline; }
    if(content.heroTitle){ document.getElementById("heroTitle").textContent = content.heroTitle; }
    document.title = (content.heroTitle || "Book your stay") + " · " + cfg.displayName;
    if(content.about){ document.getElementById("aboutSec").style.display=""; document.getElementById("aboutTitle").textContent="About "+cfg.displayName; document.getElementById("aboutBody").textContent = content.about; }
    renderContact(content);
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
