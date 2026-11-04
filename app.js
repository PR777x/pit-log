// Pit Log — Firebase edition
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, getDoc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, query, where, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBBbSi3h5wPsIMMZoj2kUoHBa3d-dTb4Ik",
  authDomain: "pit-log.firebaseapp.com",
  projectId: "pit-log",
  storageBucket: "pit-log.firebasestorage.app",
  messagingSenderId: "618514279256",
  appId: "1:618514279256:web:f0956b9c672a00b488932d"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const DB_ID = "pit-log"; // Firestore database ID (created as "pit-log", not "(default)")
let fdb;
try { fdb = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }, DB_ID); }
catch (_) { fdb = initializeFirestore(app, {}, DB_ID); }
const storage = getStorage(app);

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const SPOTS = ["","Barricade","Pit","Floor","GA back","Balcony","Seated","Lawn","Bar"];
const MAX_BYTES = 20 * 1024 * 1024;
const todayISO = (() => { const d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); })();

const SKULL = (on) => SKULLC(on?'var(--bone)':'var(--iron)');
const SKULLC = (fill) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="${fill}" d="M12 2C6.9 2 3 5.7 3 10.5c0 2.6 1.2 4.6 3 5.9V19a1 1 0 0 0 1 1h1.5v-2h1.5v2h4v-2h1.5v2H17a1 1 0 0 0 1-1v-2.6c1.8-1.3 3-3.3 3-5.9C21 5.7 17.1 2 12 2Zm-3.5 7.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM12 13.6l1.2 2.2h-2.4L12 13.6Z"/></svg>`;

let S = { shows: [], loaded: false, slow: false, error: "", tab: "shows", filter: "all", q: "",
  open: null, canWrite: true, year: "all", sort: (()=>{ try { const v = localStorage.getItem("pitlog.sort"); return ["newest","oldest","rating","venue","band"].includes(v) ? v : "newest"; } catch(_) { return "newest"; } })(), vault: { by: "band", sel: null, type: "all", q: "" },
  cal: { y: new Date().getFullYear(), m: new Date().getMonth() } };
let db = null, assets = null;
let ME = null, PROFILE = null;
const FR = {}; // friend uid -> { uid, name, handle, photo, shows, err, unsub }
let REQ = { in: [], out: [] };

const parse = (iso) => { const [y,m,d] = (iso||"").split("-").map(Number); return { y, m, d, dt: new Date(y, (m||1)-1, d||1) }; };
const fmtDate = iso => { const p = parse(iso); return p.y ? `${MONTHS[p.m-1]} ${p.d}, ${p.y}` : ""; };
const isUpcoming = s => (s.date||"") > todayISO;
const lineup = s => Array.isArray(s.lineup) ? s.lineup.filter(Boolean) : [];
const crew = s => Array.isArray(s.wentWith) ? s.wentWith.filter(Boolean) : [];
const sorted = () => [...S.shows].sort((a,b) => (a.date||"").localeCompare(b.date||""));
const inYear = s => S.year === "all" || parse(s.date).y === Number(S.year);
const years = () => [...new Set([new Date().getFullYear(), ...S.shows.map(s=>parse(s.date).y).filter(Boolean)])].sort((a,b)=>b-a);
const yearSeg = () => `<div class="seg" role="group" aria-label="Year"><button data-year="all" aria-pressed="${S.year==="all"}">All years</button>${years().map(y=>`<button data-year="${y}" aria-pressed="${String(S.year)===String(y)}">${y}</button>`).join("")}</div>`;
const norm = x => typeof x === "string" ? { id: x, url: x, type: "image", bands: [] } : { type: "image", bands: [], ...x, id: x.url || x.id };
const pid = p => p ? (p.url || p) : null;
const items = (s, kind) => (Array.isArray(s?.[kind]) ? s[kind] : []).filter(Boolean).map(norm);
const src = u => u || "";

function toast(msg, ms){ const r = $("#toastRoot"); r.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`; clearTimeout(toast.t); toast.t = setTimeout(()=> r.innerHTML="", ms || 2400); }

function firstSightings(){
  const seen = new Set(), firsts = {};
  for (const s of sorted()) { if (isUpcoming(s)) continue; const f = []; for (const b of lineup(s)) { const k = b.toLowerCase(); if (!seen.has(k)) { seen.add(k); f.push(b); } } firsts[s.id] = f; }
  return firsts;
}

function tile(it, opts){
  const tag = opts.tag ? `<span class="tag">${esc(opts.tag)}</span>` : "";
  const kind = opts.kind ? `<span class="kind">${esc(opts.kind)}</span>` : "";
  if (it.type === "video") return `<button class="mt vid" data-lbi="${opts.i}" aria-label="Play video"><video src="${src(it.id)}#t=0.5" preload="metadata" muted playsinline></video>${kind}${tag}</button>`;
  return `<button class="mt" data-lbi="${opts.i}" aria-label="View image"><img src="${src(it.id)}" alt="" loading="lazy">${kind}${tag}</button>`;
}

function renderNext(){
  const ys = S.shows.map(s=>parse(s.date).y).filter(Boolean);
  if (ys.length) $("#yearLabel").textContent = `EST. ${Math.min(...ys)} · ${S.shows.filter(s=>!isUpcoming(s)).length} SHOWS DEEP`;
  const el = $("#next");
  const nx = sorted().find(s => isUpcoming(s) || s.date === todayISO);
  if (!nx) { el.hidden = true; return; }
  const days = Math.round((parse(nx.date).dt - parse(todayISO).dt) / 86400000);
  el.hidden = false;
  el.innerHTML = `<div class="cd num">${days === 0 ? "!" : days}</div>
    <div><div class="lbl">${days === 0 ? "Tonight" : days === 1 ? "Day until next show" : "Days until next show"}</div>
    <div class="who">${esc(lineup(nx).join(" · "))}</div>
    <div class="where">${esc([nx.venue, nx.city].filter(Boolean).join(", ") || "Venue TBD")}${nx.unsure ? " · not locked in" : ""}</div></div>`;
}

/* ---------- Shows tab ---------- */
function ticket(s, firsts, opts){
  opts = opts || {};
  const p = parse(s.date), up = isUpcoming(s), lu = lineup(s);
  const sup = lu.slice(1), firstsHere = (firsts[s.id]||[]), rating = Number(s.rating)||0;
  const media = [...items(s,"photos"), ...items(s,"merch")];
  const vids = media.filter(m=>m.type==="video").length;
  const thumbs = [pid(s.poster), ...media.filter(m=>m.type!=="video").map(m=>m.id)].filter(Boolean).slice(0,5);
  return `<button class="ticket ${up?'upcoming':''}" ${opts.friend ? `data-fopen="${esc(opts.friend)}|${esc(s.id)}"` : `data-open="${esc(s.id)}"`} aria-label="Open ${esc(lu[0]||'show')}">
    <div class="stub"><div class="mo">${MONTHS[(p.m||1)-1].toUpperCase()}</div><div class="dd num">${p.d||"?"}</div><div class="dw">${DAYS[p.dt.getDay()]}</div></div>
    <div class="tbody">
      <div class="head">${esc(lu[0]||"Untitled show")}</div>
      ${sup.length ? `<div class="sup"><b>w/</b> ${esc(sup.join(" · "))}</div>` : ""}
      <div class="venue">${esc([s.venue, s.city].filter(Boolean).join(" — ") || "Venue unknown")}</div>
      <div class="chips">
        ${up ? `<span class="chip up">Upcoming</span>` : ""}
        ${s.unsure ? `<span class="chip unsure">Unconfirmed</span>` : ""}
        ${!up && rating ? `<span class="skulls" aria-label="${rating} of 5">${[1,2,3,4,5].map(i=>SKULL(i<=rating)).join("")}</span>` : ""}
        ${crew(s).map(c=>`<span class="chip crew">${esc(c)}</span>`).join("")}
        ${firstsHere.length && firstsHere.length < lu.length ? `<span class="chip first">${firstsHere.length} new band${firstsHere.length>1?"s":""}</span>` : ""}
        ${s.spot ? `<span class="chip">${esc(s.spot)}</span>` : ""}
        ${togetherChips(s, opts)}
        ${vids ? `<span class="chip vid">${vids} video${vids>1?"s":""}</span>` : ""}
      </div>
      ${thumbs.length ? `<div class="thumbs">${thumbs.map(id=>`<img src="${src(id)}" alt="" loading="lazy" onerror="this.remove()">`).join("")}</div>` : ""}
    </div>
  </button>`;
}

function statusBlock(){
  let html = S.error ? `<div class="note">${esc(S.error)}</div>` : "";
  if (!S.loaded) html += `<div class="empty"><h3>Summoning the setlist…</h3><div>Your shows load here. ${S.slow ? "The log can't be reached yet — check your connection." : ""}</div></div>`;
  return html;
}

