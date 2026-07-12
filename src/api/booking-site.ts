// The guest-facing booking microsite — a self-contained, zero-dependency HTML page
// served publicly at /site/:tenant. It reads its tenant from the URL, calls the
// public /site/:tenant/{config,availability,inquire} endpoints, and renders a
// clean storefront: hero, unit cards with "from" pricing, a date picker that runs
// a LIVE availability + dynamic-pricing check, and a booking-request form that
// drops a lead into the operator's pipeline. No auth, no PII, no payment (v1).

export function bookingSiteHtml(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Book your stay</title>
<style>
  :root{ --bg:#0f1220; --card:#181c2e; --line:#282d44; --text:#eef1f8; --muted:#9aa3bd; --accent:#6d8bff; --accent2:#8b6cff; --ok:#3aa76d; }
  @media (prefers-color-scheme: light){ :root{ --bg:#f5f6fb; --card:#fff; --line:#e6e8f0; --text:#151a2e; --muted:#5b6480; } }
  *{ box-sizing:border-box; } html,body{ margin:0; }
  body{ background:var(--bg); color:var(--text); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap{ max-width:1040px; margin:0 auto; padding:24px 18px 60px; }
  header.hero{ padding:40px 0 26px; }
  .brand{ display:flex; align-items:center; gap:12px; }
  .logo{ width:34px; height:34px; }
  h1{ font-size:30px; margin:14px 0 6px; letter-spacing:-.02em; }
  .sub{ color:var(--muted); margin:0; }
  .searchbar{ display:flex; gap:12px; flex-wrap:wrap; align-items:end; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin:22px 0 8px; }
  .field{ display:flex; flex-direction:column; gap:5px; } label{ font-size:12px; color:var(--muted); font-weight:600; }
  input{ font:inherit; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--bg); color:var(--text); }
  .btn{ font:inherit; font-weight:600; padding:11px 18px; border-radius:10px; border:0; cursor:pointer; color:#fff;
        background:linear-gradient(135deg,var(--accent),var(--accent2)); }
  .btn.ghost{ background:transparent; border:1px solid var(--line); color:var(--text); }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:16px; margin-top:20px; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:16px; overflow:hidden; display:flex; flex-direction:column; }
  .photo{ height:130px; background:linear-gradient(135deg,var(--accent),var(--accent2)); opacity:.85; display:flex; align-items:center; justify-content:center; color:#fff; font-size:34px; }
  .card .body{ padding:14px; flex:1; display:flex; flex-direction:column; gap:6px; }
  .card h3{ margin:0; font-size:16px; }
  .price{ font-weight:700; font-size:18px; } .price small{ color:var(--muted); font-weight:500; font-size:12.5px; }
  .pill{ align-self:flex-start; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding:3px 8px; border-radius:999px; }
  .pill.ok{ background:rgba(58,167,109,.16); color:var(--ok); } .pill.no{ background:rgba(224,90,90,.16); color:#e05a5a; }
  .muted{ color:var(--muted); } .center{ text-align:center; }
  dialog{ border:1px solid var(--line); border-radius:16px; background:var(--card); color:var(--text); max-width:420px; width:92%; padding:22px; }
  dialog::backdrop{ background:rgba(0,0,0,.5); }
  .row{ display:flex; gap:10px; align-items:center; } .stack{ display:flex; flex-direction:column; gap:12px; }
  footer{ margin-top:44px; color:var(--muted); font-size:12.5px; text-align:center; }
  .toast{ position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 18px; box-shadow:0 10px 30px rgba(0,0,0,.3); }
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
  var cfg = null, curUnit = null;
  function money(cents){ if(cents==null) return "—"; try{ return new Intl.NumberFormat(cfg&&cfg.locale||undefined,{style:"currency",currency:(cfg&&cfg.currency)||"USD"}).format(cents/100); }catch(e){ return (cents/100).toFixed(2)+" "+((cfg&&cfg.currency)||""); } }
  function api(path, opts){ return fetch("/site/"+TENANT+path, opts).then(function(r){ return r.json().then(function(j){ return {status:r.status, body:j}; }); }); }
  function toast(m){ var t=document.createElement("div"); t.className="toast"; t.textContent=m; document.body.appendChild(t); setTimeout(function(){ t.remove(); },3200); }
  function el(tag, attrs, kids){ var e=document.createElement(tag); attrs=attrs||{}; Object.keys(attrs).forEach(function(k){ if(k==="html") e.innerHTML=attrs[k]; else e.setAttribute(k, attrs[k]); }); (kids||[]).forEach(function(c){ e.appendChild(typeof c==="string"?document.createTextNode(c):c); }); return e; }

  function today(o){ var d=new Date(Date.now()+(o||0)*86400000); return d.toISOString().slice(0,10); }
  document.getElementById("from").value = today(7);
  document.getElementById("to").value = today(10);

  api("/config").then(function(r){
    if(r.status!==200){ document.getElementById("heroTitle").textContent="This site isn't published yet."; document.getElementById("brandName").textContent="Booking"; return; }
    cfg = r.body; document.getElementById("brandName").textContent = cfg.displayName; document.title = "Book your stay · "+cfg.displayName;
    document.getElementById("foot").textContent = cfg.displayName;
    renderUnits(cfg.units.map(function(u){ return { unitId:u.id, label:u.label, available:true, nightlyCents:u.fromCents, from:true }; }));
  });

  function renderUnits(units){
    var wrap=document.getElementById("results"); wrap.innerHTML="";
    if(!units.length){ wrap.appendChild(el("p",{class:"muted center"},["No units published yet."])); return; }
    units.forEach(function(u){
      var priceLine = u.from
        ? el("div",{class:"price"},[ u.nightlyCents!=null? el("span",{},[money(u.nightlyCents)]) : el("span",{class:"muted"},["Contact for rates"]), el("small",{},[" from / night"]) ])
        : el("div",{class:"price"},[ money(u.nightlyCents), el("small",{},[" / night · "+money(u.totalCents)+" total"]) ]);
      var actions = u.from
        ? el("div",{class:"muted",style:"font-size:12.5px"},["Pick dates above for live pricing"])
        : (u.available
            ? el("button",{class:"btn"},["Request to book"])
            : el("span",{class:"pill no"},["Booked for these dates"]));
      if(!u.from && u.available){ actions.addEventListener("click", function(){ openBooking(u); }); }
      var card = el("div",{class:"card"},[
        el("div",{class:"photo"},["🏖️"]),
        el("div",{class:"body"},[ el("h3",{},[u.label]), (u.from? el("span",{class:"pill ok"},["Available"]) : el("span",{class:"pill "+(u.available?"ok":"no")},[u.available?"Available":"Unavailable"])), priceLine, actions ])
      ]);
      wrap.appendChild(card);
    });
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