const SORTS = { newest: "Newest first", oldest: "Oldest first", rating: "Top rated", venue: "Venue A–Z", band: "Band A–Z" };
const sortKey = s => String(s||"").replace(/^the\s+/i, "").toLowerCase();
function sortShows(list){
  const byDateDesc = (a,b) => (b.date||"").localeCompare(a.date||"");
  const k = S.sort;
  if (k === "oldest") return list.sort((a,b) => (a.date||"").localeCompare(b.date||""));
  if (k === "rating") return list.sort((a,b) => (isUpcoming(a) - isUpcoming(b)) || ((Number(b.rating)||0) - (Number(a.rating)||0)) || byDateDesc(a,b));
  if (k === "venue") return list.sort((a,b) => (!a.venue - !b.venue) || sortKey(a.venue).localeCompare(sortKey(b.venue)) || byDateDesc(a,b));
  if (k === "band") return list.sort((a,b) => sortKey(lineup(a)[0]).localeCompare(sortKey(lineup(b)[0])) || byDateDesc(a,b));
  return list.sort(byDateDesc);
}
function groupOf(s){
  const k = S.sort, p = parse(s.date);
  if (k === "rating") { if (isUpcoming(s)) return ["Upcoming", ""]; const r = Number(s.rating)||0; return r ? [`${r} skull${r>1?"s":""}`, ""] : ["Unrated", ""]; }
  if (k === "venue") return [s.venue || "Venue unknown", s.city || ""];
  if (k === "band") { const c = sortKey(lineup(s)[0]).charAt(0).toUpperCase(); return [/[A-Z]/.test(c) ? c : "#", ""]; }
  return [MONTHS[(p.m||1)-1], String(p.y||"")];
}

function renderShows(){
  let list = S.shows.filter(inYear);
  if (S.filter === "attended") list = list.filter(s => !isUpcoming(s));
  if (S.filter === "upcoming") list = list.filter(isUpcoming);
  const q = S.q.trim().toLowerCase();
  if (q) list = list.filter(s => [...lineup(s), s.venue, s.city, ...crew(s), s.tour].join(" ").toLowerCase().includes(q));
  sortShows(list);
  const firsts = firstSightings();
  let html = `<div class="filters">
    ${yearSeg()}
    <div class="seg" role="group" aria-label="Filter">${["all","attended","upcoming"].map(f=>`<button data-filter="${f}" aria-pressed="${S.filter===f}">${f}</button>`).join("")}</div>
  </div>
  <div class="filters">
    <label class="sortsel"><span class="lbl">Sort</span><select id="sort" aria-label="Sort shows">${Object.entries(SORTS).map(([v,l])=>`<option value="${v}" ${S.sort===v?"selected":""}>${l}</option>`).join("")}</select></label>
    <input class="search" id="q" type="search" placeholder="Search band, venue, crew…" value="${esc(S.q)}" aria-label="Search shows">
  </div>` + statusBlock();
  if (!S.loaded) {}
  else if (!S.shows.length) html += `<div class="empty"><h3>No shows logged</h3><div>Tap <b>+ Add show</b> to log your first night in the pit.</div></div>`;
  else if (!list.length) html += `<div class="empty"><h3>Nothing matches</h3><div>Try another band, venue or name.</div></div>`;
  else {
    const counts = {}; for (const s of list) { const g = groupOf(s).join("|"); counts[g] = (counts[g]||0) + 1; }
    let lastKey = null; html += `<div class="list">`;
    for (const s of list) {
      const [g, sub] = groupOf(s), key = g + "|" + sub;
      if (key !== lastKey) { html += `<div class="month">${esc(g)} <span class="lbl" style="font-size:13px">${esc(sub)}${S.sort!=="newest"&&S.sort!=="oldest" ? `${sub?" · ":""}${counts[key]}` : ""}</span></div>`; lastKey = key; }
      html += ticket(s, firsts);
    }
    html += `</div>`;
  }
  $("#view").innerHTML = html;
}

/* ---------- Vault tab ---------- */
// Every media entry, with the show it came from
function allMedia(){
  const out = [];
  for (const s of sorted()) {
    if (s.poster) out.push({ it: { id: pid(s.poster), url: pid(s.poster), path: s.poster.path, type: "image", bands: [] }, show: s, kind: "poster" });
    for (const k of ["photos","merch"]) for (const it of items(s,k)) out.push({ it, show: s, kind: k });
  }
  return out;
}
const kindLabel = (e) => e.kind === "poster" ? "Poster" : e.kind === "merch" ? "Merch" : e.it.type === "video" ? "Video" : "Photo";
const typeMatch = (e, t) => t === "all" || (t === "photos" && e.kind === "photos" && e.it.type !== "video") || (t === "videos" && e.it.type === "video") || (t === "merch" && e.kind === "merch") || (t === "posters" && e.kind === "poster");
const ieq = (a,b) => String(a||"").toLowerCase() === String(b||"").toLowerCase();

function vaultIndex(){
  const media = allMedia(), shows = sorted().filter(s=>!isUpcoming(s) || allMedia().some(e=>e.show===s));
  const map = new Map();
  const bump = (name, field, extra) => { if (!name) return; const k = name.toLowerCase(); const r = map.get(k) || { name, shows: new Set(), media: 0, vids: 0 }; if (field === "show") r.shows.add(extra); else { r.media++; if (extra) r.vids++; } map.set(k, r); };
  if (S.vault.by === "band") {
    for (const s of shows) for (const b of lineup(s)) bump(b, "show", s.id);
    for (const e of media) for (const b of e.it.bands||[]) bump(b, "media", e.it.type==="video");
  } else {
    for (const s of shows) bump(s.venue, "show", s.id);
    for (const e of media) bump(e.show.venue, "media", e.it.type==="video");
  }
  return [...map.values()].sort((a,b)=> b.media - a.media || b.shows.size - a.shows.size || a.name.localeCompare(b.name));
}

let VIEW_LIST = []; // entries currently shown in the vault grid, for lightbox paging

function renderVault(){
  const V = S.vault;
  let html = `<div class="vault">${statusBlock()}`;
  if (!S.loaded) { $("#view").innerHTML = html + `</div>`; return; }
  if (!V.sel) {
    const rows = vaultIndex();
    const q = V.q.trim().toLowerCase();
    const shown = q ? rows.filter(r=>r.name.toLowerCase().includes(q)) : rows;
    const totalMedia = allMedia().length;
    html += `<div class="filters" style="margin:0">
      <div class="seg big" role="group" aria-label="Browse by">
        <button data-vby="band" aria-pressed="${V.by==="band"}">By band</button>
        <button data-vby="venue" aria-pressed="${V.by==="venue"}">By venue</button>
      </div>
      <input class="search" id="vq" type="search" placeholder="Find a ${V.by}…" value="${esc(V.q)}" aria-label="Find a ${V.by}">
    </div>
    <div class="ro">${totalMedia ? `${totalMedia} item${totalMedia>1?"s":""} in the vault. ${V.by==="band" ? "Band counts include only photos tagged with that band." : "Venue counts include everything from shows there."}` : "The vault is empty. Open a show and add photos, merch or a poster — tag the band as you upload."}</div>`;
    if (!shown.length) html += `<div class="empty"><h3>No ${V.by}s match</h3></div>`;
    else html += `<div class="idx">${shown.map(r=>`<button data-vsel="${esc(r.name)}" class="${r.media?'':'none'}">
        <span class="nm">${esc(r.name)}</span><span class="ct">${r.media}</span>
        <span class="meta">${r.shows.size} show${r.shows.size!==1?"s":""}${r.vids?` · ${r.vids} video${r.vids>1?"s":""}`:""}</span></button>`).join("")}</div>`;
    $("#view").innerHTML = html + `</div>`;
    return;
  }
  // Detail: one band or venue
  const isBand = V.by === "band";
  const shows = sorted().filter(s => isBand ? lineup(s).some(b=>ieq(b,V.sel)) : ieq(s.venue, V.sel));
  const media = allMedia().filter(e => (isBand ? (e.it.bands||[]).some(b=>ieq(b,V.sel)) : ieq(e.show.venue, V.sel)));
  const filtered = media.filter(e => typeMatch(e, V.type));
  const vids = media.filter(e=>e.it.type==="video").length;
  const types = isBand ? ["all","photos","merch"] : ["all","photos","merch","posters"];
  VIEW_LIST = filtered;
  const attended = shows.filter(s=>!isUpcoming(s)).length;
  html += `<div class="vhead">
      <button class="btn ghost back" data-vback>← All ${isBand?"bands":"venues"}</button>
      <h2 class="vtitle">${esc(V.sel)}</h2>
      <div class="vsum">${isBand ? `Seen live ${attended}×` : `${attended} show${attended!==1?"s":""} here`}${shows.length>attended?` · ${shows.length-attended} upcoming`:""} · ${media.length} item${media.length!==1?"s":""}${vids?` · ${vids} video${vids>1?"s":""}`:""}</div>
    </div>
    <div class="seg" role="group" aria-label="Media type">${types.map(t=>`<button data-vtype="${t}" aria-pressed="${V.type===t}">${t}</button>`).join("")}</div>`;
  let i = 0;
  for (const s of [...shows].reverse()) {
    const here = filtered.filter(e=>e.show.id===s.id);
    const other = isBand ? lineup(s).filter(b=>!ieq(b,V.sel)) : lineup(s);
    html += `<section class="vgroup"><div class="vgh"><div style="min-width:0"><div class="d">${esc(fmtDate(s.date))}${isUpcoming(s)?` <span class="chip up">Upcoming</span>`:""}</div>
      <div class="w">${isBand ? esc([s.venue, s.city].filter(Boolean).join(" · ") || "Venue unknown") + (other.length?` · w/ ${esc(other.join(", "))}`:"") : esc(other.join(" · "))}</div></div>
      <button data-open="${esc(s.id)}">Open show →</button></div>
      ${here.length ? `<div class="gal">${here.map(e=>{ const idx = VIEW_LIST.indexOf(e); i++;
          const tag = isBand ? kindLabel(e) : ((e.it.bands||[]).join(", ") || (e.kind==="poster"?"Tour poster":""));
          return tile(e.it, { i: idx, tag, kind: isBand ? "" : kindLabel(e) }); }).join("")}</div>`
        : `<div class="vnone">${isUpcoming(s) ? "Hasn't happened yet." : media.length && V.type!=="all" ? "Nothing of this type from this night." : isBand ? "Nothing tagged with this band from this night yet." : "No media from this night yet."}</div>`}
    </section>`;
  }
  $("#view").innerHTML = html + `</div>`;
}

/* ---------- Stats tab ---------- */
function counts(arr){ const m = new Map(); for (const x of arr){ const k = String(x||"").trim(); if(!k) continue; const key = k.toLowerCase(); const cur = m.get(key) || {name:k,n:0}; cur.n++; m.set(key,cur);} return [...m.values()].sort((a,b)=>b.n-a.n||a.name.localeCompare(b.name)); }
const money = n => "$" + Math.round(n).toLocaleString();

function renderStats(){
  const all = sorted().filter(inYear), done = all.filter(s=>!isUpcoming(s)), up = all.filter(isUpcoming);
  if (!S.loaded || !all.length) { $("#view").innerHTML = `<div class="filters">${yearSeg()}</div><div class="empty" style="margin-top:16px"><h3>No stats yet</h3><div>Stats build up as shows are logged.</div></div>`; return; }
  const bands = counts(done.flatMap(lineup)), venues = counts(done.map(s=>s.venue||"")), people = counts(done.flatMap(crew));
  const miles = done.reduce((a,s)=>a+(Number(s.miles)||0),0), tix = done.reduce((a,s)=>a+(Number(s.ticket)||0),0), merch = done.reduce((a,s)=>a+(Number(s.merchSpend)||0),0);
  const rated = done.filter(s=>Number(s.rating)>0);
  const avg = rated.length ? (rated.reduce((a,s)=>a+Number(s.rating),0)/rated.length).toFixed(1) : "–";
  const media = allMedia().filter(e=>inYear(e.show)), vids = media.filter(e=>e.it.type==="video").length;
  const yr = S.year === "all" ? parse(todayISO).y : Number(S.year);
  const byM = Array(12).fill(0), byMf = Array(12).fill(0);
  for (const s of sorted()){ const p = parse(s.date); if (p.y!==yr) continue; (isUpcoming(s)?byMf:byM)[p.m-1]++; }
  const maxM = Math.max(1, ...byM.map((v,i)=>v+byMf[i]));
  const repeats = bands.filter(b=>b.n>1);
  const dates = new Set(done.map(s=>s.date));
  const backToBack = done.some(s=>{ const d = parse(s.date).dt; d.setDate(d.getDate()+1); const k = d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); return dates.has(k); });
  const badges = [
    {t:"Back-to-Back", d:"Shows on consecutive nights", on:backToBack},
    {t:"Hallowed Night", d:"A show on Halloween", on:done.some(s=>(s.date||"").slice(5)==="10-31")},
    {t:"House Regular", d:"5+ shows at one venue", on:venues.some(v=>v.name&&v.n>=5)},
    {t:"Repeat Offender", d:"Saw a band more than once", on:repeats.length>0},
    {t:"Road Dog", d:"One show 100+ mi round trip", on:done.some(s=>Number(s.miles)>=100)},
    {t:"Arena Mass", d:"Played an arena or amphitheater", on:done.some(s=>/arena|pavilion|center/i.test(s.venue||""))},
    {t:"Twenty Strong", d:"20 shows in a year", on:counts(done.map(s=>String(parse(s.date).y))).some(c=>c.n>=20)},
    {t:"Barricade Bound", d:"Logged a show on the rail", on:done.some(s=>s.spot==="Barricade")},
  ];
  const rank = (rows, max) => rows.length ? `<div class="rank">${rows.slice(0,8).map(r=>`<div class="row"><span class="n">${esc(r.name)}</span><span class="num lbl" style="color:var(--bone)">${r.n}×</span><div class="track"><i style="width:${(r.n/max*100).toFixed(1)}%"></i></div></div>`).join("")}</div>` : `<div class="ro">Nothing logged yet.</div>`;
  $("#view").innerHTML = `<div class="filters">${yearSeg()}</div><div class="stats" style="margin-top:0">
    <div class="tiles">
      <div class="tile"><div class="lbl">Shows attended</div><div class="v num">${done.length}</div></div>
      <div class="tile"><div class="lbl">Still to come</div><div class="v num">${up.length}</div></div>
      <div class="tile"><div class="lbl">Bands seen</div><div class="v num">${bands.length}</div></div>
      <div class="tile"><div class="lbl">Venues</div><div class="v num">${venues.filter(v=>v.name).length}</div></div>
      <div class="tile"><div class="lbl">Est. miles driven</div><div class="v num">${Math.round(miles).toLocaleString()}</div></div>
      <div class="tile"><div class="lbl">Avg rating</div><div class="v num">${avg}<small>/5</small></div></div>
      <div class="tile"><div class="lbl">Tickets</div><div class="v num">${tix?money(tix):"–"}</div></div>
      <div class="tile"><div class="lbl">Merch haul</div><div class="v num">${merch?money(merch):"–"}</div></div>
      <div class="tile"><div class="lbl">Vault items</div><div class="v num">${media.length}${vids?`<small> · ${vids} vid</small>`:""}</div></div>
    </div>
    <section><h2>${yr} by month</h2>
      <div class="bars">${byM.map((v,i)=>{const f=byMf[i]; const t=v+f; return `<div class="bar">${t?`<span>${t}</span>`:""}${f?`<i class="fut" style="height:${f/maxM*100}%"></i>`:""}<i style="height:${v/maxM*100}%"></i></div>`}).join("")}</div>
      <div class="barx">${MONTHS.map(m=>`<span>${m[0]}</span>`).join("")}</div>
      <div class="ro" style="margin-top:6px">Solid = attended · hatched = upcoming</div>
    </section>
    <div class="two">
      <section><h2>Venues</h2>${rank(venues.filter(v=>v.name), venues[0]?.n||1)}</section>
      <section><h2>Repeat offenders</h2>${rank(repeats, repeats[0]?.n||1)}</section>
    </div>
    <section><h2>The crew</h2>${people.length ? rank(people, people[0].n) : `<div class="ro">Add who you went with on each show and the crew leaderboard fills in.</div>`}</section>
    <section><h2>Patches earned</h2><div class="badges">${badges.map(b=>`<div class="badge ${b.on?'on':'off'}"><div class="t">${esc(b.t)}</div><div class="d">${esc(b.d)}</div></div>`).join("")}</div></section>
  </div>`;
}

/* ---------- Calendar tab ---------- */
const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function renderCal(){
  if (!S.loaded) { $("#view").innerHTML = `<div class="calwrap">${statusBlock()}</div>`; return; }
  const { y, m } = S.cal;
  const key = (dd) => y+"-"+String(m+1).padStart(2,"0")+"-"+String(dd).padStart(2,"0");
  const byDate = {}; for (const s of sorted()) (byDate[s.date] = byDate[s.date] || []).push(s);
  const first = new Date(y, m, 1).getDay(), dim = new Date(y, m+1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(`<div class="day out" aria-hidden="true"></div>`);
  for (let d = 1; d <= dim; d++) {
    const k = key(d), list = byDate[k] || [], today = k === todayISO;
    if (!list.length) { cells.push(`<div class="day${today?" today":""}"><span class="dn">${d}</span></div>`); continue; }
    const s = list[0], up = isUpcoming(s);
    cells.push(`<button class="day has${up?" up":""}${today?" today":""}" data-open="${esc(s.id)}" aria-label="${esc(fmtDate(k))}: ${esc(list.map(x=>lineup(x)[0]).join(", "))}">
      <span class="dn">${d}</span><span class="sk">${SKULLC(up ? "var(--rust)" : "var(--bone)")}</span>
      <span class="hl">${esc(lineup(s)[0]||"Show")}${list.length>1?` +${list.length-1}`:""}</span></button>`);
  }
  while (cells.length % 7) cells.push(`<div class="day out" aria-hidden="true"></div>`);
  const mc = Array(12).fill(0); for (const s of S.shows) { const p = parse(s.date); if (p.y === y) mc[p.m-1]++; }
  const inMonth = sorted().filter(s => { const p = parse(s.date); return p.y === y && p.m === m+1; });
  const yrs = years(); if (!yrs.includes(y)) yrs.push(y);
  $("#view").innerHTML = `<div class="calwrap">
    <div class="filters" style="margin:0"><div class="seg" role="group" aria-label="Year">${yrs.sort((a,b)=>b-a).map(yy=>`<button data-caly="${yy}" aria-pressed="${yy===y}">${yy}</button>`).join("")}</div>
      <button class="btn ghost" data-caltoday>Today</button></div>
    <div class="mstrip" role="group" aria-label="Months of ${y}">${MONTHS.map((mn,i)=>`<button data-calm="${i}" aria-pressed="${i===m}" aria-label="${MONTHS_LONG[i]}: ${mc[i]} show${mc[i]!==1?"s":""}"><span class="ml">${mn[0]}</span><span class="mc ${mc[i]?"":"z"}">${mc[i]||"·"}</span></button>`).join("")}</div>
    <div class="calnav"><button class="arw" data-calnav="-1" aria-label="Previous month">‹</button>
      <div class="mt-title">${MONTHS_LONG[m]} <span style="color:var(--ash)">${y}</span></div>
      <button class="arw" data-calnav="1" aria-label="Next month">›</button></div>
    <div class="cal">${DAYS.map(d=>`<div class="dow">${d.slice(0,2)}</div>`).join("")}${cells.join("")}</div>
    ${inMonth.length ? `<div class="mlist">${inMonth.map(s=>{ const p = parse(s.date), lu = lineup(s);
        return `<button data-open="${esc(s.id)}" class="${isUpcoming(s)?"up":""}"><span class="dd num">${p.d}</span><span style="min-width:0"><div class="t1">${esc(lu[0]||"Show")}${isUpcoming(s)?` <span class="chip up">Upcoming</span>`:""}</div><div class="t2">${esc([lu.slice(1).join(" · "), s.venue].filter(Boolean).join(" — ") || "Venue unknown")}</div></span></button>`; }).join("")}</div>`
      : `<div class="empty"><h3>Silent month</h3><div>No shows logged in ${MONTHS_LONG[m]} ${y}.</div></div>`}
  </div>`;
}

function renderTab(){
  for (const t of ["shows","cal","vault","stats","crew"]) $("#tab-"+t).setAttribute("aria-selected", S.tab===t);
  if (S.tab === "crew") renderCrew(); else if (S.tab === "shows") renderShows(); else if (S.tab === "cal") renderCal(); else if (S.tab === "vault") renderVault(); else renderStats();
}
function render(){ renderNext(); renderTab(); if (S.open) renderSheet(); }

/* ---------- Detail sheet ---------- */
let draft = null, confirmDel = false, busy = false;
let SHEET_LIST = [];

function openSheet(id){
  S.openFriend = null;
  const s = id === "__new" ? { id:"__new", date: todayISO, lineup: [], wentWith: [], photos: [], merch: [] } : S.shows.find(x=>x.id===id);
  if (!s) return;
  closeLightbox();
  S.open = id; draft = JSON.parse(JSON.stringify(s)); confirmDel = false;
  renderSheet(true);
  document.body.style.overflow = "hidden";
}
function closeSheet(){ S.open = null; S.openFriend = null; draft = null; $("#sheetRoot").innerHTML = ""; document.body.style.overflow = ""; renderTab(); }

function gallery(kind, label, hint){
  const its = items(draft, kind);
  const base = SHEET_LIST.length;
  for (const it of its) SHEET_LIST.push({ it, show: draft, kind });
  return `<div class="sect"><h3>${label} <span class="lbl">${its.length}</span></h3>
    ${hint ? `<div class="ro">${hint}</div>` : ""}
    <div class="gal">${its.map((it,i)=>tile(it, { i: base+i, tag: (it.bands||[]).join(", ") })).join("")}
    ${assets && !S.openFriend && draft.id!=="__new" ? `<label class="upl">+ Add<input class="vh" type="file" multiple data-upkind="${kind}" accept="${kind==="photos" ? ACCEPT_MEDIA : "image/*"}" aria-label="Add ${kind}"></label>` : ""}</div>
    ${S.openFriend ? "" : draft.id==="__new" ? `<div class="ro">Save the show first, then add media.</div>` : ""}
  </div>`;
}

function renderSheet(fresh){
  const d = draft; if (!d) return;
  const isNew = d.id === "__new", up = d.date > todayISO, ro = !S.canWrite || !!S.openFriend;
  const scroll = $("#sheetRoot .sheet")?.scrollTop || 0;
  SHEET_LIST = [];
  if (d.poster) SHEET_LIST.push({ it: { id: pid(d.poster), url: pid(d.poster), path: d.poster.path, type: "image", bands: [] }, show: d, kind: "poster" });
  const media = gallery("photos", "Show photos") + gallery("merch", "Merch haul");
  $("#sheetRoot").innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Show details"><div class="panel">
    <div class="ptop"><button class="btn ghost" data-close>← Back</button>
      ${ro ? `<span class="ro">${S.openFriend ? esc((FR[S.openFriend]?.name || "Friend") + "'s show · read-only") : "Read-only"}</span>` : `<button class="btn red" data-save ${busy?"disabled":""}>${isNew?"Add show":"Save"}</button>`}</div>
    <div class="ptitle">${esc(lineup(d)[0] || "New show")}</div>
    <div class="psub">${esc([d.venue, d.city].filter(Boolean).join(" · "))}${d.date?` · ${esc(new Date(parse(d.date).dt).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric",year:"numeric"}))}`:""}</div>

    <div class="sect"><h3>The bill</h3>
      <div class="grid2">
        <label class="field"><span class="lbl">Date</span><input id="f-date" type="date" value="${esc(d.date)}" ${ro?"disabled":""}></label>
        <label class="field"><span class="lbl">Tour name</span><input id="f-tour" value="${esc(d.tour||"")}" placeholder="Name of the tour" ${ro?"disabled":""}></label>
      </div>
      <label class="field"><span class="lbl">Lineup — headliner first, comma separated</span><input id="f-lineup" value="${esc(lineup(d).join(", "))}" ${ro?"disabled":""}></label>
      <div class="grid2">
        <label class="field"><span class="lbl">Venue</span><input id="f-venue" value="${esc(d.venue||"")}" ${ro?"disabled":""}></label>
        <label class="field"><span class="lbl">City</span><input id="f-city" value="${esc(d.city||"")}" ${ro?"disabled":""}></label>
      </div>
      <label style="display:flex;gap:8px;align-items:center"><input id="f-unsure" type="checkbox" ${d.unsure?"checked":""} ${ro?"disabled":""}> <span class="lbl">Not confirmed / maybe</span></label>
    </div>

    <div class="sect"><h3>Went with</h3>
      <label class="field"><span class="lbl">Names, comma separated</span><input id="f-crew" value="${esc(crew(d).join(", "))}" placeholder="Who was in your crew?" ${ro?"disabled":""}></label>
    </div>

    <div class="sect"><h3>The night ${up?`<span class="chip up">Upcoming</span>`:""}</h3>
      <div class="grid2">
        <div class="field"><span class="lbl">Rating</span><div class="picker" role="group" aria-label="Rating">${[1,2,3,4,5].map(i=>`<button data-rate="${i}" aria-pressed="${(Number(d.rating)||0)>=i}" aria-label="${i} skull${i>1?'s':''}" ${ro?"disabled":""}>${SKULL((Number(d.rating)||0)>=i)}</button>`).join("")}</div></div>
        <div class="field"><span class="lbl">Pit intensity</span><div class="picker meter" role="group" aria-label="Pit intensity">${[1,2,3,4,5].map(i=>`<button data-pit="${i}" aria-pressed="${(Number(d.pit)||0)>=i}" aria-label="Level ${i}" ${ro?"disabled":""}><i style="background:${(Number(d.pit)||0)>=i?`color-mix(in srgb, var(--blood) ${40+i*12}%, var(--rust))`:'var(--slab)'}"></i></button>`).join("")}</div></div>
      </div>
      <div class="grid2">
        <label class="field"><span class="lbl">Where you stood</span><select id="f-spot" ${ro?"disabled":""}>${SPOTS.map(o=>`<option value="${esc(o)}" ${d.spot===o?"selected":""}>${o||"—"}</option>`).join("")}</select></label>
        <label class="field"><span class="lbl">Best band of the night</span><select id="f-best" ${ro?"disabled":""}><option value="">—</option>${lineup(d).map(b=>`<option ${d.best===b?"selected":""}>${esc(b)}</option>`).join("")}</select></label>
      </div>
      <label class="field"><span class="lbl">Highlight moment</span><input id="f-highlight" value="${esc(d.highlight||"")}" placeholder="Wall of death during…" ${ro?"disabled":""}></label>
      <label class="field"><span class="lbl">Setlist notes</span><textarea id="f-setlist" placeholder="Opened with… closed with…" ${ro?"disabled":""}>${esc(d.setlist||"")}</textarea></label>
      <label class="field"><span class="lbl">Notes</span><textarea id="f-notes" ${ro?"disabled":""}>${esc(d.notes||"")}</textarea></label>
      <div class="grid2">
        <label class="field"><span class="lbl">Ticket $</span><input id="f-ticket" type="number" min="0" step="1" inputmode="decimal" value="${esc(d.ticket??"")}" ${ro?"disabled":""}></label>
        <label class="field"><span class="lbl">Merch $</span><input id="f-merchSpend" type="number" min="0" step="1" inputmode="decimal" value="${esc(d.merchSpend??"")}" ${ro?"disabled":""}></label>
        <label class="field"><span class="lbl">Round-trip miles (est.)</span><input id="f-miles" type="number" min="0" step="1" value="${esc(d.miles??"")}" ${ro?"disabled":""}></label>
      </div>
    </div>

    <div class="sect"><h3>Tour poster</h3>
      <div class="poster">
        ${d.poster ? `<button class="posterbox" data-lbi="0" aria-label="View poster"><img src="${src(pid(d.poster))}" alt="Tour poster"></button>`
          : `<div class="posterbox"><span class="lbl">No poster yet</span></div>`}
        <div class="ro">${S.openFriend ? "" : assets && !isNew ? `<label class="btn">${d.poster?"Replace poster":"Upload poster"}<input class="vh" type="file" data-upkind="poster" accept="image/*" aria-label="Upload poster"></label>` : isNew ? "Save the show first, then add a poster." : ""}</div>
      </div>
    </div>
    ${media}

    ${!isNew && !ro ? `<div class="sect"><div><button class="btn warn" data-del>${confirmDel?"Tap again to delete this show":"Delete show"}</button></div></div>` : ""}
  </div></div>`;
  const sh = $("#sheetRoot .sheet"); if (sh && !fresh) sh.scrollTop = scroll;
}

function readForm(){
  if (!$("#f-date")) return;
  const v = id => $("#"+id)?.value ?? "";
  const list = s => s.split(",").map(x=>x.trim()).filter(Boolean);
  const n = s => s === "" ? null : Number(s);
  Object.assign(draft, {
    date: v("f-date"), tour: v("f-tour").trim(), lineup: list(v("f-lineup")), venue: v("f-venue").trim(), city: v("f-city").trim(),
    unsure: !!$("#f-unsure")?.checked, wentWith: list(v("f-crew")), spot: v("f-spot"), best: v("f-best"),
    highlight: v("f-highlight").trim(), setlist: v("f-setlist"), notes: v("f-notes"),
    ticket: n(v("f-ticket")), merchSpend: n(v("f-merchSpend")), miles: n(v("f-miles")),
  });
}

async function save(){
  if (!db || busy) return;
  readForm();
  if (!draft.date || !lineup(draft).length) { toast("Add a date and at least one band"); return; }
  busy = true; renderSheet();
  const body = {...draft}; delete body.id;
  try {
    if (draft.id === "__new") { const ref = await addDoc(myShows(), body); draft.id = ref.id; S.open = ref.id; toast("Show added"); }
    else { await setDoc(myShow(draft.id), body); toast("Saved"); }
  } catch(e){ handleWriteErr(e); }
  busy = false; renderSheet();
}

function handleWriteErr(e){
  console.error(e);
  if (e && e.code === "permission-denied") toast("Not allowed — check the Firestore rules are published", 4000);
  else if (e && e.code === "unavailable") toast("You're offline — it'll sync when you reconnect", 3500);
  else toast("Couldn't save — try again");
}

async function del(){
  if (!confirmDel) { confirmDel = true; renderSheet(); return; }
  const s = S.shows.find(x=>x.id===draft.id); if (!s) return;
  try { await deleteDoc(myShow(s.id)); } catch(e){ handleWriteErr(e); return; }
  for (const p of [s.poster && s.poster.path, ...items(s,"photos").map(m=>m.path), ...items(s,"merch").map(m=>m.path)].filter(Boolean)) await removeFile(p);
  closeSheet(); toast("Show deleted");
}

/* ---------- Uploads ---------- */
async function compress(file){
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 1800, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth*sc); c.height = Math.round(img.naturalHeight*sc);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.86));
    return blob && blob.size < file.size ? blob : file;
  } catch(_) { return file; }
}

function isVideo(f){ return /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm)$/i.test(f.name||""); }
function videoType(f){ return (f.type === "video/webm" || /\.webm$/i.test(f.name||"")) ? "video/webm" : "video/mp4"; }

const ACCEPT_MEDIA = "image/*";
function handleFiles(kind, files){
  if (!draft || !assets) return;
  const vids = files.filter(isVideo).length;
  files = files.filter(f => !isVideo(f));
  if (!files.length) { toast(vids ? "Videos aren't supported — photos only" : "No photos selected", 3500); return; }
  toast(`${files.length} photo${files.length>1?"s":""} ready${vids?` (skipped ${vids} video${vids>1?"s":""})`:""}`, 2500);
  const lu = lineup(draft);
  if (kind === "poster" || !lu.length) return doUpload(kind, files, []);
  tagModal(files, lu, (bands) => doUpload(kind, files, bands));
}

function tagModal(files, lu, onGo){
  const sel = new Set(lu.length === 1 ? [lu[0]] : []);
  const vids = files.filter(isVideo).length, imgs = files.length - vids;
  const draw = () => {
    $("#modalRoot").innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Tag bands"><div class="mbox">
      <h3>Who's in ${files.length>1?"these":"this"}?</h3>
      <div class="ro">${files.length} photo${files.length>1?"s":""}. Tag every band that appears. Leave all off for crowd or venue shots.</div>
      <div class="tagrow">${lu.map(b=>`<button class="tagbtn" data-mtag="${esc(b)}" aria-pressed="${sel.has(b)}">${esc(b)}</button>`).join("")}</div>
      <div class="mbtns"><button class="btn ghost" data-mcancel>Cancel</button><button class="btn red" data-mgo>Upload</button></div>
    </div></div>`;
    const root = $("#modalRoot");
    root.querySelectorAll("[data-mtag]").forEach(b => b.onclick = () => { const v = b.dataset.mtag; sel.has(v) ? sel.delete(v) : sel.add(v); draw(); });
    root.querySelector("[data-mcancel]").onclick = () => root.innerHTML = "";
    root.querySelector("[data-mgo]").onclick = () => { root.innerHTML = ""; onGo([...sel]); };
  };
  draw();
}

async function doUpload(kind, files, bands){
  const showId = draft && draft.id; if (!showId || showId === "__new") return;
  const out = []; let skipped = 0, n = 0;
  for (const f of files) {
    n++;
    toast(`Uploading ${n} of ${files.length}…`, 60000);
    try {
      const b = await compress(f);
      if (b.size > MAX_BYTES) { skipped++; continue; }
      const r = await putImage(b, showId, kind);
      out.push({ url: r.url, path: r.path, type: "image", bands });
    } catch(e){
      skipped++;
      console.error(e);
      if (e?.code === "storage/unauthorized") { toast("Upload blocked — check the Storage rules are published", 5000); break; }
      if (e?.code === "storage/quota-exceeded") { toast("Storage quota reached", 4000); break; }
    }
  }
  if (!out.length) { toast(skipped ? "Nothing uploaded. Use JPG, PNG, WEBP or GIF photos under 20 MB." : "Nothing uploaded", 5000); return; }
  const s = S.shows.find(x=>x.id===showId); if (!s) return;
  const old = s.poster;
  const patch = kind === "poster" ? { poster: { url: out[0].url, path: out[0].path } } : { [kind]: [...items(s,kind), ...out] };
  try {
    await updateDoc(myShow(s.id), patch); if (draft && draft.id === s.id) { Object.assign(draft, patch); renderSheet(); }
    toast(skipped ? `Added ${out.length}. Skipped ${skipped} that couldn't upload.` : `Added ${out.length}`, skipped ? 5000 : 2400);
    if (kind === "poster" && old && old.path) await removeFile(old.path);
  } catch(e){ handleWriteErr(e); }
}

/* ---------- Lightbox ---------- */
let LB = null; // { list, i, confirm }
function closeLightbox(){ LB = null; $("#lbRoot").innerHTML = ""; }
function openLightbox(list, i){ if (!list[i]) return; LB = { list, i, confirm: false }; drawLB(); }

function drawLB(){
  if (!LB) return;
  const e = LB.list[LB.i]; if (!e) { closeLightbox(); return; }
  const s = (S.openFriend ? null : S.shows.find(x=>x.id===e.show.id)) || e.show;
  const canEdit = !!assets && S.canWrite && !S.openFriend;
  const tagEditable = canEdit && e.kind !== "poster";
  const lu = lineup(s), bands = e.it.bands || [];
  const media = e.it.type === "video"
    ? `<video src="${src(e.it.id)}" controls playsinline preload="metadata"></video>`
    : `<img src="${src(e.it.id)}" alt="">`;
  $("#lbRoot").innerHTML = `<div class="lightbox" role="dialog" aria-modal="true" aria-label="Media viewer">
    <div class="lt"><button class="btn ghost" data-lbclose>Close</button>
      <span class="lbl num">${LB.i+1} / ${LB.list.length}</span>
      <span style="display:flex;gap:8px">${!S.open && !S.crewSel ? `<button class="btn" data-lbshow>Open show</button>` : ""}
      ${canEdit ? `<button class="btn warn" data-lbdel>${LB.confirm?"Tap again to remove":"Remove"}</button>` : ""}</span></div>
    <div class="lbimg">${media}
      ${LB.i>0?`<button class="lbnav p" data-lbprev aria-label="Previous">‹</button>`:""}
      ${LB.i<LB.list.length-1?`<button class="lbnav n" data-lbnext aria-label="Next">›</button>`:""}</div>
    <div class="lbcap">
      <div class="c1">${esc(e.kind==="poster" ? "Tour poster · " + (lu[0]||"") : bands.length ? bands.join(" · ") : (lu[0] || "Show"))}</div>
      <div class="c2">${esc([kindLabel(e), fmtDate(s.date), s.venue].filter(Boolean).join(" · "))}</div>
      ${tagEditable && lu.length ? `<div class="tagrow"><span class="lbl">Tag:</span>${lu.map(b=>`<button class="tagbtn" data-lbtag="${esc(b)}" aria-pressed="${bands.some(x=>ieq(x,b))}">${esc(b)}</button>`).join("")}</div>` : ""}
    </div></div>`;
}

async function retag(band){
  const e = LB.list[LB.i]; const s = S.shows.find(x=>x.id===e.show.id); if (!s) return;
  const cur = e.it.bands || [];
  const next = cur.some(x=>ieq(x,band)) ? cur.filter(x=>!ieq(x,band)) : [...cur, band];
  const arr = items(s, e.kind).map(m => m.id === e.it.id ? { ...m, bands: next } : m);
  try { await updateDoc(myShow(s.id), { [e.kind]: arr }); e.it = { ...e.it, bands: next }; if (draft && draft.id === s.id) draft[e.kind] = arr; drawLB(); }
  catch(err){ handleWriteErr(err); }
}

async function lbRemove(){
  if (!LB.confirm) { LB.confirm = true; drawLB(); return; }
  const e = LB.list[LB.i]; const s = S.shows.find(x=>x.id===e.show.id); if (!s) return;
  const patch = e.kind === "poster" ? { poster: null } : { [e.kind]: items(s, e.kind).filter(m => m.id !== e.it.id) };
  try {
    await updateDoc(myShow(s.id), patch);
    await removeFile(e.it.path);
    if (draft && draft.id === s.id) Object.assign(draft, patch);
    LB.list.splice(LB.i, 1); LB.confirm = false;
    if (!LB.list.length) closeLightbox(); else { LB.i = Math.min(LB.i, LB.list.length-1); drawLB(); }
    if (S.open) renderSheet(); toast("Removed");
  } catch(err){ handleWriteErr(err); }
}

/* ---------- Events ---------- */
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  const inLB = !!t.closest("#lbRoot"), inModal = !!t.closest("#modalRoot");
  if (inModal) return;
  if (inLB) {
    if (t.hasAttribute("data-lbclose")) closeLightbox();
    else if (t.hasAttribute("data-lbprev")) { LB.i--; LB.confirm=false; drawLB(); }
    else if (t.hasAttribute("data-lbnext")) { LB.i++; LB.confirm=false; drawLB(); }
    else if (t.hasAttribute("data-lbdel")) lbRemove();
    else if (t.hasAttribute("data-lbshow")) { const id = LB.list[LB.i].show.id; openSheet(id); }
    else if (t.dataset.lbtag) retag(t.dataset.lbtag);
    return;
  }
  if (t.id === "tab-shows") { S.tab = "shows"; renderTab(); }
  else if (t.id === "tab-vault") { S.tab = "vault"; renderTab(); }
  else if (t.id === "tab-cal") { S.tab = "cal"; renderTab(); }
  else if (t.dataset.year) { S.year = t.dataset.year; renderTab(); }
  else if (t.dataset.caly) { S.cal.y = Number(t.dataset.caly); renderCal(); }
  else if (t.dataset.calm) { S.cal.m = Number(t.dataset.calm); renderCal(); }
  else if (t.dataset.calnav) { let m = S.cal.m + Number(t.dataset.calnav), y = S.cal.y; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } S.cal = { y, m }; renderCal(); }
  else if (t.hasAttribute("data-caltoday")) { const d = new Date(); S.cal = { y: d.getFullYear(), m: d.getMonth() }; renderCal(); }
  else if (t.id === "tab-stats") { S.tab = "stats"; renderTab(); }
  else if (t.id === "addBtn") openSheet("__new");
  else if (t.dataset.filter) { S.filter = t.dataset.filter; renderShows(); }
  else if (t.dataset.vby) { S.vault.by = t.dataset.vby; S.vault.q = ""; renderVault(); }
  else if (t.dataset.vsel) { S.vault.sel = t.dataset.vsel; S.vault.type = "all"; renderVault(); window.scrollTo(0, $("nav.tabs").offsetTop); }
  else if (t.hasAttribute("data-vback")) { S.vault.sel = null; renderVault(); }
  else if (t.dataset.vtype) { S.vault.type = t.dataset.vtype; renderVault(); }
  else if (t.dataset.open) openSheet(t.dataset.open);
  else if (t.dataset.fopen) { const [u, id] = t.dataset.fopen.split("|"); openFriendSheet(u, id); }
  else if (t.id === "tab-crew") { if (S.tab === "crew") S.crewSel = null; S.tab = "crew"; renderTab(); }
  else if (t.id === "acct") accountMenu();
  else if (crewClick(t)) {}
  else if (t.hasAttribute("data-close")) closeSheet();
  else if (t.hasAttribute("data-save")) save();
  else if (t.hasAttribute("data-del")) del();
  else if (t.dataset.rate) { readForm(); const v = Number(t.dataset.rate); draft.rating = draft.rating === v ? 0 : v; renderSheet(); }
  else if (t.dataset.pit) { readForm(); const v = Number(t.dataset.pit); draft.pit = draft.pit === v ? 0 : v; renderSheet(); }
  else if (t.dataset.lbi !== undefined) { if (S.open) { readForm(); openLightbox(SHEET_LIST, Number(t.dataset.lbi)); } else openLightbox(VIEW_LIST, Number(t.dataset.lbi)); }
});
function keepFocus(id, fn){ const el = $("#"+id); const pos = el.selectionStart; fn(); const n = $("#"+id); if (n) { n.focus(); try{n.setSelectionRange(pos,pos);}catch(_){} } }
document.addEventListener("input", e => {
  if (e.target.id === "q") { S.q = e.target.value; keepFocus("q", renderShows); }
  else if (e.target.id === "vq") { S.vault.q = e.target.value; keepFocus("vq", renderVault); }
});
document.addEventListener("change", e => {
  if (e.target.id === "sort") { S.sort = e.target.value; try { localStorage.setItem("pitlog.sort", S.sort); } catch(_){} renderShows(); return; }
  const up = e.target.dataset && e.target.dataset.upkind;
  if (up) { const files = [...(e.target.files || [])]; e.target.value = ""; readForm(); handleFiles(up, files); return; }
  if (e.target.id === "f-lineup" && draft) { readForm(); renderSheet(); }
  if (e.target.id === "importFile") { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) importFile(f); }
});
document.addEventListener("keydown", e => {
  if ($("#modalRoot").innerHTML) { if (e.key === "Escape") $("#modalRoot").innerHTML = ""; return; }
  if (LB) {
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft" && LB.i > 0) { LB.i--; LB.confirm=false; drawLB(); }
    else if (e.key === "ArrowRight" && LB.i < LB.list.length-1) { LB.i++; LB.confirm=false; drawLB(); }
    return;
  }
  if (e.key === "Escape" && S.open) closeSheet();
});
// Swipe between items in the viewer
let tx = null;
document.addEventListener("touchstart", e => { if (LB && e.target.closest(".lbimg") && !e.target.closest("video")) tx = e.touches[0].clientX; }, { passive: true });
document.addEventListener("touchend", e => { if (tx === null || !LB) return; const dx = e.changedTouches[0].clientX - tx; tx = null;
  if (dx > 50 && LB.i > 0) { LB.i--; LB.confirm=false; drawLB(); } else if (dx < -50 && LB.i < LB.list.length-1) { LB.i++; LB.confirm=false; drawLB(); } }, { passive: true });


/* ---------- Firebase helpers ---------- */
const myShows = () => collection(fdb, "users", ME.uid, "shows");
const myShow = id => doc(fdb, "users", ME.uid, "shows", id);
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function putImage(blob, showId, kind){
  const ext = /png/.test(blob.type) ? "png" : /webp/.test(blob.type) ? "webp" : /gif/.test(blob.type) ? "gif" : "jpg";
  const path = `users/${ME.uid}/shows/${showId}/${kind}-${rid()}.${ext}`;
  const r = sref(storage, path);
  await uploadBytes(r, blob, { contentType: blob.type || "image/jpeg", cacheControl: "public,max-age=31536000" });
  return { path, url: await getDownloadURL(r) };
}
async function removeFile(path){ if (!path) return; try { await deleteObject(sref(storage, path)); } catch (_) {} }

/* ---------- Friends: matching ---------- */
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const friendList = () => Object.values(FR).sort((a,b) => (a.name||"").localeCompare(b.name||""));
function sameShow(a, b){
  if (!a.date || a.date !== b.date) return false;
  if (a.venue && b.venue && ieq(a.venue, b.venue)) return true;
  return lineup(a).some(x => lineup(b).some(y => ieq(x, y)));
}
const togetherWith = s => friendList().filter(f => (f.shows||[]).some(o => sameShow(s, o)));
function togetherChips(s, opts){
  if (opts && opts.friend) return S.shows.some(o => sameShow(s, o)) ? `<span class="chip tog">You were there</span>` : "";
  return togetherWith(s).map(f => `<span class="chip tog">w/ @${esc(f.handle)}</span>`).join("");
}

function openFriendSheet(uid, id){
  const f = FR[uid]; const s = f && (f.shows||[]).find(x => x.id === id); if (!s) return;
  closeLightbox();
  S.open = id; S.openFriend = uid; draft = JSON.parse(JSON.stringify(s)); confirmDel = false;
  renderSheet(true); document.body.style.overflow = "hidden";
}

/* ---------- Friends: data ---------- */
let UNSUBS = [];
function watchFriend(uid, info){
  if (FR[uid]) { Object.assign(FR[uid], info); return; }
  const f = FR[uid] = { uid, shows: [], loaded: false, err: "", ...info };
  f.unsub = onSnapshot(collection(fdb, "users", uid, "shows"), snap => {
    f.shows = snap.docs.map(d => ({ id: d.id, ...d.data() })); f.loaded = true; f.err = "";
    rerenderSoft();
  }, err => { f.err = err.code === "permission-denied" ? "Their log isn't shared with you yet." : "Couldn't load their log."; f.loaded = true; rerenderSoft(); });
  getDoc(doc(fdb, "users", uid)).then(p => { if (p.exists()) { const d = p.data(); Object.assign(f, { name: d.name || f.name, handle: d.handle || f.handle, photo: d.photoURL || f.photo }); rerenderSoft(); } }).catch(()=>{});
}
function dropFriend(uid){ const f = FR[uid]; if (!f) return; try { f.unsub && f.unsub(); } catch(_){} delete FR[uid]; }

function syncFriends(){
  const keep = new Set();
  for (const r of REQ.in.concat(REQ.out)) {
    if (r.status !== "accepted") continue;
    const other = r.from === ME.uid ? { uid: r.to, name: r.toName, handle: r.toHandle, photo: r.toPhoto } : { uid: r.from, name: r.fromName, handle: r.fromHandle, photo: r.fromPhoto };
    keep.add(other.uid); watchFriend(other.uid, other);
  }
  for (const uid of Object.keys(FR)) if (!keep.has(uid)) dropFriend(uid);
  rerenderSoft();
}
function rerenderSoft(){ if (S.open || LB || $("#modalRoot").innerHTML) return; if (S.tab === "crew" || S.tab === "shows") renderTab(); }

async function sendRequest(raw){
  const h = String(raw||"").trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE_RE.test(h)) { toast("Usernames are 3–20 letters, numbers or _"); return; }
  if (h === PROFILE.handle) { toast("That's you"); return; }
  try {
    const hs = await getDoc(doc(fdb, "handles", h));
    if (!hs.exists()) { toast(`No one is using @${h} yet`); return; }
    const uid = hs.data().uid;
    if (FR[uid]) { toast(`You're already connected with @${h}`); return; }
    if (REQ.out.some(r => r.to === uid)) { toast(`Request to @${h} is already waiting`); return; }
    const back = REQ.in.find(r => r.from === uid);
    if (back) { await acceptRequest(back); return; }
    const ps = await getDoc(doc(fdb, "users", uid)); const p = ps.exists() ? ps.data() : {};
    await setDoc(doc(fdb, "friendRequests", ME.uid + "_" + uid), {
      from: ME.uid, to: uid, status: "pending", createdAt: serverTimestamp(),
      fromName: PROFILE.name || "", fromHandle: PROFILE.handle, fromPhoto: PROFILE.photoURL || "",
      toName: p.name || "", toHandle: p.handle || h, toPhoto: p.photoURL || ""
    });
    S.crewAdd = ""; toast(`Request sent to @${h}`);
  } catch (e) { handleWriteErr(e); }
}
async function acceptRequest(r){
  try { await updateDoc(doc(fdb, "friendRequests", r.id), { status: "accepted", acceptedAt: serverTimestamp() }); toast(`You and @${r.fromHandle} are connected`); }
  catch (e) { handleWriteErr(e); }
}
async function removeRequest(id, msg){ try { await deleteDoc(doc(fdb, "friendRequests", id)); if (msg) toast(msg); } catch (e) { handleWriteErr(e); } }

/* ---------- Crew tab ---------- */
const avatar = (p, name, cls) => p ? `<img class="av ${cls||""}" src="${esc(p)}" alt="" referrerpolicy="no-referrer">` : `<span class="av ${cls||""}">${esc((name||"?").trim().charAt(0).toUpperCase())}</span>`;

function renderCrew(){
  if (S.crewSel && FR[S.crewSel]) return renderFriend(FR[S.crewSel]);
  S.crewSel = null;
  const inc = REQ.in.filter(r => r.status === "pending"), out = REQ.out.filter(r => r.status === "pending");
  const fl = friendList();
  let html = `<div class="crew">
    <section class="me-card">${avatar(PROFILE.photoURL, PROFILE.name, "lg")}
      <div style="min-width:0"><div class="nm">${esc(PROFILE.name || "You")}</div><div class="hd">@${esc(PROFILE.handle)}</div>
      <div class="ro">Friends add you with this username.</div></div>
      <button class="btn" data-copyhandle>Copy</button></section>
    <section class="sect" style="margin-top:0"><h3>Add a friend</h3>
      <form class="addrow" id="addForm" autocomplete="off"><input class="search" id="addHandle" placeholder="@username" value="${esc(S.crewAdd||"")}" autocapitalize="none" spellcheck="false" aria-label="Friend's username"><button class="btn red" type="submit">Send</button></form></section>`;
  if (inc.length) html += `<section class="sect"><h3>Requests <span class="lbl">${inc.length}</span></h3><div class="plist">${inc.map(r => `
      <div class="prow">${avatar(r.fromPhoto, r.fromName)}<div class="pt"><div class="nm">${esc(r.fromName || r.fromHandle)}</div><div class="hd">@${esc(r.fromHandle)}</div></div>
      <button class="btn red" data-accept="${esc(r.id)}">Accept</button><button class="btn ghost" data-decline="${esc(r.id)}">Decline</button></div>`).join("")}</div></section>`;
  html += `<section class="sect"><h3>The crew <span class="lbl">${fl.length}</span></h3>`;
  if (!fl.length) html += `<div class="empty"><h3>No crew yet</h3><div>Send a friend your username, or add theirs above. Once they accept, you can see each other's shows and the ones you hit together.</div></div>`;
  else html += `<div class="plist">${fl.map(f => { const tog = S.shows.filter(s => (f.shows||[]).some(o => sameShow(s,o))).length;
      return `<button class="prow tap" data-friend="${esc(f.uid)}">${avatar(f.photo, f.name)}<div class="pt"><div class="nm">${esc(f.name || f.handle)}</div><div class="hd">@${esc(f.handle)}</div>
        <div class="ro">${f.err ? esc(f.err) : !f.loaded ? "Loading…" : `${f.shows.filter(s=>!isUpcoming(s)).length} shows · ${tog} together`}</div></div><span class="ct">${tog || ""}</span></button>`; }).join("")}</div>`;
  html += `</section>`;
  if (out.length) html += `<section class="sect"><h3>Sent</h3><div class="plist">${out.map(r => `
      <div class="prow">${avatar(r.toPhoto, r.toName)}<div class="pt"><div class="nm">${esc(r.toName || r.toHandle)}</div><div class="hd">@${esc(r.toHandle)} · waiting</div></div>
      <button class="btn ghost" data-decline="${esc(r.id)}">Cancel</button></div>`).join("")}</div></section>`;
  $("#view").innerHTML = html + `</div>`;
}

function renderFriend(f){
  const theirs = [...(f.shows||[])].sort((a,b) => (b.date||"").localeCompare(a.date||""));
  const done = theirs.filter(s => !isUpcoming(s));
  const together = S.shows.filter(s => theirs.some(o => sameShow(s, o))).sort((a,b) => (b.date||"").localeCompare(a.date||""));
  const mine = new Set(S.shows.filter(s=>!isUpcoming(s)).flatMap(lineup).map(b => b.toLowerCase()));
  const shared = counts(done.flatMap(lineup)).filter(b => mine.has(b.name.toLowerCase()));
  const v = S.crewView || "shows";
  const firsts = {};
  let body = "";
  if (f.err) body = `<div class="empty"><h3>Locked</h3><div>${esc(f.err)}</div></div>`;
  else if (v === "together") body = together.length ? `<div class="list">${together.map(s => ticket(s, firsts)).join("")}</div>` : `<div class="empty"><h3>No shows together yet</h3><div>Shows match when you both logged the same date and venue or band.</div></div>`;
  else if (v === "bands") body = shared.length ? `<div class="tagrow">${shared.map(b => `<span class="tagbtn" aria-pressed="true">${esc(b.name)}</span>`).join("")}</div>` : `<div class="ro">No bands you've both seen yet.</div>`;
  else body = theirs.length ? `<div class="list">${theirs.map(s => ticket(s, firsts, { friend: f.uid })).join("")}</div>` : `<div class="empty"><h3>Nothing logged</h3><div>${esc(f.name || "They")} haven't logged any shows yet.</div></div>`;
  $("#view").innerHTML = `<div class="crew">
    <button class="btn ghost" data-crewback style="justify-self:start">← The crew</button>
    <section class="me-card">${avatar(f.photo, f.name, "lg")}<div style="min-width:0"><div class="nm">${esc(f.name || f.handle)}</div><div class="hd">@${esc(f.handle)}</div></div></section>
    <div class="tiles">
      <div class="tile"><div class="lbl">Shows</div><div class="v num">${done.length}</div></div>
      <div class="tile"><div class="lbl">Bands seen</div><div class="v num">${counts(done.flatMap(lineup)).length}</div></div>
      <div class="tile"><div class="lbl">Together</div><div class="v num">${together.length}</div></div>
      <div class="tile"><div class="lbl">Shared bands</div><div class="v num">${shared.length}</div></div>
    </div>
    <div class="seg big" role="group" aria-label="View">
      <button data-crewview="shows" aria-pressed="${v==="shows"}">Their shows</button>
      <button data-crewview="together" aria-pressed="${v==="together"}">Together</button>
      <button data-crewview="bands" aria-pressed="${v==="bands"}">Shared bands</button></div>
    ${body}
    <div style="margin-top:18px"><button class="btn warn" data-unfriend="${esc(f.uid)}">${S.unfriendConfirm ? "Tap again to remove from crew" : "Remove from crew"}</button></div>
  </div>`;
}

function crewClick(t){
  if (t.hasAttribute("data-copyhandle")) { const h = "@" + PROFILE.handle; (navigator.clipboard ? navigator.clipboard.writeText(h) : Promise.reject()).then(() => toast("Copied " + h), () => toast("Your username is " + h, 4000)); return true; }
  if (t.dataset.accept) { const r = REQ.in.find(x => x.id === t.dataset.accept); if (r) acceptRequest(r); return true; }
  if (t.dataset.decline) { removeRequest(t.dataset.decline); return true; }
  if (t.dataset.friend) { S.crewSel = t.dataset.friend; S.crewView = "shows"; S.unfriendConfirm = false; renderCrew(); window.scrollTo(0, 0); return true; }
  if (t.hasAttribute("data-crewback")) { S.crewSel = null; renderCrew(); return true; }
  if (t.dataset.crewview) { S.crewView = t.dataset.crewview; renderCrew(); return true; }
  if (t.dataset.unfriend) {
    if (!S.unfriendConfirm) { S.unfriendConfirm = true; renderCrew(); return true; }
    const uid = t.dataset.unfriend; S.unfriendConfirm = false; S.crewSel = null;
    for (const r of REQ.in.concat(REQ.out)) if (r.from === uid || r.to === uid) removeRequest(r.id);
    toast("Removed from your crew"); return true;
  }
  return false;
}
document.addEventListener("submit", e => {
  if (e.target.id === "addForm") { e.preventDefault(); S.crewAdd = $("#addHandle").value; sendRequest(S.crewAdd); }
  if (e.target.id === "setupForm") { e.preventDefault(); saveProfile(); }
});
document.addEventListener("input", e => { if (e.target.id === "addHandle") S.crewAdd = e.target.value; });

/* ---------- Account menu + import ---------- */
function accountMenu(){
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Account"><div class="mbox">
    <div class="me-card" style="border:0;padding:0">${avatar(PROFILE.photoURL, PROFILE.name, "lg")}<div style="min-width:0"><div class="nm">${esc(PROFILE.name||"")}</div><div class="hd">@${esc(PROFILE.handle)}</div><div class="ro">${esc(ME.email||"")}</div></div></div>
    <div class="ro">Moving from the old Pit Log? Import the export file once and your shows and photos load into this account.</div>
    <label class="btn" style="text-align:center">Import Pit Log file<input class="vh" type="file" id="importFile" accept=".json,application/json"></label>
    <div class="mbtns"><button class="btn warn" data-signout>Sign out</button><button class="btn ghost" data-mclose>Close</button></div>
  </div></div>`;
  root.querySelector("[data-mclose]").onclick = () => root.innerHTML = "";
  root.querySelector("[data-signout]").onclick = () => { root.innerHTML = ""; signOut(auth); };
}

async function importFile(file){
  $("#modalRoot").innerHTML = "";
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { toast("That file isn't a Pit Log export", 4000); return; }
  const list = Array.isArray(data && data.shows) ? data.shows : null;
  if (!list) { toast("That file isn't a Pit Log export", 4000); return; }
  const fromData = async (m, showId, kind) => { if (!m || !m.data) return null; const b = await (await fetch(m.data)).blob(); const r = await putImage(b, showId, kind); return { url: r.url, path: r.path, type: "image", bands: m.bands || [] }; };
  let n = 0, pics = 0;
  for (const raw of list) {
    n++; toast(`Importing ${n} of ${list.length}…`, 60000);
    const id = String(raw.id || rid()).replace(/[^\w-]/g, "");
    const body = { ...raw }; delete body.id;
    try {
      for (const k of ["photos", "merch"]) { const out = []; for (const m of (raw[k] || [])) { const r = await fromData(m, id, k); if (r) { out.push(r); pics++; } } body[k] = out; }
      const p = await fromData(raw.poster, id, "poster"); body.poster = p ? { url: p.url, path: p.path } : null; if (p) pics++;
      await setDoc(myShow(id), body);
    } catch (e) { console.error(e); toast(`Import stopped at show ${n}: ${e.code || "error"}`, 6000); return; }
  }
  toast(`Imported ${list.length} shows and ${pics} photos`, 4000);
}

/* ---------- Auth + profile ---------- */
function showOnly(id){ for (const x of ["gate", "setup", "appRoot"]) $("#"+x).hidden = x !== id; }

async function doSignIn(){
  const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
  $("#signinMsg").textContent = "";
  try { const r = await signInWithPopup(auth, p); $("#signinMsg").textContent = r && r.user ? "Signed in as " + (r.user.email || "you") + ", loading…" : "Popup returned no user."; }
  catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/web-storage-unsupported"].includes(e.code)) { try { try { sessionStorage.setItem("pitlog.redirect", "1"); } catch(_){} await signInWithRedirect(auth, p); } catch (e2) { $("#signinMsg").textContent = "Sign-in failed: " + (e2.code || e2.message); } }
    else if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") $("#signinMsg").textContent = "Sign-in window closed before finishing (" + e.code + ").";
    else $("#signinMsg").textContent = e.code === "auth/unauthorized-domain" ? "This web address isn't authorized yet. Add it under Authentication → Settings → Authorized domains." : "Sign-in failed: " + (e.code || e.message);
  }
}

function showSetup(){
  showOnly("setup");
  const base = (ME.email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
  $("#setupName").value = ME.displayName || "";
  $("#setupHandle").value = base.length >= 3 ? base : "";
}
async function saveProfile(){
  const name = $("#setupName").value.trim(), h = $("#setupHandle").value.trim().replace(/^@/, "").toLowerCase();
  const msg = $("#setupMsg"); msg.textContent = "";
  if (!name) { msg.textContent = "Add your name."; return; }
  if (!HANDLE_RE.test(h)) { msg.textContent = "Usernames are 3–20 lowercase letters, numbers or _."; return; }
  const btn = $("#setupGo"); btn.disabled = true;
  try {
    const taken = await getDoc(doc(fdb, "handles", h));
    if (taken.exists() && taken.data().uid !== ME.uid) { msg.textContent = `@${h} is taken. Try another.`; btn.disabled = false; return; }
    const prof = { name, handle: h, photoURL: ME.photoURL || "", createdAt: serverTimestamp() };
    const b = writeBatch(fdb);
    if (!taken.exists()) b.set(doc(fdb, "handles", h), { uid: ME.uid });
    b.set(doc(fdb, "users", ME.uid), prof);
    await b.commit();
    PROFILE = prof; startApp();
  } catch (e) { console.error(e); msg.textContent = e.code === "permission-denied" ? `@${h} is taken, or the Firestore rules aren't published yet.` : "Couldn't save: " + (e.code || e.message); btn.disabled = false; }
}

function resetState(){
  UNSUBS.forEach(u => { try { u(); } catch(_){} }); UNSUBS = [];
  for (const uid of Object.keys(FR)) dropFriend(uid);
  REQ = { in: [], out: [] }; S.shows = []; S.loaded = false; S.tab = "shows"; S.crewSel = null;
  closeLightbox(); if (S.open) closeSheet(); $("#modalRoot").innerHTML = "";
  ME = null; PROFILE = null; db = null; assets = null;
}

function startApp(){
  db = fdb; assets = true; S.canWrite = true;
  showOnly("appRoot");
  const a = $("#acct"); a.hidden = false; a.innerHTML = avatar(PROFILE.photoURL, PROFILE.name);
  $("#addBtn").hidden = false;
  render();
  const timer = setTimeout(() => { if (!S.loaded) { S.slow = true; render(); } }, 10000);
  UNSUBS.push(onSnapshot(myShows(), { includeMetadataChanges: false }, snap => {
    S.shows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!snap.metadata.fromCache || S.shows.length) { S.loaded = true; S.slow = false; clearTimeout(timer); }
    if (S.open && !S.openFriend && S.open !== "__new" && draft && !busy) {
      const fresh = S.shows.find(x => x.id === S.open);
      if (fresh) { readForm(); for (const k of ["poster","photos","merch"]) draft[k] = fresh[k]; }
    }
    renderNext();
    if (!S.open) renderTab(); else renderSheet();
  }, err => { clearTimeout(timer); S.loaded = true; S.error = err.code === "permission-denied" ? "Your log is blocked — the Firestore rules aren't published yet." : "The log couldn't load. Reload to try again."; render(); }));
  const reqs = (field, key) => onSnapshot(query(collection(fdb, "friendRequests"), where(field, "==", ME.uid)), snap => {
    REQ[key] = snap.docs.map(d => ({ id: d.id, ...d.data() })); syncFriends(); updateCrewBadge();
  }, err => console.error("requests", err));
  UNSUBS.push(reqs("to", "in"), reqs("from", "out"));
}
function updateCrewBadge(){ const n = REQ.in.filter(r => r.status === "pending").length; $("#tab-crew").innerHTML = "Crew" + (n ? ` <span class="badge-n">${n}</span>` : ""); $("#tab-crew").setAttribute("aria-selected", S.tab === "crew"); }

$("#signinBtn").addEventListener("click", doSignIn);
if (/; wv\)|FBAN|FBAV|Instagram|Line\/|GSA\//.test(navigator.userAgent) || (document.referrer && !document.referrer.includes(location.host) && window.matchMedia("(display-mode: browser)").matches && /Android/.test(navigator.userAgent) && !window.chrome)) $("#inapp").hidden = false;
getRedirectResult(auth).catch(e => { if ($("#signinMsg")) $("#signinMsg").textContent = "Sign-in failed: " + (e.code || e.message); });
onAuthStateChanged(auth, async user => {
  let wasRedirect = false; try { wasRedirect = sessionStorage.getItem("pitlog.redirect") === "1"; sessionStorage.removeItem("pitlog.redirect"); } catch(_){}
  if (!user) {
    resetState(); showOnly("gate");
    if (wasRedirect) $("#signinMsg").textContent = "Sign-in didn't finish. This browser blocked it. Open this page in Chrome (⋮ → Open in Chrome) or Safari and try again.";
    return;
  }
  ME = user;
  $("#signinMsg").textContent = "Signed in as " + (user.email || "you") + ". Opening your log…";
  try {
    const p = await Promise.race([
      getDoc(doc(fdb, "users", user.uid)),
      new Promise((_, rej) => setTimeout(() => rej({ code: "timeout" }), 12000))
    ]);
    if (p.exists() && p.data().handle) { PROFILE = p.data(); startApp(); }
    else showSetup();
  } catch (e) {
    console.error(e); showSetup();
    const why = e.code === "permission-denied" ? "Firestore rules aren't published yet (Firestore → Rules → paste → Publish)."
      : e.code === "timeout" || e.code === "unavailable" || e.code === "failed-precondition" ? "Can't reach the database \"" + DB_ID + "\". Check it exists under Databases & Storage → Firestore and its Rules are published."
      : e.code === "not-found" ? "No Firestore database yet: Databases & Storage → Firestore → Create database."
      : "Database error: " + (e.code || e.message);
    showOnly("gate"); $("#signinMsg").textContent = why; return;
  }
});

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
