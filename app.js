// Pit Log — Firebase edition
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, getDoc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, query, where, writeBatch, serverTimestamp, arrayUnion, getDocs, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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

const SKULL_D = "M12 2C6.9 2 3 5.7 3 10.5c0 2.6 1.2 4.6 3 5.9V19a1 1 0 0 0 1 1h1.5v-2h1.5v2h4v-2h1.5v2H17a1 1 0 0 0 1-1v-2.6c1.8-1.3 3-3.3 3-5.9C21 5.7 17.1 2 12 2Zm-3.5 7.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM12 13.6l1.2 2.2h-2.4L12 13.6Z";
const SKULL = (on) => SKULLC(on?'var(--bone)':'var(--iron)');
const SKULLC = (fill) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="${fill}" d="${SKULL_D}"/></svg>`;
// Skull i of 5 for a rating that can land on halves: full, left half, or empty.
const SKULLV = (rating, i) => rating >= i ? SKULL(true) : rating >= i - 0.5
  ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--iron)" d="${SKULL_D}"/><path fill="var(--bone)" style="clip-path:inset(0 50% 0 0)" d="${SKULL_D}"/></svg>` : SKULL(false);
const fmtRating = r => (Math.round(r * 2) / 2).toString();
// Tap a step: full, tap it again for a half, again to clear.
const stepRating = (cur, i) => cur === i ? i - 0.5 : cur === i - 0.5 ? 0 : i;

let S = { shows: [], loaded: false, slow: false, error: "", tab: "shows", filter: "all", q: "",
  open: null, canWrite: true, year: "all", sort: (()=>{ try { const v = localStorage.getItem("pitlog.sort"); return ["newest","oldest","rating","venue","band"].includes(v) ? v : "newest"; } catch(_) { return "newest"; } })(), vault: { by: "band", sel: null, type: "all", q: "" },
  cal: { y: new Date().getFullYear(), m: new Date().getMonth() } };
let db = null, assets = null;
let ME = null, PROFILE = null;
// Shows tab: list or calendar view (remembered on this device)
const showViewPref = (() => { try { return localStorage.getItem("pitlog.showView") === "cal" ? "cal" : "list"; } catch (_) { return "list"; } })();
const viewSwitch = () => `<div class="seg vswitch" role="group" aria-label="View">${[["list","List"],["cal","Calendar"]].map(([v,l]) => `<button data-sview="${v}" aria-pressed="${S.showView===v}">${l}</button>`).join("")}</div>`;
const crewPref = (() => { try { return localStorage.getItem("pitlog.crewOn") === "1"; } catch (_) { return false; } })();
S.crewOn = crewPref;
S.showView = showViewPref;
const FR = {}; // friend uid -> { uid, name, handle, photo, shows, err, unsub }
let REQ = { in: [], out: [] };

const parse = (iso) => { const [y,m,d] = (iso||"").split("-").map(Number); return { y, m, d, dt: new Date(y, (m||1)-1, d||1) }; };
const fmtDate = iso => { const p = parse(iso); return p.y ? `${MONTHS[p.m-1]} ${p.d}, ${p.y}` : ""; };
const isUpcoming = s => (s.date||"") > todayISO;
const lineup = s => Array.isArray(s.lineup) ? s.lineup.filter(Boolean) : [];
const crew = s => Array.isArray(s.wentWith) ? s.wentWith.filter(Boolean) : [];
// Crew tags: names in "Went with" linked to a friend's account. Stored on the show as
// tagged: [{name, uid}] plus taggedUids: [uid] so friends can tell they were tagged.
const tagsOf = s => Array.isArray(s && s.tagged) ? s.tagged.filter(t => t && t.uid && t.name) : [];
const tagFor = (s, name) => tagsOf(s).find(t => String(t.name).toLowerCase() === String(name).toLowerCase());
const firstName = f => String((f && (f.name || f.handle)) || "").trim().split(/\s+/)[0];
function nameMatches(f, name){
  const n = String(name || "").trim().toLowerCase().replace(/^@/, ""); if (!n || !f) return false;
  const full = String(f.name || "").trim().toLowerCase();
  return n === full || n === full.split(/\s+/)[0] || n === String(f.handle || "").toLowerCase();
}
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
  return `<button class="ticket ${up?'upcoming':''}${opts.friend && S.tab!=="crew" ? " crewt" : ""}" ${opts.friend ? `data-fopen="${esc(opts.friend)}|${esc(s.id)}"` : `data-open="${esc(s.id)}"`} aria-label="Open ${esc(lu[0]||'show')}">
    <div class="stub"><div class="mo">${MONTHS[(p.m||1)-1].toUpperCase()}</div><div class="dd num">${p.d||"?"}</div><div class="dw">${DAYS[p.dt.getDay()]}</div></div>
    <div class="tbody">
      <div class="head">${esc(lu[0]||"Untitled show")}</div>
      ${sup.length ? `<div class="sup"><b>w/</b> ${esc(sup.join(" · "))}</div>` : ""}
      <div class="venue">${esc([s.venue, s.city].filter(Boolean).join(" — ") || "Venue unknown")}</div>
      <div class="chips">
        ${up ? `<span class="chip up">Upcoming</span>` : ""}
        ${s.unsure ? `<span class="chip unsure">Unconfirmed</span>` : ""}
        ${!up && rating ? `<span class="skulls" aria-label="${fmtRating(rating)} of 5">${[1,2,3,4,5].map(i=>SKULLV(rating, i)).join("")}</span>` : ""}
        ${crew(s).map(c=>{ const tg = tagFor(s, c); const h = tg && FR[tg.uid] ? FR[tg.uid].handle : ""; return `<span class="chip crew${tg?" tg":""}"${h?` title="@${esc(h)}"`:""}>${esc(c)}</span>`; }).join("")}
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
  if (k === "rating") { if (isUpcoming(s)) return ["Upcoming", ""]; const r = Number(s.rating)||0; return r ? [`${fmtRating(r)} skull${r>1?"s":""}`, ""] : ["Unrated", ""]; }
  if (k === "venue") return [s.venue || "Venue unknown", s.city || ""];
  if (k === "band") { const c = sortKey(lineup(s)[0]).charAt(0).toUpperCase(); return [/[A-Z]/.test(c) ? c : "#", ""]; }
  return [MONTHS[(p.m||1)-1], String(p.y||"")];
}

function renderShows(){
  if (S.showView === "cal") return renderCal();
  let list = [...S.shows, ...(S.crewOn ? crewOverlay() : [])].filter(inYear);
  if (S.filter === "attended") list = list.filter(s => !isUpcoming(s));
  if (S.filter === "upcoming") list = list.filter(isUpcoming);
  const q = S.q.trim().toLowerCase();
  if (q) list = list.filter(s => [...lineup(s), s.venue, s.city, ...crew(s), s.tour, s._f && FR[s._f] ? "@" + FR[s._f].handle : ""].join(" ").toLowerCase().includes(q));
  sortShows(list);
  const firsts = firstSightings();
  let html = `<div class="vrow">${viewSwitch()}</div><div class="filters">
    ${yearSeg()}
    <div class="seg" role="group" aria-label="Filter">${["all","attended","upcoming"].map(f=>`<button data-filter="${f}" aria-pressed="${S.filter===f}">${f}</button>`).join("")}</div>
    ${crewToggle()}
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
      html += ticket(s, firsts, s._f ? { friend: s._f } : null);
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
/* ---------- Settings (stored on users/{uid}.settings so they follow the account) ---------- */
const LEVELS = [["public", "Public"], ["crew", "Crew only"], ["family", "Family only"], ["private", "Private"]];
const LV = { private: 0, family: 1, crew: 2, public: 3 };
const PRIVACY = [
  ["ticketCost", "Ticket cost", "Order totals and price per ticket."],
  ["merchCost", "Merch cost", "What you spent on merch."],
  ["photos", "Photos", "Show photos and merch photos, including in the Vault."],
  ["poster", "Tour posters", "Linked Crew Family shows always share their poster."],
  ["ratings", "Ratings", "Skulls, pit intensity and best band of the night."],
  ["notes", "Notes and setlists", "Notes, highlight moment and setlist notes."],
  ["wentWith", "Who you went with", "Names under Went with. Anyone you tag still sees their own tag."],
  ["spot", "Where you stood and miles", "Your spot in the crowd and miles driven."],
  ["upcoming", "Upcoming shows", "Shows that haven't happened yet, so people can't see where you'll be."],
  ["stats", "Profile stats", "Show, band and venue counts, and your spot in Crew standings."],
  ["tagMe", "Who can tag me", "Who can tag you on their shows. People you block from tagging won't see you in their tag list."],
  ["searchable", "Find me in search", "Public lets anyone on Pit Log find your profile by name or username. Anything else keeps you out of search."],
  ["publicShows", "Shows on my public profile", "Public lets people outside your crew see your shows (date, bands, venue) on your profile and in band search. The settings above decide which extra details come with them."],
];
const SETTING_DEFAULTS = { ...Object.fromEntries(PRIVACY.map(([k]) => [k, "public"])),
  defaultView: "list", defaultSort: "newest", crewDefault: "off", weekStart: "sun", currency: "$", distance: "mi" };
const settingsOf = prof => ({ ...SETTING_DEFAULTS, ...((prof && prof.settings) || {}) });
const MY = () => settingsOf(PROFILE);
// Family sees what's "family" and up; the rest of the crew sees "crew" and up.
const canSee = (set, key, f) => LV[set[key] || "public"] >= (f && f.family ? LV.family : LV.crew);
const CUR = () => MY().currency;
const KM = () => MY().distance === "km";
const dist = mi => KM() ? mi * 1.609344 : mi;
const distLbl = () => KM() ? "km" : "miles";
const money = n => CUR() + Math.round(n).toLocaleString();
const money2 = n => CUR() + Number(n).toFixed(2);
// Per-ticket price: order total / tickets bought; falls back to an older single "ticket" value.
function perTicket(s){
  const q = Number(s.ticketQty), t = Number(s.ticketTotal);
  if (t > 0 && q > 0) return t / q;
  if (s.ticketTotal == null && Number(s.ticket) > 0) return Number(s.ticket);
  return null;
}
// What the whole order cost (everyone's tickets plus fees).
function orderSpend(s){
  if (Number(s.ticketTotal) > 0) return Number(s.ticketTotal);
  return Number(s.ticket) > 0 ? Number(s.ticket) * (Number(s.ticketQty) || 1) : 0;
}

function renderStats(){
  const all = sorted().filter(inYear), done = all.filter(s=>!isUpcoming(s)), up = all.filter(isUpcoming);
  if (!S.loaded || !all.length) { $("#view").innerHTML = `<div class="filters">${yearSeg()}${crewToggle()}</div><div class="empty" style="margin-top:16px"><h3>No stats yet</h3><div>Stats build up as shows are logged.</div></div>`; return; }
  const bands = counts(done.flatMap(lineup)), venues = counts(done.map(s=>s.venue||"")), people = counts(done.flatMap(crew));
  const miles = done.reduce((a,s)=>a+(Number(s.miles)||0),0), tix = done.reduce((a,s)=>a+orderSpend(s),0), share = done.reduce((a,s)=>a+(perTicket(s)||0),0), withQty = done.filter(s=>Number(s.ticketQty)>0&&Number(s.ticketTotal)>0), qtySum = withQty.reduce((a,s)=>a+Number(s.ticketQty),0), avgTix = qtySum ? withQty.reduce((a,s)=>a+Number(s.ticketTotal),0)/qtySum : 0, merch = done.reduce((a,s)=>a+(Number(s.merchSpend)||0),0);
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
  $("#view").innerHTML = `<div class="filters">${yearSeg()}${crewToggle()}</div><div class="stats" style="margin-top:0">
    ${S.crewOn ? crewStats() : ""}
    <div class="tiles">
      <div class="tile"><div class="lbl">Shows attended</div><div class="v num">${done.length}</div></div>
      <div class="tile"><div class="lbl">Still to come</div><div class="v num">${up.length}</div></div>
      <div class="tile"><div class="lbl">Bands seen</div><div class="v num">${bands.length}</div></div>
      <div class="tile"><div class="lbl">Venues</div><div class="v num">${venues.filter(v=>v.name).length}</div></div>
      <div class="tile"><div class="lbl">Est. ${distLbl()} driven</div><div class="v num">${Math.round(dist(miles)).toLocaleString()}</div></div>
      <div class="tile"><div class="lbl">Avg rating</div><div class="v num">${avg}<small>/5</small></div></div>
      <div class="tile"><div class="lbl">Ticket spend</div><div class="v num">${tix?money(tix):"–"}</div></div>
      <div class="tile"><div class="lbl">Your seats</div><div class="v num">${share?money(share):"–"}</div></div>
      <div class="tile"><div class="lbl">Avg per ticket</div><div class="v num">${avgTix?money2(avgTix):"–"}</div></div>
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
  if (!S.loaded) { $("#view").innerHTML = `<div class="vrow">${viewSwitch()}</div><div class="calwrap">${statusBlock()}</div>`; return; }
  const { y, m } = S.cal;
  const key = (dd) => y+"-"+String(m+1).padStart(2,"0")+"-"+String(dd).padStart(2,"0");
  const all = [...sorted(), ...(S.crewOn ? crewOverlay() : [])];
  const byDate = {}; for (const s of all) (byDate[s.date] = byDate[s.date] || []).push(s);
  const mon = MY().weekStart === "mon", first = (new Date(y, m, 1).getDay() + (mon ? 6 : 0)) % 7, dim = new Date(y, m+1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(`<div class="day out" aria-hidden="true"></div>`);
  for (let d = 1; d <= dim; d++) {
    const k = key(d), list = byDate[k] || [], today = k === todayISO;
    if (!list.length) { cells.push(`<div class="day${today?" today":""}"><span class="dn">${d}</span></div>`); continue; }
    const mineL = list.filter(x => !x._f), crewL = list.filter(x => x._f);
    const s = mineL[0] || crewL[0], up = isUpcoming(s), onlyCrew = !mineL.length;
    const opener = s._f ? `data-fopen="${esc(s._f)}|${esc(s.id)}"` : `data-open="${esc(s.id)}"`;
    const dots = crewL.length ? `<span class="cdots">${[...new Set(crewL.map(x => x._f))].slice(0,3).map(u => `<i>${esc(((FR[u]&&FR[u].handle)||"?").charAt(0).toUpperCase())}</i>`).join("")}</span>` : "";
    cells.push(`<button class="day has${up?" up":""}${onlyCrew?" crewday":""}${today?" today":""}" ${opener} aria-label="${esc(fmtDate(k))}: ${esc(list.map(x=>(x._f && FR[x._f] ? "@"+FR[x._f].handle+" " : "")+lineup(x)[0]).join(", "))}">
      <span class="dn">${d}</span><span class="sk">${SKULLC(onlyCrew ? "var(--dim)" : up ? "var(--rust)" : "var(--bone)")}</span>
      <span class="hl">${esc(lineup(s)[0]||"Show")}${mineL.length>1?` +${mineL.length-1}`:""}</span>${dots}</button>`);
  }
  while (cells.length % 7) cells.push(`<div class="day out" aria-hidden="true"></div>`);
  const mc = Array(12).fill(0); for (const s of S.shows) { const p = parse(s.date); if (p.y === y) mc[p.m-1]++; }
  const inMonth = all.filter(s => { const p = parse(s.date); return p.y === y && p.m === m+1; }).sort((a,b) => (a.date||"").localeCompare(b.date||"") || (!!a._f - !!b._f));
  const yrs = years(); if (!yrs.includes(y)) yrs.push(y);
  $("#view").innerHTML = `<div class="vrow">${viewSwitch()}</div><div class="calwrap">
    <div class="filters" style="margin:0"><div class="seg" role="group" aria-label="Year">${yrs.sort((a,b)=>b-a).map(yy=>`<button data-caly="${yy}" aria-pressed="${yy===y}">${yy}</button>`).join("")}</div>
      <button class="btn ghost" data-caltoday>Today</button><button class="btn ghost" data-calexport>Export</button>${crewToggle()}</div>
    <div class="mstrip" role="group" aria-label="Months of ${y}">${MONTHS.map((mn,i)=>`<button data-calm="${i}" aria-pressed="${i===m}" aria-label="${MONTHS_LONG[i]}: ${mc[i]} show${mc[i]!==1?"s":""}"><span class="ml">${mn[0]}</span><span class="mc ${mc[i]?"":"z"}">${mc[i]||"·"}</span></button>`).join("")}</div>
    <div class="calnav"><button class="arw" data-calnav="-1" aria-label="Previous month">‹</button>
      <div class="mt-title">${MONTHS_LONG[m]} <span style="color:var(--ash)">${y}</span></div>
      <button class="arw" data-calnav="1" aria-label="Next month">›</button></div>
    <div class="cal">${(mon ? [...DAYS.slice(1), DAYS[0]] : DAYS).map(d=>`<div class="dow">${d.slice(0,2)}</div>`).join("")}${cells.join("")}</div>
    ${inMonth.length ? `<div class="mlist">${inMonth.map(s=>{ const p = parse(s.date), lu = lineup(s);
        const opener = s._f ? `data-fopen="${esc(s._f)}|${esc(s.id)}"` : `data-open="${esc(s.id)}"`;
        return `<button ${opener} class="${isUpcoming(s)?"up":""}${s._f?" crewrow":""}"><span class="dd num">${p.d}</span><span style="min-width:0"><div class="t1">${s._f && FR[s._f] ? `<span class="chip crewtag">@${esc(FR[s._f].handle)}</span> ` : ""}${esc(lu[0]||"Show")}${isUpcoming(s)?` <span class="chip up">Upcoming</span>`:""}</div><div class="t2">${esc([lu.slice(1).join(" · "), s.venue].filter(Boolean).join(" — ") || "Venue unknown")}</div></span></button>`; }).join("")}</div>`
      : `<div class="empty"><h3>Silent month</h3><div>No shows logged in ${MONTHS_LONG[m]} ${y}.</div></div>`}
  </div>`;
}

function renderTab(){
  updateCrewBadge();
  if (S.tab === "cal") { S.tab = "shows"; S.showView = "cal"; }
  for (const t of ["shows","vault","stats","crew"]) $("#tab-"+t).setAttribute("aria-selected", S.tab===t);
  if (S.tab === "search") renderSearch(); else if (S.tab === "me") renderMe(); else if (S.tab === "crew") renderCrew(); else if (S.tab === "shows") renderShows(); else if (S.tab === "cal") renderCal(); else if (S.tab === "vault") renderVault(); else renderStats();
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
      ${!isNew && d.date ? `<div class="field"><span class="lbl">Add to calendar</span><div class="tagrow"><a class="btn" href="${esc(googleCalUrl(d))}" target="_blank" rel="noopener">Google Calendar</a><button class="btn" data-ics1>Apple / other (.ics)</button></div></div>` : ""}
    </div>

    <div class="sect"><h3>Went with</h3>
      <label class="field"><span class="lbl">Names, comma separated</span><input id="f-crew" value="${esc(crew(d).join(", "))}" placeholder="Who was in your crew?" ${ro?"disabled":""}></label>
      ${tagPicker(d, ro)}
    </div>

    <div class="sect"><h3>The night ${up?`<span class="chip up">Upcoming</span>`:""}</h3>
      <div class="grid2">
        <div class="field"><span class="lbl">Rating${Number(d.rating) ? ` · ${fmtRating(Number(d.rating))}` : ""}</span><div class="picker" role="group" aria-label="Rating">${[1,2,3,4,5].map(i=>`<button data-rate="${i}" aria-pressed="${(Number(d.rating)||0)>=i-0.5}" aria-label="${i} skull${i>1?'s':''}" ${ro?"disabled":""}>${SKULLV(Number(d.rating)||0, i)}</button>`).join("")}</div></div>
        <div class="field"><span class="lbl">Pit intensity${Number(d.pit) ? ` · ${fmtRating(Number(d.pit))}` : ""}</span><div class="picker meter" role="group" aria-label="Pit intensity">${[1,2,3,4,5].map(i=>{ const pv = Number(d.pit)||0, c = `color-mix(in srgb, var(--blood) ${40+i*12}%, var(--rust))`; return `<button data-pit="${i}" aria-pressed="${pv>=i-0.5}" aria-label="Level ${i}" ${ro?"disabled":""}><i style="background:${pv>=i ? c : pv>=i-0.5 ? `linear-gradient(90deg, ${c} 50%, var(--slab) 50%)` : 'var(--slab)'}"></i></button>`; }).join("")}</div></div>
      </div>
      ${ro ? "" : `<div class="ro" style="margin-top:-4px">Tap a skull or bar again for a half, a third time to clear.</div>`}
      <div class="grid2">
        <label class="field"><span class="lbl">Where you stood</span><select id="f-spot" ${ro?"disabled":""}>${SPOTS.map(o=>`<option value="${esc(o)}" ${d.spot===o?"selected":""}>${o||"—"}</option>`).join("")}</select></label>
        <label class="field"><span class="lbl">Best band of the night</span><select id="f-best" ${ro?"disabled":""}><option value="">—</option>${lineup(d).map(b=>`<option ${d.best===b?"selected":""}>${esc(b)}</option>`).join("")}</select></label>
      </div>
      <label class="field"><span class="lbl">Highlight moment</span><input id="f-highlight" value="${esc(d.highlight||"")}" placeholder="Wall of death during…" ${ro?"disabled":""}></label>
      <label class="field"><span class="lbl">Setlist notes</span><textarea id="f-setlist" placeholder="Opened with… closed with…" ${ro?"disabled":""}>${esc(d.setlist||"")}</textarea></label>
      <label class="field"><span class="lbl">Notes</span><textarea id="f-notes" ${ro?"disabled":""}>${esc(d.notes||"")}</textarea></label>
      <div class="grid2">
        <label class="field"><span class="lbl">Tickets bought</span><input id="f-ticketQty" type="number" min="0" step="1" inputmode="numeric" value="${esc(d.ticketQty??"")}" ${ro?"disabled":""}></label>
        <label class="field"><span class="lbl">Order total ${esc(CUR())} (with fees)</span><input id="f-ticketTotal" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(d.ticketTotal??(d.ticket!=null&&d.ticketQty==null?d.ticket:""))}" ${ro?"disabled":""}></label>
        <div class="field"><span class="lbl">Per ticket</span><div class="ro num" id="f-perTicket" style="padding:10px 0;font-size:18px">${perTicket(d)!=null?money2(perTicket(d)):"–"}</div></div>
        <label class="field"><span class="lbl">Merch ${esc(CUR())}</span><input id="f-merchSpend" type="number" min="0" step="1" inputmode="decimal" value="${esc(d.merchSpend??"")}" ${ro?"disabled":""}></label>
        <label class="field"><span class="lbl">Round-trip ${distLbl()} (est.)</span><input id="f-miles" type="number" min="0" step="1" value="${esc(d.miles!=null&&d.miles!==""?Math.round(dist(Number(d.miles))):"")}" ${ro?"disabled":""}></label>
      </div>
    </div>

    <div class="sect"><h3>Tour poster</h3>
      <div class="poster">
        ${d.poster ? `<button class="posterbox" data-lbi="0" aria-label="View poster"><img src="${src(pid(d.poster))}" alt="Tour poster"></button>`
          : `<div class="posterbox"><span class="lbl">No poster yet</span></div>`}
        <div class="ro">${S.openFriend ? "" : assets && !isNew ? `<label class="btn">${d.poster?"Replace poster":"Upload poster"}<input class="vh" type="file" data-upkind="poster" accept="image/*,.heic,.heif" aria-label="Upload poster"></label>` : isNew ? "Save the show first, then add a poster." : ""}</div>
      </div>
    </div>
    ${media}

    ${!isNew && !ro ? `<div class="sect"><div><button class="btn warn" data-del>${confirmDel?(draft.linkId && friendList().some(f=>f.family) ? "Tap again: deletes from your log only" : "Tap again to delete this show"):"Delete show"}</button></div></div>` : ""}
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
    ticketQty: n(v("f-ticketQty")), ticketTotal: n(v("f-ticketTotal")), merchSpend: n(v("f-merchSpend")), miles: (x => x == null ? null : KM() ? Math.round(x / 1.609344) : x)(n(v("f-miles"))),
  });
  draft.ticket = perTicket({ ticketQty: draft.ticketQty, ticketTotal: draft.ticketTotal });
  draft.tagged = tagsOf(draft).filter(t => draft.wentWith.some(n => ieq(n, t.name)));
  draft.taggedUids = [...new Set(draft.tagged.map(t => t.uid))];
}

async function save(){
  if (!db || busy) return;
  readForm();
  if (!draft.date || !lineup(draft).length) { toast("Add a date and at least one band"); return; }
  busy = true; renderSheet();
  const body = {...draft}; delete body.id;
  try {
    if (draft.id === "__new") { const ref = await addDoc(myShows(), body); draft.id = ref.id; S.open = ref.id; toast("Show added"); }
    else { await setDoc(myShow(draft.id), body); toast("Saved"); pushShared(body); }
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
  for (const p of [!s.linkId && s.poster && s.poster.path, ...items(s,"photos").map(m=>m.path), ...items(s,"merch").map(m=>m.path)].filter(Boolean)) await removeFile(p);
  closeSheet(); toast("Show deleted");
}

/* ---------- Uploads ---------- */
/* ---------- Photo compressor ----------
   Every photo is re-encoded before upload: longest side capped, quality stepped down until
   it fits the target size, WebP where the browser can write it (else JPEG). Re-encoding also
   strips hidden metadata such as GPS location. iPhone HEIC photos are converted first. */
const COMPRESS = { maxSide: 2048, posterSide: 2400, target: 900 * 1024, minQ: 0.55 };
const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
const isHeic = f => /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name || "");
let webpOK = null;
async function canWebp(){
  if (webpOK !== null) return webpOK;
  try { const c = document.createElement("canvas"); c.width = c.height = 2; const b = await new Promise(r => c.toBlob(r, "image/webp", 0.8)); webpOK = !!b && b.type === "image/webp"; }
  catch (_) { webpOK = false; }
  return webpOK;
}
function loadScript(src){ return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
async function decodeImage(blob){
  if (window.createImageBitmap) { try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (_) {} }
  const url = URL.createObjectURL(blob);
  try { return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function heicToJpeg(file){
  if (!window.heic2any) await loadScript("https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js");
  const out = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  return Array.isArray(out) ? out[0] : out;
}
async function compress(file, kind){
  if (/image\/gif/.test(file.type)) return file; // keep animation
  let src = file, img;
  try { img = await decodeImage(src); }
  catch (e) { if (!isHeic(file)) throw e; src = await heicToJpeg(file); img = await decodeImage(src); }
  const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
  const side = kind === "poster" ? COMPRESS.posterSide : COMPRESS.maxSide;
  const sc = Math.min(1, side / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
  const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high"; ctx.drawImage(img, 0, 0, c.width, c.height);
  if (img.close) img.close();
  const type = (await canWebp()) ? "image/webp" : "image/jpeg";
  let q = 0.86, blob = null;
  for (;;) {
    blob = await new Promise(r => c.toBlob(r, type, q));
    if (!blob || blob.size <= COMPRESS.target || q <= COMPRESS.minQ) break;
    q = Math.max(COMPRESS.minQ, q - 0.08);
  }
  if (!blob) return file;
  // Only keep the original if it's already a small, metadata-free-safe format and smaller
  return blob.size < file.size || isHeic(file) || file.size > COMPRESS.target ? blob : (file.type === "image/png" || file.type === "image/webp" || file.type === "image/jpeg" ? blob : file);
}

function isVideo(f){ return /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm)$/i.test(f.name||""); }
function videoType(f){ return (f.type === "video/webm" || /\.webm$/i.test(f.name||"")) ? "video/webm" : "video/mp4"; }

const ACCEPT_MEDIA = "image/*,.heic,.heif";
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
  const out = []; let skipped = 0, n = 0, before = 0, after = 0;
  for (const f of files) {
    n++;
    toast(`Compressing & uploading ${n} of ${files.length}…`, 60000);
    try {
      const b = await compress(f, kind);
      before += f.size; after += b.size;
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
    const saved = before > after ? ` · ${fmtBytes(before)} → ${fmtBytes(after)}` : "";
    toast(skipped ? `Added ${out.length}${saved}. Skipped ${skipped} that couldn't upload.` : `Added ${out.length}${saved}`, skipped ? 5000 : 3500);
    if (kind === "poster") { await pushPoster(s, patch.poster); if (old && old.path) await removeFile(old.path); }
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
    await updateDoc(myShow(s.id), e.kind === "poster" && s.linkId && s.poster ? { ...patch, posterCleared: arrayUnion(s.poster.url) } : patch);
    if (e.kind === "poster") await pushPoster(s, null);
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
  else if (t.dataset.sview) { S.showView = t.dataset.sview; try { localStorage.setItem("pitlog.showView", S.showView); } catch (_) {} renderShows(); window.scrollTo(0, 0); }
  else if (t.dataset.year) { S.year = t.dataset.year; renderTab(); }
  else if (t.dataset.caly) { S.cal.y = Number(t.dataset.caly); renderCal(); }
  else if (t.dataset.calm) { S.cal.m = Number(t.dataset.calm); renderCal(); }
  else if (t.dataset.calnav) { let m = S.cal.m + Number(t.dataset.calnav), y = S.cal.y; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } S.cal = { y, m }; renderCal(); }
  else if (t.hasAttribute("data-calexport")) exportMenu();
  else if (t.hasAttribute("data-backup")) downloadBackup();
  else if (t.hasAttribute("data-ics1")) { if (draft) { readForm(); deliverIcs([draft], `${slug(draft)}-${draft.date}.ics`); } }
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
  else if (t.id === "searchBtn") { S.tab = "search"; S.search.profile = null; renderTab(); window.scrollTo(0, 0); setTimeout(() => $("#sq") && $("#sq").focus(), 50); }
  else if (searchClick(t)) {}
  else if (t.hasAttribute("data-editprofile")) editProfile();
  else if (t.hasAttribute("data-myprofile2")) { S.tab = "me"; renderTab(); window.scrollTo(0, 0); }
  else if (t.hasAttribute("data-crewtoggle")) { S.crewOn = !S.crewOn; try { localStorage.setItem("pitlog.crewOn", S.crewOn ? "1" : "0"); } catch (_) {} renderTab(); }
  else if (t.dataset.tagf) { readForm(); toggleTag(t.dataset.tagf); }
  else if (crewClick(t)) {}
  else if (t.hasAttribute("data-close")) closeSheet();
  else if (t.hasAttribute("data-save")) save();
  else if (t.hasAttribute("data-del")) del();
  else if (t.dataset.rate) { readForm(); const v = Number(t.dataset.rate); draft.rating = stepRating(Number(draft.rating)||0, v); renderSheet(); }
  else if (t.dataset.pit) { readForm(); const v = Number(t.dataset.pit); draft.pit = stepRating(Number(draft.pit)||0, v); renderSheet(); }
  else if (t.dataset.lbi !== undefined) { if (S.open) { readForm(); openLightbox(SHEET_LIST, Number(t.dataset.lbi)); } else openLightbox(VIEW_LIST, Number(t.dataset.lbi)); }
});
function keepFocus(id, fn){ const el = $("#"+id); const pos = el.selectionStart; fn(); const n = $("#"+id); if (n) { n.focus(); try{n.setSelectionRange(pos,pos);}catch(_){} } }
document.addEventListener("input", e => {
  if (e.target.id === "q") { S.q = e.target.value; keepFocus("q", renderShows); }
  else if (e.target.id === "vq") { S.vault.q = e.target.value; keepFocus("vq", renderVault); }
  else if (e.target.id === "f-ticketQty" || e.target.id === "f-ticketTotal") {
    const q = Number($("#f-ticketQty")?.value), t = Number($("#f-ticketTotal")?.value), out = $("#f-perTicket");
    if (out) out.textContent = q > 0 && t > 0 ? money2(t / q) : "–";
  }
});
document.addEventListener("change", e => {
  if (e.target.dataset && e.target.dataset.setting) { saveSetting(e.target.dataset.setting, e.target.value).then(() => { if (S.tab === "me") renderMe(); }); return; }
  if (e.target.id === "sort") { S.sort = e.target.value; try { localStorage.setItem("pitlog.sort", S.sort); } catch(_){} renderShows(); return; }
  const up = e.target.dataset && e.target.dataset.upkind;
  if (up) { const files = [...(e.target.files || [])]; e.target.value = ""; readForm(); handleFiles(up, files); return; }
  if (e.target.id === "f-lineup" && draft) { readForm(); renderSheet(); }
  if (e.target.id === "avatarFile") { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) uploadAvatar(f); }
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
  let h = "";
  if (s.addedBy && ME && s.addedBy !== ME.uid && !(opts && opts.friend)) h += `<span class="chip fam">Added by @${esc((FR[s.addedBy] && FR[s.addedBy].handle) || "family")}</span>`;
  if (opts && opts.friend) {
    if (S.tab !== "crew" && FR[opts.friend]) h += `<span class="chip crewtag">@${esc(FR[opts.friend].handle)}</span>`;
    return h + (S.shows.some(o => sameShow(s, o)) ? `<span class="chip tog">You were there</span>` : "");
  }
  if (!S.crewOn && S.tab !== "crew") return h;
  return h + togetherWith(s).filter(f => !f.family).map(f => `<span class="chip tog">w/ @${esc(f.handle)}</span>`).join("");
}

/* ---------- Crew overlay (toggle) ---------- */
function crewToggle(){
  if (!friendList().length) return "";
  return `<button class="crewtog" data-crewtoggle aria-pressed="${!!S.crewOn}" title="Show your crew's shows">${SKULLC(S.crewOn ? "var(--moss)" : "var(--dim)")}<span>Crew ${S.crewOn ? "on" : "off"}</span></button>`;
}
// Friends' shows that aren't already in your log (tagged with _f = friend uid)
function crewOverlay(){
  const out = [];
  for (const f of friendList()) for (const s of (f.shows || [])) {
    if (S.shows.some(o => sameShow(o, s))) continue;
    out.push({ ...s, _f: f.uid });
  }
  return out;
}
function crewStats(){
  const inY = s => S.year === "all" || parse(s.date).y === Number(S.year);
  const mine = S.shows.filter(s => inY(s) && !isUpcoming(s));
  const rows = [{ name: "You", n: mine.length, t: null, me: true }].concat(friendList().filter(f => f.loaded && !f.err && !f.statsHidden).map(f => {
    const theirs = (f.shows || []).filter(s => inY(s) && !isUpcoming(s));
    return { name: "@" + f.handle, n: theirs.length, t: mine.filter(s => theirs.some(o => sameShow(s, o))).length, family: f.family };
  })).sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...rows.map(r => r.n));
  const top = rows.filter(r => !r.me && !r.family && r.t).sort((a, b) => b.t - a.t)[0];
  return `<section class="crewstat"><h2>Crew standings</h2>
    ${top ? `<div class="ro" style="margin-bottom:8px">Most shows together: <b style="color:var(--bone)">${esc(top.name)}</b> · ${top.t}</div>` : ""}
    <div class="rank">${rows.map(r => `<div class="row"><span class="n">${esc(r.name)}${r.family ? ` <span class="chip fam">Family</span>` : ""}${r.t ? ` <span class="lbl" style="color:var(--moss)">${r.t} together</span>` : ""}</span><span class="num lbl" style="color:var(--bone)">${r.n}</span><div class="track"><i style="width:${(r.n / max * 100).toFixed(1)}%;${r.me ? "background:var(--bone)" : ""}"></i></div></div>`).join("")}</div></section>`;
}

/* ---------- Crew Family (linked logs) ---------- */
const SHARED = ["date", "lineup", "venue", "city", "tour", "unsure"];
const reqWith = uid => REQ.in.concat(REQ.out).find(r => r.status === "accepted" && (r.from === uid || r.to === uid));
async function setFamily(uid, state){
  const r = reqWith(uid); if (!r) return;
  const patch = { family: state, familyAt: serverTimestamp() };
  if (state === "pending") patch.familyBy = ME.uid;
  try {
    await updateDoc(doc(fdb, "friendRequests", r.id), patch);
    const h = (FR[uid] && FR[uid].handle) || "them";
    toast(state === "pending" ? `Family invite sent to @${h}` : state === "active" ? `You and @${h} are Crew Family. Syncing your logs…` : "Crew Family turned off", 3500);
  } catch (e) { handleWriteErr(e); }
}
let famTimer = null, famBusy = false, famAgain = false;
function scheduleFamilySync(){ clearTimeout(famTimer); famTimer = setTimeout(familySync, 1500); }
async function familySync(){
  if (!ME || !S.loaded) return;
  if (famBusy) { famAgain = true; return; }
  famBusy = true; let made = 0;
  try {
    for (const f of friendList().filter(f => f.family && f.loaded && !f.err)) {
      for (const s of S.shows) {
        if (Array.isArray(s.familySynced) && s.familySynced.includes(f.uid)) continue; // already shared (or they removed their copy)
        const all = f.raw || f.shows;
        let p = s.linkId && all.find(x => x.linkId === s.linkId);
        if (!p) p = all.find(x => sameShow(s, x));
        const lid = s.linkId || (p && p.linkId) || ("L" + rid());
        if (p) { if (p.linkId !== lid) await updateDoc(doc(fdb, "users", f.uid, "shows", p.id), { linkId: lid }); }
        else {
          const copy = { linkId: lid, addedBy: ME.uid, wentWith: [], rating: 0, pit: 0, spot: "", best: "", highlight: "", setlist: "", notes: "", ticket: null, ticketQty: null, ticketTotal: null, merchSpend: null, miles: s.miles ?? null, poster: s.poster || null, photos: [], merch: [] };
          for (const k of SHARED) copy[k] = s[k] ?? (k === "lineup" ? [] : k === "unsure" ? false : "");
          await setDoc(doc(fdb, "users", f.uid, "shows", lid), copy); made++;
        }
        await updateDoc(myShow(s.id), { linkId: lid, familySynced: arrayUnion(f.uid) });
      }
    }
    // Tour posters are shared across linked logs: fill in any linked copy that's missing yours.
    for (const f of friendList().filter(f => f.family && f.loaded && !f.err)) for (const s of S.shows) {
      if (!s.linkId || !s.poster) continue;
      const p = (f.raw || f.shows).find(x => x.linkId === s.linkId);
      if (p && !p.poster && !(Array.isArray(p.posterCleared) && p.posterCleared.includes(s.poster.url))) await updateDoc(doc(fdb, "users", f.uid, "shows", p.id), { poster: s.poster });
    }
    if (made) toast(`Shared ${made} show${made > 1 ? "s" : ""} with your Crew Family`, 3000);
  } catch (e) { console.error("family sync", e); }
  famBusy = false;
  if (famAgain) { famAgain = false; scheduleFamilySync(); }
}
// Send a poster change (new, replaced or removed) to every linked copy of this show.
async function pushPoster(show, poster){
  if (!show || !show.linkId) return;
  for (const f of friendList().filter(f => f.family)) {
    const p = (f.raw || f.shows || []).find(x => x.linkId === show.linkId);
    if (p) { try { await updateDoc(doc(fdb, "users", f.uid, "shows", p.id), { poster: poster || null }); } catch (e) { console.error("push poster", e); } }
  }
}
async function pushShared(show){
  if (!show || !show.linkId) return;
  const patch = { syncedAt: serverTimestamp() }; for (const k of SHARED) patch[k] = show[k] ?? (k === "lineup" ? [] : k === "unsure" ? false : "");
  for (const f of friendList().filter(f => f.family)) {
    const p = (f.raw || f.shows || []).find(x => x.linkId === show.linkId);
    if (p) { try { await updateDoc(doc(fdb, "users", f.uid, "shows", p.id), patch); } catch (e) { console.error("push shared", e); } }
  }
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
  if (FR[uid]) { if (!FR[uid].live) Object.assign(FR[uid], info); return; }
  const f = FR[uid] = { uid, shows: [], loaded: false, err: "", ...info };
  f.unsub = onSnapshot(collection(fdb, "users", uid, "shows"), snap => {
    f.raw = snap.docs.map(d => ({ id: d.id, ...d.data() })); applyPrivacy(f); f.loaded = true; f.err = "";
    if (f.family) { applyPrivacy(f); scheduleFamilySync(); }
    rerenderSoft();
  }, err => { f.err = err.code === "permission-denied" ? "Their log isn't shared with you yet." : "Couldn't load their log."; f.loaded = true; rerenderSoft(); });
  f.unsubP = onSnapshot(doc(fdb, "users", uid), p => { if (p.exists()) { const d = p.data(); f.live = true; Object.assign(f, { name: d.name || f.name, handle: d.handle || f.handle, photo: d.photoURL || f.photo, bio: d.bio || "", favBand: d.favBand || "", favBands: d.favBands || [], favVenue: d.favVenue || "", settings: d.settings || {} }); applyPrivacy(f); rerenderSoft(); } }, () => {});
}
// Friends' privacy settings decide what this app shows of their log. f.raw keeps the full
// docs for Crew Family syncing; everything you see goes through f.shows.
function redactShow(s, set, f){
  const ok = k => canSee(set, k, f), o = { ...s };
  if (!ok("ticketCost")) { o.ticket = null; o.ticketQty = null; o.ticketTotal = null; }
  if (!ok("merchCost")) o.merchSpend = null;
  if (!ok("photos")) { o.photos = []; o.merch = []; }
  if (!ok("poster") && !(f.family && s.linkId)) o.poster = null;
  if (!ok("ratings")) { o.rating = 0; o.pit = 0; o.best = ""; }
  if (!ok("notes")) { o.notes = ""; o.highlight = ""; o.setlist = ""; }
  if (!ok("wentWith")) { o.tagged = tagsOf(s).filter(t => ME && t.uid === ME.uid); o.wentWith = o.tagged.map(t => t.name); }
  if (!ok("spot")) { o.spot = ""; o.miles = null; }
  return o;
}
function applyPrivacy(f){
  if (!f.raw) return;
  const set = settingsOf(f);
  f.shows = f.raw.filter(s => canSee(set, "upcoming", f) || !isUpcoming(s)).map(s => redactShow(s, set, f));
  f.statsHidden = !canSee(set, "stats", f);
}
function dropFriend(uid){ const f = FR[uid]; if (!f) return; try { f.unsub && f.unsub(); f.unsubP && f.unsubP(); } catch(_){} delete FR[uid]; }

function syncFriends(){
  const keep = new Set();
  for (const r of REQ.in.concat(REQ.out)) {
    if (r.status !== "accepted") continue;
    const other = r.from === ME.uid ? { uid: r.to, name: r.toName, handle: r.toHandle, photo: r.toPhoto } : { uid: r.from, name: r.fromName, handle: r.fromHandle, photo: r.fromPhoto };
    keep.add(other.uid); watchFriend(other.uid, other);
    FR[other.uid].family = r.family === "active"; FR[other.uid].famState = r.family || "off"; FR[other.uid].famBy = r.familyBy || "";
    applyPrivacy(FR[other.uid]); // family vs crew changes what their settings let you see
  }
  for (const uid of Object.keys(FR)) if (!keep.has(uid)) dropFriend(uid);
  rerenderSoft(); scheduleFamilySync();
}
function rerenderSoft(){ updateCrewBadge(); if (S.tab === "search") return; if (S.open || LB || $("#modalRoot").innerHTML) return; if (S.tab !== "vault") renderTab(); }

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
  try { await updateDoc(doc(fdb, "friendRequests", r.id), { status: "accepted", acceptedAt: serverTimestamp() }); toast(`You and @${(PEOPLE[r.from] && PEOPLE[r.from].handle) || r.fromHandle} are connected`); }
  catch (e) { handleWriteErr(e); }
}
async function removeRequest(id, msg){ try { await deleteDoc(doc(fdb, "friendRequests", id)); if (msg) toast(msg); } catch (e) { handleWriteErr(e); } }

/* ---------- Public layer: what people outside your crew can see ---------- */
// Your full shows stay readable only by you and your crew. For people outside the crew, the app
// writes a separate copy of each show to publicShows/{uid}_{showId} with ONLY the fields you set
// to Public. The Firestore rules let any signed-in user read publicShows, so hidden fields never
// leave your account.
const normBand = b => String(b || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
const PUBLIC_FIELDS = { ticketCost: ["ticket", "ticketQty", "ticketTotal"], merchCost: ["merchSpend"], photos: ["photos", "merch"], poster: ["poster"],
  ratings: ["rating", "pit", "best"], notes: ["notes", "highlight", "setlist"], wentWith: ["wentWith"], spot: ["spot", "miles"] };
function publicPayload(sh, set){
  const o = { ownerUid: ME.uid, ownerHandle: PROFILE.handle || "", ownerName: PROFILE.name || "", ownerPhoto: PROFILE.photoURL || "", showId: sh.id,
    date: sh.date || "", lineup: lineup(sh), bandKeys: [...new Set(lineup(sh).map(normBand).filter(Boolean))], venue: sh.venue || "", city: sh.city || "", tour: sh.tour || "", unsure: !!sh.unsure };
  for (const [k, fields] of Object.entries(PUBLIC_FIELDS)) if (set[k] === "public") for (const fld of fields) {
    let v = sh[fld]; if (v === undefined) v = null;
    if (fld === "photos" || fld === "merch") v = items(sh, fld).map(m => ({ url: m.url, type: m.type || "image", bands: m.bands || [] }));
    if (fld === "poster") v = sh.poster ? { url: pid(sh.poster) } : null;
    o[fld] = v;
  }
  return o;
}
const stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v ?? null);
let pubTimer = null, pubBusy = false, pubAgain = false, pubForce = false;
function schedulePublish(force){ if (force) pubForce = true; clearTimeout(pubTimer); pubTimer = setTimeout(publishAll, 2500); }
async function publishAll(){
  if (!ME || !PROFILE || !S.loaded) return;
  if (pubBusy) { pubAgain = true; return; }
  pubBusy = true;
  try {
    const set = MY();
    const want = new Map();
    if (set.publicShows === "public") for (const sh of S.shows) {
      if (isUpcoming(sh) && set.upcoming !== "public") continue;
      want.set(ME.uid + "_" + sh.id, publicPayload(sh, set));
    }
    const have = new Map((await getDocs(query(collection(fdb, "publicShows"), where("ownerUid", "==", ME.uid)))).docs.map(d => [d.id, d.data()]));
    const ops = [];
    for (const [id, data] of want) if (pubForce || !have.has(id) || stable(have.get(id)) !== stable(data)) ops.push(["set", id, data]);
    for (const id of have.keys()) if (!want.has(id)) ops.push(["del", id]);
    for (let i = 0; i < ops.length; i += 400) {
      const b = writeBatch(fdb);
      for (const [op, id, data] of ops.slice(i, i + 400)) op === "set" ? b.set(doc(fdb, "publicShows", id), data) : b.delete(doc(fdb, "publicShows", id));
      await b.commit();
    }
    pubForce = false;
  } catch (e) { console.warn("public profile sync", e.code || e); }
  pubBusy = false;
  if (pubAgain) { pubAgain = false; schedulePublish(); }
}
// Lowercased name on the profile doc so people can search by name.
async function syncSearchFields(){
  const nl = String(PROFILE.name || "").trim().toLowerCase();
  if (PROFILE.nameLower === nl) return;
  try { await updateDoc(doc(fdb, "users", ME.uid), { nameLower: nl }); PROFILE.nameLower = nl; } catch (_) {}
}

/* ---------- Search: people and bands ---------- */
S.search = { mode: "people", q: "", people: null, bands: null, busy: false, profile: null, pub: null };
let searchTimer = null, searchSeq = 0;
function relationOf(uid){
  if (ME && uid === ME.uid) return "me";
  if (FR[uid]) return FR[uid].family ? "family" : "crew";
  if (REQ.out.some(r => r.to === uid && r.status === "pending")) return "sent";
  if (REQ.in.some(r => r.from === uid && r.status === "pending")) return "asked";
  return "";
}
const relChip = rel => rel === "family" ? `<span class="chip fam">Family</span>` : rel === "crew" ? `<span class="chip tog">Crew</span>` : rel === "sent" ? `<span class="chip unsure">Request sent</span>` : rel === "asked" ? `<span class="chip unsure">Wants to connect</span>` : rel === "me" ? `<span class="chip">You</span>` : "";
function runSearch(){
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq, q = S.search.q.trim();
    if (S.search.mode === "people") S.search.people = q.replace(/^@/, "").length >= 2 ? await searchPeople(q) : null;
    else S.search.bands = q.length >= 2 ? await searchBands(q) : null;
    if (seq === searchSeq && S.tab === "search" && !S.search.profile) drawSearchResults();
  }, 300);
}
async function searchPeople(q){
  const h = q.replace(/^@/, "").toLowerCase(), out = new Map();
  const take = snap => snap.docs.forEach(d => out.set(d.id, { uid: d.id, ...d.data() }));
  try {
    await Promise.all([
      getDocs(query(collection(fdb, "users"), orderBy("handle"), where("handle", ">=", h), where("handle", "<=", h + "\uf8ff"), limit(12))).then(take),
      getDocs(query(collection(fdb, "users"), orderBy("nameLower"), where("nameLower", ">=", h), where("nameLower", "<=", h + "\uf8ff"), limit(12))).then(take)]);
  } catch (e) { console.warn("people search", e); }
  // Friends always show up; anyone else only if they allow search.
  for (const f of friendList()) if ([f.name, f.handle].some(x => String(x || "").toLowerCase().includes(h))) out.set(f.uid, { uid: f.uid, name: f.name, handle: f.handle, photoURL: f.photo, settings: f.settings });
  return [...out.values()].filter(u => u.uid !== ME.uid && (FR[u.uid] || settingsOf(u).searchable === "public"))
    .sort((a, b) => (!!FR[b.uid] - !!FR[a.uid]) || String(a.handle).localeCompare(String(b.handle)));
}
async function searchBands(q){
  const key = normBand(q), groups = new Map();
  const add = (sh, who) => {
    const k = sh.date + "|" + normBand(sh.venue) + "|" + normBand(lineup(sh)[0]);
    const g = groups.get(k) || { show: sh, people: [] }; groups.set(k, g);
    if (!g.people.some(p => p.uid === who.uid)) g.people.push(who);
    if (who.uid === ME.uid) g.show = sh;
  };
  const hit = sh => lineup(sh).some(b => normBand(b).includes(key));
  for (const sh of S.shows) if (hit(sh)) add(sh, { uid: ME.uid, handle: PROFILE.handle, me: true, id: sh.id });
  for (const f of friendList()) for (const sh of (f.shows || [])) if (hit(sh)) add(sh, { uid: f.uid, handle: f.handle, friend: true, id: sh.id });
  try {
    const snap = await getDocs(query(collection(fdb, "publicShows"), where("bandKeys", "array-contains", key), limit(100)));
    for (const d of snap.docs) { const x = d.data(); if (x.ownerUid === ME.uid || FR[x.ownerUid]) continue; add({ ...x, id: x.showId }, { uid: x.ownerUid, handle: x.ownerHandle, pub: true, id: x.showId }); }
  } catch (e) { console.warn("band search", e); }
  const all = [...groups.values()];
  return { up: all.filter(g => isUpcoming(g.show)).sort((a, b) => a.show.date.localeCompare(b.show.date)),
           past: all.filter(g => !isUpcoming(g.show)).sort((a, b) => b.show.date.localeCompare(a.show.date)) };
}
function bandSuggestions(q){
  const k = normBand(q); if (k.length < 2) return [];
  const names = new Map();
  for (const sh of [...S.shows, ...friendList().flatMap(f => f.shows || [])]) for (const b of lineup(sh)) if (normBand(b).includes(k)) names.set(normBand(b), b);
  return [...names.values()].slice(0, 8);
}
function renderSearch(){
  if (S.search.profile) return renderPublicProfile(S.search.profile);
  const m = S.search.mode;
  $("#view").innerHTML = `<div class="crew searchv">
    <div class="seg vswitch" role="group" aria-label="Search for"><button data-smode="people" aria-pressed="${m === "people"}">People</button><button data-smode="bands" aria-pressed="${m === "bands"}">Bands</button></div>
    <input class="search" id="sq" value="${esc(S.search.q)}" placeholder="${m === "people" ? "Name or @username" : "Band name"}" autocapitalize="none" spellcheck="false" aria-label="Search">
    <div id="sres"></div></div>`;
  drawSearchResults();
}
function drawSearchResults(){
  const box = $("#sres"); if (!box) return;
  const q = S.search.q.trim(), m = S.search.mode;
  if (m === "people") {
    const list = S.search.people;
    if (!list) { box.innerHTML = `<div class="ro">Find friends by name or username. Only people who allow search show up, plus your own crew.</div>`; return; }
    if (!list.length) { box.innerHTML = `<div class="empty"><h3>No one found</h3><div>Check the spelling, or ask them for their username.</div></div>`; return; }
    box.innerHTML = `<div class="plist">${list.map(u => `<button class="prow tap" data-sprof="${esc(u.uid)}">${avatar(u.photoURL, u.name)}<div class="pt"><div class="nm">${esc(u.name || u.handle)}</div><div class="hd">@${esc(u.handle)} ${relChip(relationOf(u.uid))}</div></div></button>`).join("")}</div>`;
    return;
  }
  const sug = bandSuggestions(q).filter(b => !ieq(b, q));
  const res = S.search.bands;
  let h = sug.length ? `<div class="tagrow" style="margin-bottom:10px">${sug.map(b => `<button class="tagbtn" data-sband="${esc(b)}">${esc(b)}</button>`).join("")}</div>` : "";
  if (!res) h += `<div class="ro">Search a band to see every show of theirs logged by you, your crew, and people with public profiles.</div>`;
  else if (!res.up.length && !res.past.length) h += `<div class="empty"><h3>No shows found</h3><div>Nobody you can see has logged "${esc(q)}" yet.</div></div>`;
  else {
    const row = g => { const sh = g.show, p = parse(sh.date), lu = lineup(sh), mine = g.people.find(x => x.me);
      const who = g.people.map(x => `<button class="chip ${x.me ? "" : x.friend ? "tog" : "crewtag"}" data-sprof="${esc(x.uid)}">${x.me ? "You" : "@" + esc(x.handle)}</button>`).join("");
      const open = mine ? `data-open="${esc(mine.id)}"` : g.people.find(x => x.friend) ? `data-fopen="${esc(g.people.find(x => x.friend).uid)}|${esc(g.people.find(x => x.friend).id)}"` : `data-sprof="${esc(g.people[0].uid)}"`;
      return `<div class="bandhit"><button class="prow tap prow-show" ${open}><span class="pdate"><b class="num">${p.d}</b>${MONTHS[(p.m||1)-1]} ${p.y}</span>
        <div class="pt"><div class="nm" style="font-size:20px">${esc(lu[0] || "Show")}</div>${lu.length > 1 ? `<div class="ro">w/ ${esc(lu.slice(1).join(" · "))}</div>` : ""}<div class="ro">${esc([sh.venue, sh.city].filter(Boolean).join(" — ") || "Venue unknown")}</div></div></button>
        <div class="tagrow who"><span class="lbl">${g.people.length} went</span>${who}</div></div>`; };
    if (res.up.length) h += `<section class="sect"><h3>Coming up <span class="lbl">${res.up.length}</span></h3>${res.up.map(row).join("")}</section>`;
    if (res.past.length) h += `<section class="sect"><h3>Past shows <span class="lbl">${res.past.length}</span></h3>${res.past.map(row).join("")}</section>`;
  }
  box.innerHTML = h;
}
async function openProfile(uid){
  if (uid === ME.uid) { S.tab = "me"; renderTab(); window.scrollTo(0, 0); return; }
  if (FR[uid]) { S.tab = "crew"; S.crewSel = uid; S.crewView = "shows"; renderTab(); window.scrollTo(0, 0); return; }
  S.tab = "search"; S.search.profile = uid; S.search.pub = null; renderTab(); window.scrollTo(0, 0);
  try {
    const [u, shows] = await Promise.all([getDoc(doc(fdb, "users", uid)), getDocs(query(collection(fdb, "publicShows"), where("ownerUid", "==", uid)))]);
    S.search.pub = { uid, user: u.exists() ? u.data() : {}, shows: shows.docs.map(d => ({ ...d.data(), id: d.data().showId || d.id })) };
  } catch (e) { S.search.pub = { uid, user: {}, shows: [], err: true }; }
  if (S.search.profile === uid) renderPublicProfile(uid);
}
function renderPublicProfile(uid){
  const P = S.search.pub;
  const back = `<button class="btn ghost" data-sback style="justify-self:start">← Search</button>`;
  if (!P || P.uid !== uid) { $("#view").innerHTML = `<div class="crew">${back}<div class="ro">Loading…</div></div>`; return; }
  const u = P.user, set = settingsOf(u), rel = relationOf(uid);
  const shows = [...P.shows].sort((a, b) => (b.date || "").localeCompare(a.date || "")), done = shows.filter(x => !isUpcoming(x));
  const top = profileTop({ name: u.name, handle: u.handle, photo: u.photoURL, bio: u.bio, favBands: favList(u), favVenue: u.favVenue || "" }, false, null);
  const act = rel === "sent" ? `<span class="chip unsure">Request sent</span>` : rel === "asked" ? `<button class="btn red" data-sacceptfrom="${esc(uid)}">Accept their request</button>` : `<button class="btn red" data-sadd="${esc(u.handle || "")}">Add to crew</button>`;
  const bands = counts(done.flatMap(lineup)), venues = counts(done.map(x => x.venue || "")).filter(v => v.name);
  const tile = (l, v) => `<div class="tile"><div class="lbl">${l}</div><div class="v num">${v}</div></div>`;
  const stats = set.stats === "public" && shows.length ? `<div class="tiles">${tile("Shows", done.length)}${tile("Bands seen", bands.length)}${tile("Venues", venues.length)}</div>` : "";
  const list = shows.length ? `<section class="sect"><h3>Shows <span class="lbl">${shows.length}</span></h3><div class="list">${shows.map(pubTicket).join("")}</div></section>`
    : `<div class="empty"><h3>Nothing public</h3><div>@${esc(u.handle || "")} keeps their shows to their crew. Add them to see more once they accept.</div></div>`;
  $("#view").innerHTML = `<div class="crew">${back}<section class="prof">${top}</section><div class="prof-act">${act}</div>${stats}${list}</div>`;
}
// Read-only card for a public show (only the fields its owner made public are present).
function pubTicket(sh){
  const p = parse(sh.date), lu = lineup(sh), up = isUpcoming(sh), r = Number(sh.rating) || 0;
  const thumbs = [sh.poster && sh.poster.url, ...(sh.photos || []).map(m => m.url)].filter(Boolean).slice(0, 4);
  return `<div class="ticket ${up ? "upcoming" : ""}" style="cursor:default">
    <div class="stub"><div class="mo">${MONTHS[(p.m||1)-1].toUpperCase()}</div><div class="dd num">${p.d||"?"}</div><div class="dw">${DAYS[p.dt.getDay()]}</div></div>
    <div class="tbody"><div class="head">${esc(lu[0] || "Show")}</div>${lu.length > 1 ? `<div class="sup"><b>w/</b> ${esc(lu.slice(1).join(" · "))}</div>` : ""}
      <div class="venue">${esc([sh.venue, sh.city].filter(Boolean).join(" — ") || "Venue unknown")}</div>
      <div class="chips">${up ? `<span class="chip up">Upcoming</span>` : ""}${!up && r ? `<span class="skulls">${[1,2,3,4,5].map(i => SKULLV(r, i)).join("")}</span>` : ""}
        ${S.shows.some(o => sameShow(o, sh)) ? `<span class="chip tog">You were there</span>` : ""}${sh.spot ? `<span class="chip">${esc(sh.spot)}</span>` : ""}</div>
      ${sh.notes ? `<div class="ro" style="margin-top:6px">${esc(sh.notes)}</div>` : ""}
      ${thumbs.length ? `<div class="thumbs">${thumbs.map(x => `<img src="${esc(x)}" alt="" loading="lazy" onerror="this.remove()">`).join("")}</div>` : ""}</div></div>`;
}
function searchClick(t){
  if (t.dataset.smode) { S.search.mode = t.dataset.smode; S.search.q = ""; renderSearch(); $("#sq").focus(); return true; }
  if (t.dataset.sprof) { openProfile(t.dataset.sprof); return true; }
  if (t.dataset.sband) { S.search.q = t.dataset.sband; renderSearch(); runSearch(); return true; }
  if (t.hasAttribute("data-sback")) { S.search.profile = null; renderSearch(); return true; }
  if (t.dataset.sadd !== undefined) { sendRequest(t.dataset.sadd).then(() => { if (S.search.profile) renderPublicProfile(S.search.profile); }); return true; }
  if (t.dataset.sacceptfrom) { const r = REQ.in.find(x => x.from === t.dataset.sacceptfrom && x.status === "pending"); if (r) acceptRequest(r); return true; }
  return false;
}
document.addEventListener("input", e => { if (e.target.id === "sq") { S.search.q = e.target.value; if (S.search.mode === "bands") { const box = $("#sres"); if (box && !S.search.bands) drawSearchResults(); } runSearch(); } });

/* ---------- Calendar export (.ics + Google link) ---------- */
// Shows have no start time, so each is an all-day event. UIDs are stable per show,
// so importing the file again updates events instead of doubling them (Apple, Outlook).
const icsDay = iso => String(iso || "").replace(/-/g, "");
const nextDay = iso => { const p = parse(iso); const d = new Date(p.y, p.m - 1, p.d + 1); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0"); };
const icsText = v => String(v || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");
function icsFold(line){ const out = []; let l = line; while (l.length > 74) { out.push(l.slice(0, 74)); l = " " + l.slice(74); } out.push(l); return out.join("\r\n"); }
function eventTitle(s){ const lu = lineup(s); return (lu[0] || "Show") + (lu.length > 1 ? " w/ " + lu.slice(1).join(", ") : "") + (s.unsure ? " (maybe)" : ""); }
function eventDetails(s){
  const lu = lineup(s), bits = [];
  if (s.tour) bits.push("Tour: " + s.tour);
  if (lu.length) bits.push("Lineup: " + lu.join(", "));
  if (crew(s).length) bits.push("Went with: " + crew(s).join(", "));
  bits.push("Logged in Pit Log");
  return bits.join("\n");
}
const eventPlace = s => [s.venue, s.city].filter(Boolean).join(", ");
function buildIcs(list){
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pit Log//Shows//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Pit Log shows"];
  for (const s of list) {
    if (!s.date) continue;
    L.push("BEGIN:VEVENT", "UID:" + (s.linkId || s.id) + "@pitlog", "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + icsDay(s.date), "DTEND;VALUE=DATE:" + nextDay(s.date),
      "SUMMARY:" + icsText(eventTitle(s)));
    if (eventPlace(s)) L.push("LOCATION:" + icsText(eventPlace(s)));
    L.push("DESCRIPTION:" + icsText(eventDetails(s)), "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(icsFold).join("\r\n") + "\r\n";
}
async function deliverIcs(list, name){
  if (!list.length) { toast("No shows to export"); return; }
  const file = new File([buildIcs(list)], name, { type: "text/calendar" });
  // Installed iPhone apps can't download files, so hand it to the share sheet there.
  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios && standalone && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Pit Log shows" }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(file), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Calendar file ready · ${list.length} show${list.length === 1 ? "" : "s"}`, 3500);
}
function googleCalUrl(s){
  const q = new URLSearchParams({ action: "TEMPLATE", text: eventTitle(s), dates: icsDay(s.date) + "/" + nextDay(s.date), details: eventDetails(s) });
  if (eventPlace(s)) q.set("location", eventPlace(s));
  return "https://calendar.google.com/calendar/render?" + q.toString();
}
const slug = s => (lineup(s)[0] || "show").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "show";
function exportMenu(){
  const mine = sorted(), up = mine.filter(isUpcoming), yr = S.cal.y, inYr = mine.filter(s => parse(s.date).y === yr);
  const opts = [["up", "Upcoming shows", up], ["year", `All of ${yr}`, inYr], ["all", "Everything I've logged", mine]];
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Export calendar"><div class="mbox">
    <h3>Export calendar</h3>
    <div class="ro">Makes a calendar file of your shows as all-day events, with the lineup, venue and who you went with.</div>
    ${opts.map(([k, l, list]) => `<button class="btn ${k === "up" ? "red" : ""}" data-exp="${k}" ${list.length ? "" : "disabled"} style="text-align:left">${l} <span class="lbl">${list.length}</span></button>`).join("")}
    <div class="ro"><b>iPhone:</b> open the file and tap Add All. <b>Android:</b> open it with your calendar app. <b>Google Calendar:</b> on a computer, go to calendar.google.com, Settings, Import &amp; export, and import the file.</div>
    <div class="ro">Exporting again later updates the same events in Apple Calendar instead of adding copies. It's a snapshot, so new shows need another export.</div>
    <div class="mbtns"><button class="btn ghost" data-mclose>Close</button></div>
  </div></div>`;
  root.querySelector("[data-mclose]").onclick = () => root.innerHTML = "";
  for (const b of root.querySelectorAll("[data-exp]")) b.onclick = () => {
    const [k, , list] = opts.find(o => o[0] === b.dataset.exp);
    root.innerHTML = ""; deliverIcs(list, `pit-log-${k === "year" ? yr : k === "up" ? "upcoming" : "all"}.ics`);
  };
}

/* ---------- Crew tagging ---------- */
const splitKey = k => { const i = k.indexOf("|"); return [k.slice(0, i), k.slice(i + 1)]; };
function tagPicker(d, ro){
  const on = new Set(tagsOf(d).map(t => t.uid));
  const fl = friendList().filter(f => on.has(f.uid) || canSee(settingsOf(f), "tagMe", f)); if (!fl.length) return "";
  if (ro) { const tg = tagsOf(d); return tg.length ? `<div class="tagrow">${tg.map(t => `<span class="chip crew tg">${esc(t.name)}${FR[t.uid] ? ` · @${esc(FR[t.uid].handle)}` : ""}</span>`).join("")}</div>` : ""; }
  return `<div class="field"><span class="lbl">Tag crew with an account</span><div class="tagrow">${fl.map(f =>
    `<button type="button" class="tagbtn tagf" data-tagf="${esc(f.uid)}" aria-pressed="${on.has(f.uid)}">${avatar(f.photo, f.name, "sm")}@${esc(f.handle)}</button>`).join("")}</div></div>`;
}
function toggleTag(uid){
  const f = FR[uid]; if (!f || !draft) return;
  const names = crew(draft), tags = tagsOf(draft);
  if (tags.some(t => t.uid === uid)) {
    const gone = tags.filter(t => t.uid === uid).map(t => t.name.toLowerCase());
    draft.wentWith = names.filter(n => !gone.includes(n.toLowerCase()));
    draft.tagged = tags.filter(t => t.uid !== uid);
  } else {
    let name = names.find(n => nameMatches(f, n) && !tagFor(draft, n));
    if (!name) { name = firstName(f); if (names.some(n => ieq(n, name))) name = f.name || f.handle; draft.wentWith = names.concat(name); }
    draft.tagged = tags.concat({ name, uid });
  }
  draft.taggedUids = [...new Set(draft.tagged.map(t => t.uid))];
  renderSheet();
}

// Names in your log that aren't linked to anyone yet, with how many shows each is on.
function untaggedNames(){
  const m = new Map();
  for (const s of S.shows) for (const n of crew(s)) {
    if (tagFor(s, n)) continue;
    const k = n.toLowerCase(); const e = m.get(k) || { name: n, n: 0 }; e.n++; m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}
function linkedNames(uid){
  const m = new Map();
  for (const s of S.shows) for (const t of tagsOf(s)) if (t.uid === uid) { const k = t.name.toLowerCase(); const e = m.get(k) || { name: t.name, n: 0 }; e.n++; m.set(k, e); }
  return [...m.values()].sort((a, b) => b.n - a.n);
}
async function writeTags(changes, msg){
  if (!changes.length) return;
  try {
    for (let i = 0; i < changes.length; i += 400) {
      const b = writeBatch(fdb);
      for (const [id, tagged] of changes.slice(i, i + 400)) b.update(myShow(id), { tagged, taggedUids: [...new Set(tagged.map(t => t.uid))] });
      await b.commit();
    }
    toast(msg, 3000);
  } catch (e) { handleWriteErr(e); }
}
function linkName(name, uid){
  const f = FR[uid]; if (!f) return;
  const ch = S.shows.filter(s => crew(s).some(n => ieq(n, name)) && !tagFor(s, name))
    .map(s => [s.id, tagsOf(s).concat({ name: crew(s).find(n => ieq(n, name)), uid })]);
  writeTags(ch, `Tagged @${f.handle} on ${ch.length} show${ch.length === 1 ? "" : "s"}`);
}
function unlinkName(name, uid){
  const ch = S.shows.filter(s => tagsOf(s).some(t => t.uid === uid && ieq(t.name, name)))
    .map(s => [s.id, tagsOf(s).filter(t => !(t.uid === uid && ieq(t.name, name)))]);
  writeTags(ch, `Unlinked "${name}" from ${ch.length} show${ch.length === 1 ? "" : "s"}`);
}
function pastTagsBlock(f){
  const linked = linkedNames(f.uid), free = untaggedNames();
  const sugg = free.filter(e => nameMatches(f, e.name)), rest = free.filter(e => !nameMatches(f, e.name));
  const row = (e, btn) => `<div class="prow"><div class="pt"><div class="nm" style="font-size:18px">${esc(e.name)}</div><div class="ro">${e.n} show${e.n === 1 ? "" : "s"} in your log</div></div>${btn}</div>`;
  const key = e => esc(f.uid + "|" + e.name);
  let h = `<section class="sect"><h3>Tags</h3><div class="ro" style="margin-bottom:8px">Link names from your "Went with" lists to @${esc(f.handle)}. Every show with that name gets tagged.</div>`;
  if (linked.length) h += `<div class="plist">${linked.map(e => row(e, `<button class="btn ghost" data-tagunlink="${key(e)}">Unlink</button>`)).join("")}</div>`;
  if (sugg.length) h += `<div class="lbl" style="margin:10px 0 6px">Looks like @${esc(f.handle)}</div><div class="plist">${sugg.map(e => row(e, `<button class="btn red" data-taglink="${key(e)}">Link</button>`)).join("")}</div>`;
  if (rest.length) h += `<details style="margin-top:10px"><summary class="lbl">Other names in your log (${rest.length})</summary><div class="plist" style="margin-top:6px">${rest.map(e => row(e, `<button class="btn" data-taglink="${key(e)}">Link</button>`)).join("")}</div></details>`;
  if (!linked.length && !free.length) h += `<div class="ro">No names to link yet.</div>`;
  return h + `</section>`;
}
// Crew tab nudge: a friend's name already appears on shows logged before they joined.
function pastTagSuggestBlock(){
  const free = untaggedNames(), rows = [];
  for (const f of friendList()) for (const e of free) if (nameMatches(f, e.name)) rows.push({ f, e });
  if (!rows.length) return "";
  return `<section class="sect"><h3>Link past tags <span class="lbl">${rows.length}</span></h3><div class="plist">${rows.map(({ f, e }) => `
    <div class="prow">${avatar(f.photo, f.name)}<div class="pt"><div class="nm" style="font-size:18px">"${esc(e.name)}" → @${esc(f.handle)}</div><div class="ro">On ${e.n} show${e.n === 1 ? "" : "s"} in your log</div></div>
    <button class="btn red" data-taglink="${esc(f.uid + "|" + e.name)}">Link</button></div>`).join("")}</div></section>`;
}

// Friends' shows that tag you and aren't in your log yet.
function tagInbox(){
  const seen = new Set((PROFILE && PROFILE.tagSeen) || []), out = [];
  for (const f of friendList()) for (const s of (f.shows || [])) {
    if (!(Array.isArray(s.taggedUids) && s.taggedUids.includes(ME.uid))) continue;
    if (!canSee(MY(), "tagMe", f)) continue;
    if (seen.has(f.uid + "|" + s.id) || S.shows.some(o => sameShow(o, s))) continue;
    out.push({ f, s });
  }
  return out.sort((a, b) => (b.s.date || "").localeCompare(a.s.date || ""));
}
function tagInboxBlock(){
  const list = tagInbox(); if (!list.length) return "";
  return `<section class="sect"><h3>You were tagged <span class="lbl">${list.length}</span></h3><div class="plist">${list.map(({ f, s }) => {
    const k = esc(f.uid + "|" + s.id);
    return `<div class="tagin">${showRow(s, f.uid, "@" + f.handle + " tagged you")}<div class="tagact"><button class="btn red" data-tagadd="${k}">Add show only</button><button class="btn" data-tagfull="${k}">Add with their details</button><button class="btn ghost" data-tagdis="${k}">Dismiss</button></div></div>`; }).join("")}</div>
    <div class="ro" style="margin-top:8px"><b>Show only</b> adds the date, bands and venue. Your rating, notes, spend and photos start blank. <b>With their details</b> also copies their rating, notes, spend and photos, which you can edit after.</div></section>`;
}
// Accept a tag. "Show only" copies the date, bands and venue and leaves your own night blank.
// "Everything" also brings over their rating, notes, spend, poster and photos.
const PERSONAL = ["rating", "pit", "spot", "best", "highlight", "setlist", "notes", "ticket", "ticketQty", "ticketTotal", "merchSpend", "miles"];
async function copyMedia(m, showId, kind, owner){
  try {
    const r = await fetch(m.url); if (!r.ok) throw new Error(r.status);
    const put = await putImage(await r.blob(), showId, kind);
    return { url: put.url, path: put.path, type: m.type || "image", bands: m.bands || [] };
  } catch (_) {
    // Couldn't copy the file (offline or blocked): point at theirs instead. path "" means we never delete it.
    return { url: m.url, path: "", type: m.type || "image", bands: m.bands || [], sharedFrom: owner };
  }
}
async function addTaggedShow(uid, id, full){
  const f = FR[uid]; const s = f && (f.shows || []).find(x => x.id === id); if (!s || busy) return;
  if (S.shows.some(o => sameShow(o, s))) { toast("That show is already in your log"); return; }
  const tagged = [{ name: firstName(f), uid }];
  for (const t of tagsOf(s)) if (t.uid !== ME.uid && FR[t.uid] && !tagged.some(x => x.uid === t.uid)) tagged.push({ name: firstName(FR[t.uid]), uid: t.uid });
  const names = tagged.map(t => t.name);
  if (full) for (const n of crew(s)) if (!tagFor(s, n) && !nameMatches(PROFILE, n) && !names.some(x => ieq(x, n))) names.push(n);
  const body = { wentWith: names, tagged, taggedUids: tagged.map(t => t.uid), rating: 0, pit: 0, spot: "", best: "", highlight: "", setlist: "", notes: "",
    ticket: null, ticketQty: null, ticketTotal: null, merchSpend: null, miles: null, poster: null, photos: [], merch: [],
    copiedFrom: { uid, id, full: !!full } };
  for (const k of SHARED) body[k] = s[k] ?? (k === "lineup" ? [] : k === "unsure" ? false : "");
  const newId = rid();
  busy = true;
  try {
    if (full) {
      for (const k of PERSONAL) if (s[k] != null) body[k] = s[k];
      const media = [...items(s, "photos").map(m => ["photos", m]), ...items(s, "merch").map(m => ["merch", m])];
      if (s.poster) media.unshift(["poster", { url: pid(s.poster), type: "image" }]);
      let n = 0;
      for (const [kind, m] of media) {
        toast(`Copying photos ${++n} of ${media.length}…`, 60000);
        const c = await copyMedia(m, newId, kind, uid);
        if (kind === "poster") body.poster = { url: c.url, path: c.path, ...(c.sharedFrom ? { sharedFrom: c.sharedFrom } : {}) };
        else body[kind].push(c);
      }
    }
    await setDoc(myShow(newId), body);
    toast(`Added ${lineup(s)[0] || "the show"} to your log${full ? " with their details" : ""}`, 3500);
  } catch (e) { handleWriteErr(e); }
  busy = false;
}
async function dismissTag(key){
  PROFILE.tagSeen = [...new Set([...(PROFILE.tagSeen || []), key])];
  rerenderSoft();
  try { await updateDoc(doc(fdb, "users", ME.uid), { tagSeen: arrayUnion(key) }); } catch (e) { handleWriteErr(e); }
}

// Current name/handle for someone in a pending request (the request stores what they were at the time).
const PEOPLE = {};
function person(uid, name, handle, photo){
  const p = PEOPLE[uid];
  if (!p) { PEOPLE[uid] = { name, handle, photo, loading: true }; getDoc(doc(fdb, "users", uid)).then(d => { if (d.exists()) { const x = d.data(); PEOPLE[uid] = { name: x.name || name, handle: x.handle || handle, photo: x.photoURL || photo }; rerenderSoft(); } }).catch(() => {}); }
  return PEOPLE[uid];
}

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
      <div style="display:flex;flex-direction:column;gap:6px"><button class="btn" data-copyhandle>Copy</button><button class="btn ghost" data-myprofile2>Profile</button></div></section>
    <section class="sect" style="margin-top:0"><h3>Add a friend</h3>
      <form class="addrow" id="addForm" autocomplete="off"><input class="search" id="addHandle" placeholder="@username" value="${esc(S.crewAdd||"")}" autocapitalize="none" spellcheck="false" aria-label="Friend's username"><button class="btn red" type="submit">Send</button></form></section>`;
  if (inc.length) html += `<section class="sect"><h3>Requests <span class="lbl">${inc.length}</span></h3><div class="plist">${inc.map(r => { const q = person(r.from, r.fromName, r.fromHandle, r.fromPhoto); return `
      <div class="prow">${avatar(q.photo, q.name)}<div class="pt"><div class="nm">${esc(q.name || q.handle)}</div><div class="hd">@${esc(q.handle)}</div></div>
      <button class="btn red" data-accept="${esc(r.id)}">Accept</button><button class="btn ghost" data-decline="${esc(r.id)}">Decline</button></div>`; }).join("")}</div></section>`;
  const famInc = fl.filter(f => f.famState === "pending" && f.famBy && f.famBy !== ME.uid);
  if (famInc.length) html += `<section class="sect"><h3>Family invites <span class="lbl">${famInc.length}</span></h3><div class="plist">${famInc.map(f => `
      <div class="prow">${avatar(f.photo, f.name)}<div class="pt"><div class="nm">${esc(f.name || f.handle)}</div><div class="hd">@${esc(f.handle)} wants to link logs</div>
      <div class="ro">Every show either of you adds lands in both logs.</div></div>
      <button class="btn red" data-famok="${esc(f.uid)}">Approve</button><button class="btn ghost" data-famno="${esc(f.uid)}">Not now</button></div>`).join("")}</div></section>`;
  html += tagInboxBlock() + pastTagSuggestBlock();
  html += `<section class="sect"><h3>The crew <span class="lbl">${fl.length}</span></h3>`;
  if (!fl.length) html += `<div class="empty"><h3>No crew yet</h3><div>Send a friend your username, or add theirs above. Once they accept, you can see each other's shows and the ones you hit together.</div></div>`;
  else html += `<div class="plist">${fl.map(f => { const tog = S.shows.filter(s => (f.shows||[]).some(o => sameShow(s,o))).length;
      return `<button class="prow tap" data-friend="${esc(f.uid)}">${avatar(f.photo, f.name)}<div class="pt"><div class="nm">${esc(f.name || f.handle)}</div><div class="hd">@${esc(f.handle)}${f.family ? ` <span class="chip fam">Family</span>` : f.famState === "pending" ? ` <span class="chip unsure">Family pending</span>` : ""}</div>
        <div class="ro">${f.err ? esc(f.err) : !f.loaded ? "Loading…" : f.family ? `${f.shows.filter(s=>!isUpcoming(s)).length} shows · logs linked` : `${f.shows.filter(s=>!isUpcoming(s)).length} shows · ${tog} together`}</div></div><span class="ct">${tog || ""}</span></button>`; }).join("")}</div>`;
  html += `</section>`;
  if (out.length) html += `<section class="sect"><h3>Sent</h3><div class="plist">${out.map(r => { const q = person(r.to, r.toName, r.toHandle, r.toPhoto); return `
      <div class="prow">${avatar(q.photo, q.name)}<div class="pt"><div class="nm">${esc(q.name || q.handle)}</div><div class="hd">@${esc(q.handle)} · waiting</div></div>
      <button class="btn ghost" data-decline="${esc(r.id)}">Cancel</button></div>`; }).join("")}</div></section>`;
  html += `<section class="sect explain"><h3>How the crew works</h3>
    <div class="ro"><b>Crew</b>: friends who can see each other's shows (read-only). Turn on <b>Crew</b> on Shows, Calendar or Stats to mix their shows into your view. It's off by default.</div>
    <div class="ro"><b>Tagging</b>: in a show's "Went with", tap a friend to tag them. They'll see it under "You were tagged" and can add just the show, or the show with your rating, notes, spend and photos. Names you logged before a friend joined can be linked to their account from their profile.</div>
    <div class="ro"><b>Crew Family</b>: links two logs. Any show either of you adds or edits (date, bands, venue) shows up in both. Ratings, notes, photos and spend stay your own. Both people have to approve, and either can turn it off. Invite someone from their profile.</div></section>`;
  $("#view").innerHTML = html + `</div>`;
}

function familyBlock(f){
  const h = esc(f.handle);
  if (f.family) return `<section class="famcard on"><div><div class="ft">Crew Family</div><div class="ro">Your logs are linked with @${h}. New shows and changes to date, bands or venue sync both ways.</div></div>
    <button class="btn warn" data-famleave="${esc(f.uid)}">${S.famConfirm ? "Tap again: unlink logs" : "Leave Crew Family"}</button></section>`;
  if (f.famState === "pending" && f.famBy === ME.uid) return `<section class="famcard"><div><div class="ft">Family invite sent</div><div class="ro">Waiting for @${h} to approve.</div></div><button class="btn ghost" data-famno="${esc(f.uid)}">Cancel invite</button></section>`;
  if (f.famState === "pending") return `<section class="famcard"><div><div class="ft">@${h} invited you to Crew Family</div><div class="ro">Approving links your logs: every show either of you adds lands in both. Your ratings, notes and photos stay yours.</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn red" data-famok="${esc(f.uid)}">Approve</button><button class="btn ghost" data-famno="${esc(f.uid)}">Not now</button></div></section>`;
  return `<section class="famcard"><div><div class="ft">Crew Family</div><div class="ro">Link logs with @${h} so shows either of you adds land in both. They'll need to approve.</div></div><button class="btn" data-famprop="${esc(f.uid)}">Invite to Crew Family</button></section>`;
}

/* ---------- Profiles ---------- */
// Top 5 bands (older profiles only have a single favBand) and a favorite venue.
const favList = x => (x ? (Array.isArray(x.favBands) && x.favBands.filter(Boolean).length ? x.favBands : x.favBand ? [x.favBand] : []) : []).filter(Boolean).slice(0, 5);
function profileTop(p, isMe, f){
  return `<div class="prof-top">${avatar(p.photo, p.name, "xl")}
    <div class="prof-id"><div class="pname">${esc(p.name || p.handle || "")}</div>
      <div class="hd">@${esc(p.handle || "")}${f && f.family ? ` <span class="chip fam">Crew Family</span>` : ""}</div>
      ${p.bio ? `<p class="pbio">${esc(p.bio)}</p>` : isMe ? `<p class="pbio ro">Add a short bio so your crew knows what you're about.</p>` : ""}
      ${(p.favBands || []).length ? `<div class="pfav"><span class="lbl">${p.favBands.length > 1 ? `Top ${p.favBands.length} bands` : "Favorite band"}</span><ol class="top5">${p.favBands.map((b, i) => `<li><span class="num">${i + 1}</span>${esc(b)}</li>`).join("")}</ol></div>` : ""}
      ${p.favVenue ? `<div class="pfav"><span class="lbl">Favorite venue</span> <b>${esc(p.favVenue)}</b></div>` : ""}
    </div></div>
    ${isMe ? `<div class="prof-act"><button class="btn red" data-editprofile>Edit profile</button><span class="ro">This is what your crew sees.</span></div>` : ""}`;
}
function showRow(s, ownerUid, label){
  if (!s) return "";
  const p = parse(s.date), lu = lineup(s), opener = ownerUid ? `data-fopen="${esc(ownerUid)}|${esc(s.id)}"` : `data-open="${esc(s.id)}"`;
  return `<button class="prow tap prow-show" ${opener}><span class="pdate"><b class="num">${p.d}</b>${MONTHS[(p.m||1)-1]} ${p.y}</span>
    <div class="pt"><div class="lbl">${esc(label)}</div><div class="nm" style="font-size:22px">${esc(lu[0] || "Show")}</div><div class="ro">${esc(s.venue || "Venue unknown")}</div></div></button>`;
}
function profileBlock(p, isMe, f, extra){
  const shows = p.shows || [], done = shows.filter(s => !isUpcoming(s)).sort((a,b) => (b.date||"").localeCompare(a.date||""));
  const bands = counts(done.flatMap(lineup)), venues = counts(done.map(s => s.venue || "")).filter(v => v.name);
  const yrs = done.map(s => parse(s.date).y).filter(Boolean);
  const rated = done.filter(s => Number(s.rating) > 0);
  const avg = rated.length ? (rated.reduce((a,s) => a + Number(s.rating), 0) / rated.length).toFixed(1) : "–";
  const next = shows.filter(isUpcoming).sort((a,b) => (a.date||"").localeCompare(b.date||""))[0];
  const best = rated.filter(s => Number(s.rating) >= 5)[0];
  const owner = isMe ? null : p.uid;
  const tile = (l, v) => `<div class="tile"><div class="lbl">${l}</div><div class="v num">${v}</div></div>`;
  if (f && f.statsHidden) return `<section class="prof">${profileTop(p, isMe, f)}</section><div class="ro">@${esc(p.handle || "")} keeps their stats private.</div>`;
  return `<section class="prof">${profileTop(p, isMe, f)}</section>
    <div class="tiles">
      ${tile("Shows", done.length)}${tile("Bands seen", bands.length)}${tile("Venues", venues.length)}
      ${isMe ? tile("Crew", friendList().length) + tile("Avg rating", avg) : tile("Together", extra.together) + tile("Shared bands", extra.shared)}
      ${tile("Since", yrs.length ? Math.min(...yrs) : "–")}
    </div>
    ${bands.filter(b => b.n > 1).length ? `<section class="sect" style="margin-top:0"><h3>Most seen</h3><div class="tagrow">${bands.filter(b => b.n > 1).slice(0, 8).map(b => `<span class="tagbtn" aria-pressed="true">${esc(b.name)} <span class="num" style="opacity:.75">×${b.n}</span></span>`).join("")}</div></section>` : ""}
    ${venues[0] ? `<div class="ro">Home venue: <b style="color:var(--bone)">${esc(venues[0].name)}</b> · ${venues[0].n} show${venues[0].n > 1 ? "s" : ""}</div>` : ""}
    <div class="plist">${showRow(next, owner, "Next show")}${showRow(done[0], owner, "Last show")}${best && best !== done[0] ? showRow(best, owner, "A 5-skull night") : ""}</div>`;
}

function renderMe(){
  if (!PROFILE) return;
  const openNow = [...document.querySelectorAll("[data-setgrp]")];
  if (openNow.length) S.setOpen = new Set(openNow.filter(d => d.open).map(d => d.dataset.setgrp));
  $("#view").innerHTML = `<div class="crew">${profileBlock({ uid: ME.uid, name: PROFILE.name, handle: PROFILE.handle, photo: PROFILE.photoURL, bio: PROFILE.bio, favBands: favList(PROFILE), favVenue: PROFILE.favVenue || "", shows: S.shows }, true, null, {})}${settingsBlock()}</div>`;
}
const selectRow = (key, label, help, opts, val) => `<label class="setrow"><span class="st"><b>${esc(label)}</b>${help ? `<span class="ro">${esc(help)}</span>` : ""}</span>
  <select data-setting="${key}" aria-label="${esc(label)}">${opts.map(([v, l]) => `<option value="${v}" ${val === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
function settingsBlock(){
  const set = MY(), open = S.setOpen || new Set();
  const grp = (id, title, body) => `<details class="setgrp" data-setgrp="${id}" ${open.has(id) ? "open" : ""}><summary><h3>${title}</h3></summary>${body}</details>`;
  return `<section class="sect settings"><h3 style="margin-bottom:6px">Settings</h3>
    ${grp("privacy", "Privacy", `<div class="ro" style="margin:4px 0 10px">Choose who sees each part of your log. Family only means people you've linked with Crew Family. Public covers your whole crew today, and anyone on Pit Log if public profiles are added later.</div>
      ${PRIVACY.map(([k, l, h]) => selectRow(k, l, h, LEVELS, set[k])).join("")}`)}
    ${grp("display", "Display", [
      selectRow("defaultView", "Shows opens to", "", [["list", "List"], ["cal", "Calendar"]], set.defaultView),
      selectRow("defaultSort", "Default sort", "", Object.entries(SORTS), set.defaultSort),
      selectRow("crewDefault", "Crew shows mixed in", "Starting state of the Crew toggle.", [["off", "Off"], ["on", "On"]], set.crewDefault),
      selectRow("weekStart", "Week starts on", "", [["sun", "Sunday"], ["mon", "Monday"]], set.weekStart),
      selectRow("currency", "Currency", "", [["$", "$ Dollar"], ["€", "€ Euro"], ["£", "£ Pound"]], set.currency),
      selectRow("distance", "Distance", "", [["mi", "Miles"], ["km", "Kilometers"]], set.distance)].join(""))}
    ${grp("data", "Your data", `<div class="ro" style="margin:4px 0 10px">Download a backup of every show you've logged. Import it from the account menu to restore it.</div>
      <button class="btn" data-backup>Download my data</button>`)}
  </section>`;
}
async function saveSetting(key, val){
  PROFILE.settings = { ...(PROFILE.settings || {}), [key]: val }; cacheProfile();
  if (key === "defaultView") { S.showView = val; try { localStorage.setItem("pitlog.showView", val); } catch (_) {} }
  if (key === "defaultSort") { S.sort = val; try { localStorage.setItem("pitlog.sort", val); } catch (_) {} }
  if (key === "crewDefault") { S.crewOn = val === "on"; try { localStorage.setItem("pitlog.crewOn", S.crewOn ? "1" : "0"); } catch (_) {} }
  try { await updateDoc(doc(fdb, "users", ME.uid), { ["settings." + key]: val }); toast("Saved"); schedulePublish(); }
  catch (e) { handleWriteErr(e); }
}
function downloadBackup(){
  const shows = S.shows.map(x => { const o = { ...x }; delete o._f; return o; });
  const blob = new Blob([JSON.stringify({ app: "pitlog", exportedAt: new Date().toISOString(), owner: PROFILE.handle, shows }, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = `pit-log-backup-${todayISO}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Backup ready · ${shows.length} shows`);
}

let PEDIT = null;
function editProfile(){
  PEDIT = { name: PROFILE.name || "", handle: PROFILE.handle || "", bio: PROFILE.bio || "", favBands: [...favList(PROFILE), "", "", "", "", ""].slice(0, 5), favVenue: PROFILE.favVenue || "", photoURL: PROFILE.photoURL || "", photoPath: PROFILE.photoPath || "", busy: false };
  drawEdit();
}
function drawEdit(){
  const root = $("#modalRoot"), e = PEDIT, g = ME.photoURL || "";
  root.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Edit profile"><div class="mbox">
    <h3>Edit profile</h3>
    <div class="avedit">${avatar(e.photoURL, e.name, "xl")}
      <div class="avbtns">
        <label class="btn">${e.busy ? "Uploading…" : "Change photo"}<input class="vh" type="file" id="avatarFile" accept="image/*,.heic,.heif" ${e.busy ? "disabled" : ""}></label>
        ${g && e.photoURL !== g ? `<button class="btn ghost" data-avgoogle>Use Google photo</button>` : ""}
        ${e.photoURL ? `<button class="btn ghost" data-avnone>Use my initial</button>` : ""}
      </div></div>
    <label class="field"><span class="lbl">Name</span><input id="pf-name" maxlength="40" value="${esc(e.name)}"></label>
    <label class="field"><span class="lbl">Bio <span id="pf-count">${(e.bio||"").length}/140</span></span><textarea id="pf-bio" maxlength="140" placeholder="Doom, deathcore and barricade spots.">${esc(e.bio)}</textarea></label>
    <div class="field"><span class="lbl">Top 5 bands</span><div class="top5edit">${e.favBands.map((b, i) => `<label><span class="num">${i + 1}</span><input id="pf-fav${i}" maxlength="40" list="dl-bands" value="${esc(b)}" placeholder="${i ? "" : "Katatonia"}" aria-label="Favorite band ${i + 1}"></label>`).join("")}</div></div>
    <label class="field"><span class="lbl">Favorite venue</span><input id="pf-venue" maxlength="60" list="dl-venues" value="${esc(e.favVenue)}" placeholder="Union Transfer"></label>
    <datalist id="dl-bands">${counts(S.shows.flatMap(lineup)).slice(0, 200).map(b => `<option value="${esc(b.name)}">`).join("")}</datalist>
    <datalist id="dl-venues">${counts(S.shows.map(x => x.venue || "")).filter(v => v.name).map(v => `<option value="${esc(v.name)}">`).join("")}</datalist>
    <label class="field"><span class="lbl">Username</span><div class="hrow"><span>@</span><input id="pf-handle" maxlength="20" value="${esc(e.handle)}" autocapitalize="none" spellcheck="false" ${handleLock() ? "disabled" : ""}></div></label>
    <div class="ro">${handleLock() ? `You changed your username recently. You can change it again on ${handleLock()}.` : `Changing it keeps your shows, crew and tags. Your old username keeps pointing to you, so friends who type it still find you. You can change it once every ${HANDLE_COOLDOWN_DAYS} days.`}</div>
    <div class="ro" style="opacity:.6">Account ID: <span class="num">${esc(ME.uid)}</span> (never changes)</div>
    <div class="mbtns"><button class="btn ghost" data-pcancel>Cancel</button><button class="btn red" data-psave ${e.busy ? "disabled" : ""}>Save</button></div>
  </div></div>`;
  const keep = () => { PEDIT.handle = $("#pf-handle").value; PEDIT.name = $("#pf-name").value; PEDIT.bio = $("#pf-bio").value; PEDIT.favBands = [0,1,2,3,4].map(i => $("#pf-fav" + i).value); PEDIT.favVenue = $("#pf-venue").value; };
  root.querySelector("[data-pcancel]").onclick = () => { if (PEDIT.photoPath && PEDIT.photoPath !== PROFILE.photoPath) removeFile(PEDIT.photoPath); PEDIT = null; root.innerHTML = ""; };
  root.querySelector("[data-psave]").onclick = () => { keep(); saveProfileEdit(); };
  const gb = root.querySelector("[data-avgoogle]"); if (gb) gb.onclick = () => { keep(); dropPendingAvatar(); PEDIT.photoURL = g; PEDIT.photoPath = ""; drawEdit(); };
  const nb = root.querySelector("[data-avnone]"); if (nb) nb.onclick = () => { keep(); dropPendingAvatar(); PEDIT.photoURL = ""; PEDIT.photoPath = ""; drawEdit(); };
  $("#pf-bio").oninput = ev => { $("#pf-count").textContent = ev.target.value.length + "/140"; };
}
function dropPendingAvatar(){ if (PEDIT.photoPath && PEDIT.photoPath !== PROFILE.photoPath) removeFile(PEDIT.photoPath); }
async function squareAvatar(file){
  let img;
  try { img = await decodeImage(file); } catch (e) { if (!isHeic(file)) throw e; img = await decodeImage(await heicToJpeg(file)); }
  const W = img.width || img.naturalWidth, H = img.height || img.naturalHeight;
  const side = Math.min(W, H), out = Math.min(400, side);
  const c = document.createElement("canvas"); c.width = c.height = out;
  const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (W - side) / 2, (H - side) / 2, side, side, 0, 0, out, out);
  return await new Promise(r => c.toBlob(r, "image/jpeg", 0.86));
}
async function uploadAvatar(file){
  if (!PEDIT) return;
  PEDIT.name = $("#pf-name").value; PEDIT.bio = $("#pf-bio").value; PEDIT.favBands = [0,1,2,3,4].map(i => $("#pf-fav" + i).value); PEDIT.favVenue = $("#pf-venue").value;
  PEDIT.busy = true; drawEdit();
  try {
    const blob = await squareAvatar(file);
    const path = `users/${ME.uid}/avatar-${rid()}.jpg`, r = sref(storage, path);
    await uploadBytes(r, blob, { contentType: "image/jpeg", cacheControl: "public,max-age=31536000" });
    dropPendingAvatar();
    PEDIT.photoURL = await getDownloadURL(r); PEDIT.photoPath = path;
  } catch (e) { console.error(e); toast(e && e.code === "storage/unauthorized" ? "Upload blocked: check the Storage rules" : "Couldn't use that image. Try a JPG or PNG.", 4000); }
  if (PEDIT) { PEDIT.busy = false; drawEdit(); }
}
const HANDLE_COOLDOWN_DAYS = 30;
// Date the next username change is allowed, or "" if it's allowed now.
function handleLock(){
  const t = PROFILE && PROFILE.handleChangedAt; if (!t) return "";
  const ms = typeof t.toMillis === "function" ? t.toMillis() : Number(t) || Date.parse(t) || 0; if (!ms) return "";
  const next = ms + HANDLE_COOLDOWN_DAYS * 864e5;
  return Date.now() < next ? new Date(next).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
}
async function saveProfileEdit(){
  const e = PEDIT, name = (e.name || "").trim();
  if (!name) { toast("Add your name"); return; }
  const patch = { name, bio: (e.bio || "").trim().slice(0, 140), favBands: ((seen) => e.favBands.map(b => String(b || "").trim().slice(0, 40)).filter(b => b && !seen.has(b.toLowerCase()) && seen.add(b.toLowerCase())))(new Set()).slice(0, 5), favVenue: (e.favVenue || "").trim().slice(0, 60), photoURL: e.photoURL || "", photoPath: e.photoPath || "" };
  const h = String(e.handle || "").trim().replace(/^@/, "").toLowerCase(), oldH = PROFILE.handle;
  const changing = h && h !== oldH;
  if (changing && handleLock()) { toast(`You can change your username again on ${handleLock()}`, 4000); return; }
  if (changing && !HANDLE_RE.test(h)) { toast("Usernames are 3–20 lowercase letters, numbers or _", 4000); return; }
  patch.favBand = patch.favBands[0] || ""; // older app versions read this one
  try {
    if (changing) {
      // The account is keyed by uid everywhere (friends, tags, family), so only the lookup changes.
      // The old handle doc is kept so it still resolves to this account and nobody else can grab it.
      const taken = await getDoc(doc(fdb, "handles", h));
      if (taken.exists() && taken.data().uid !== ME.uid) { toast(`@${h} is taken. Try another.`, 4000); return; }
      const ts = Date.now();
      const b = writeBatch(fdb);
      if (!taken.exists()) b.set(doc(fdb, "handles", h), { uid: ME.uid });
      b.update(doc(fdb, "users", ME.uid), { ...patch, handle: h, handleChangedAt: ts, prevHandles: arrayUnion(oldH) });
      await b.commit();
      Object.assign(patch, { handle: h, handleChangedAt: ts, prevHandles: [...new Set([...(PROFILE.prevHandles || []), oldH])] });
    } else await updateDoc(doc(fdb, "users", ME.uid), patch);
    const old = PROFILE.photoPath; Object.assign(PROFILE, patch);
    if (old && old !== patch.photoPath) removeFile(old);
    PEDIT = null; $("#modalRoot").innerHTML = "";
    $("#acct").innerHTML = avatar(PROFILE.photoURL, PROFILE.name);
    toast(changing ? `You're now @${patch.handle}` : "Profile saved"); renderTab(); syncSearchFields(); schedulePublish(true); cacheProfile();
  } catch (err) { handleWriteErr(err); }
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
    ${f.err ? `<section class="prof">${profileTop({ name: f.name, handle: f.handle, photo: f.photo, bio: f.bio, favBands: favList(f), favVenue: f.favVenue || "" }, false, f)}</section>`
      : profileBlock({ uid: f.uid, name: f.name, handle: f.handle, photo: f.photo, bio: f.bio, favBands: favList(f), favVenue: f.favVenue || "", shows: f.shows || [] }, false, f, { together: together.length, shared: shared.length })}
    <div class="seg big" role="group" aria-label="View">
      <button data-crewview="shows" aria-pressed="${v==="shows"}">Their shows</button>
      <button data-crewview="together" aria-pressed="${v==="together"}">Together</button>
      <button data-crewview="bands" aria-pressed="${v==="bands"}">Shared bands</button></div>
    ${body}
    ${f.err ? "" : pastTagsBlock(f)}
    ${familyBlock(f)}
    <div style="margin-top:18px"><button class="btn warn" data-unfriend="${esc(f.uid)}">${S.unfriendConfirm ? "Tap again to remove from crew" : "Remove from crew"}</button></div>
  </div>`;
}

function crewClick(t){
  if (t.hasAttribute("data-copyhandle")) { const h = "@" + PROFILE.handle; (navigator.clipboard ? navigator.clipboard.writeText(h) : Promise.reject()).then(() => toast("Copied " + h), () => toast("Your username is " + h, 4000)); return true; }
  if (t.dataset.accept) { const r = REQ.in.find(x => x.id === t.dataset.accept); if (r) acceptRequest(r); return true; }
  if (t.dataset.decline) { removeRequest(t.dataset.decline); return true; }
  if (t.dataset.friend) { S.crewSel = t.dataset.friend; S.crewView = "shows"; S.unfriendConfirm = false; S.famConfirm = false; renderCrew(); window.scrollTo(0, 0); return true; }
  if (t.hasAttribute("data-crewback")) { S.crewSel = null; renderCrew(); return true; }
  if (t.dataset.crewview) { S.crewView = t.dataset.crewview; renderCrew(); return true; }
  if (t.dataset.taglink) { const [uid, name] = splitKey(t.dataset.taglink); linkName(name, uid); return true; }
  if (t.dataset.tagunlink) { const [uid, name] = splitKey(t.dataset.tagunlink); unlinkName(name, uid); return true; }
  if (t.dataset.tagadd) { const [uid, id] = splitKey(t.dataset.tagadd); addTaggedShow(uid, id, false); return true; }
  if (t.dataset.tagfull) { const [uid, id] = splitKey(t.dataset.tagfull); addTaggedShow(uid, id, true); return true; }
  if (t.dataset.tagdis) { dismissTag(t.dataset.tagdis); return true; }
  if (t.dataset.famprop) { setFamily(t.dataset.famprop, "pending"); return true; }
  if (t.dataset.famok) { setFamily(t.dataset.famok, "active"); return true; }
  if (t.dataset.famno) { setFamily(t.dataset.famno, "off"); return true; }
  if (t.dataset.famleave) { if (!S.famConfirm) { S.famConfirm = true; renderCrew(); return true; } S.famConfirm = false; setFamily(t.dataset.famleave, "off"); return true; }
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
    <button class="btn red" data-myprofile style="text-align:center">View my profile</button>
    <div class="ro">Import a Pit Log export file, or a ticket-cost file. A cost file only fills in ticket totals on shows you've already logged.</div>
    <label class="btn" style="text-align:center">Import Pit Log file<input class="vh" type="file" id="importFile" accept=".json,application/json"></label>
    <div class="mbtns"><button class="btn warn" data-signout>Sign out</button><button class="btn ghost" data-mclose>Close</button></div>
  </div></div>`;
  root.querySelector("[data-mclose]").onclick = () => root.innerHTML = "";
  root.querySelector("[data-signout]").onclick = () => { root.innerHTML = ""; try { localStorage.removeItem(profKey(ME.uid)); } catch (_) {} signOut(auth); };
  root.querySelector("[data-myprofile]").onclick = () => { root.innerHTML = ""; S.tab = "me"; renderTab(); window.scrollTo(0, 0); };
}

async function importFile(file){
  $("#modalRoot").innerHTML = "";
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { toast("That file isn't a Pit Log export", 4000); return; }
  if (data && data.kind === "pitlog-costs" && Array.isArray(data.costs)) return importCosts(data.costs);
  const list = Array.isArray(data && data.shows) ? data.shows : null;
  if (!list) { toast("That file isn't a Pit Log export", 4000); return; }
  const fromData = async (m, showId, kind) => { if (m && !m.data && m.url) return { url: m.url, path: m.path || "", type: m.type || "image", bands: m.bands || [] }; if (!m || !m.data) return null; const raw = await (await fetch(m.data)).blob(); const b = await compress(raw, kind); const r = await putImage(b, showId, kind); return { url: r.url, path: r.path, type: "image", bands: m.bands || [] }; };
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

// Cost-only import: fills ticket fields on shows already in the log. Never touches photos, notes or
// anything else, and skips a show that already has an order total so manual entries win.
async function importCosts(costs){
  const low = x => String(x || "").trim().toLowerCase();
  let added = 0, kept = 0; const missed = [];
  for (const c of costs) {
    const same = S.shows.filter(s => s.date === c.date);
    const hit = same.find(s => lineup(s).some(b => low(b) === low(c.headliner))) || same.find(s => low(s.venue) === low(c.venue)) || (same.length === 1 ? same[0] : null);
    if (!hit) { missed.push(c.date + " " + c.headliner); continue; }
    if (hit.ticketTotal != null && hit.ticketTotal !== "") { kept++; continue; }
    const qty = hit.ticketQty != null ? Number(hit.ticketQty) : (c.qty ?? null);
    const upd = { ticketTotal: Number(c.total), ticketQty: qty, ticket: perTicket({ ticketQty: qty, ticketTotal: Number(c.total) }) };
    try { await updateDoc(myShow(hit.id), upd); added++; }
    catch (e) { console.error(e); toast("Cost import stopped: " + (e.code || "error"), 6000); return; }
  }
  if (missed.length) console.warn("Pit Log cost import, no match:", missed);
  toast(`Added costs to ${added} show${added===1?"":"s"}` + (kept ? `, kept ${kept} you'd already filled in` : "") + (missed.length ? `, ${missed.length} not matched` : ""), 6000);
}

/* ---------- Auth + profile ---------- */
function showOnly(id){ for (const x of ["boot", "gate", "setup", "appRoot"]) $("#"+x).hidden = x !== id; }
// The last profile seen on this device, so a refresh can open the app right away
// instead of waiting on the network (it's refreshed from the server straight after).
const profKey = uid => "pitlog.profile." + uid;
function cacheProfile(){ try { if (ME && PROFILE) localStorage.setItem(profKey(ME.uid), JSON.stringify(PROFILE)); } catch (_) {} }
function cachedProfile(uid){ try { const p = JSON.parse(localStorage.getItem(profKey(uid)) || "null"); return p && p.handle ? p : null; } catch (_) { return null; } }

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
  $("#setupName").value = (PENDING && PENDING.name) || ME.displayName || "";
  $("#setupHandle").value = (PENDING && PENDING.handle) || (base.length >= 3 ? base : "");
  if (PENDING) { PENDING = null; saveProfile(); }
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
    PROFILE = prof; cacheProfile(); startApp();
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
  // Account-level defaults from Settings (only the ones the person has actually set)
  const ps = (PROFILE && PROFILE.settings) || {};
  if (ps.defaultView) S.showView = ps.defaultView;
  if (ps.defaultSort && SORTS[ps.defaultSort]) S.sort = ps.defaultSort;
  if (ps.crewDefault) S.crewOn = ps.crewDefault === "on";
  showOnly("appRoot");
  const a = $("#acct"); a.hidden = false; a.innerHTML = avatar(PROFILE.photoURL, PROFILE.name);
  $("#searchBtn").hidden = false;
  $("#addBtn").hidden = false;
  syncSearchFields();
  render();
  const timer = setTimeout(() => { if (!S.loaded) { S.slow = true; render(); } }, 10000);
  UNSUBS.push(onSnapshot(myShows(), { includeMetadataChanges: false }, snap => {
    S.shows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!snap.metadata.fromCache || S.shows.length) { S.loaded = true; S.slow = false; clearTimeout(timer); }
    if (friendList().some(f => f.family)) scheduleFamilySync();
    if (S.open && !S.openFriend && S.open !== "__new" && draft && !busy) {
      const fresh = S.shows.find(x => x.id === S.open);
      if (fresh) { readForm(); for (const k of ["poster","photos","merch"]) draft[k] = fresh[k]; }
    }
    renderNext();
    schedulePublish();
    if (!S.open) renderTab(); else renderSheet();
  }, err => { clearTimeout(timer); S.loaded = true; S.error = err.code === "permission-denied" ? "Your log is blocked — the Firestore rules aren't published yet." : "The log couldn't load. Reload to try again."; render(); }));
  const reqs = (field, key) => onSnapshot(query(collection(fdb, "friendRequests"), where(field, "==", ME.uid)), snap => {
    REQ[key] = snap.docs.map(d => ({ id: d.id, ...d.data() })); syncFriends(); updateCrewBadge();
  }, err => console.error("requests", err));
  UNSUBS.push(reqs("to", "in"), reqs("from", "out"));
}
function updateCrewBadge(){ const n = REQ.in.filter(r => r.status === "pending").length + (ME && S.loaded ? tagInbox().length : 0)
  + (ME ? friendList().filter(f => f.famState === "pending" && f.famBy && f.famBy !== ME.uid).length : 0); $("#tab-crew").innerHTML = "Crew" + (n ? ` <span class="badge-n">${n}</span>` : ""); $("#tab-crew").setAttribute("aria-selected", S.tab === "crew"); }

$("#signinBtn").addEventListener("click", doSignIn);

/* ---------- Email + password ---------- */
let AUTHMODE = "in", PENDING = null;
function setAuthMode(m){
  AUTHMODE = m;
  document.querySelectorAll("[data-authmode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.authmode === m));
  document.querySelectorAll("#emailForm .up-only").forEach(el => el.hidden = m !== "up");
  $("#emailGo").textContent = m === "up" ? "Create account" : "Sign in";
  $("#forgotBtn").hidden = m === "up";
  $("#auPass").autocomplete = m === "up" ? "new-password" : "current-password";
  $("#signinMsg").textContent = "";
}
document.querySelectorAll("[data-authmode]").forEach(b => b.addEventListener("click", () => setAuthMode(b.dataset.authmode)));
const AUTH_MSG = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/missing-password": "Enter your password.",
  "auth/weak-password": "Use at least 6 characters for your password.",
  "auth/email-already-in-use": "There's already an account with that email. Sign in instead, or use the Google button if you signed up with Google.",
  "auth/invalid-credential": "Email or password is wrong. If you signed up with Google, use the Google button.",
  "auth/wrong-password": "Email or password is wrong.",
  "auth/user-not-found": "No account with that email yet. Tap Create account.",
  "auth/too-many-requests": "Too many tries. Wait a minute, or reset your password.",
  "auth/operation-not-allowed": "Email sign-in isn't switched on yet (Firebase → Authentication → Sign-in method → Email/Password).",
  "auth/network-request-failed": "No connection. Check your signal and try again."
};
const authErr = e => AUTH_MSG[e && e.code] || ("Sign-in failed: " + ((e && (e.code || e.message)) || "unknown error"));
$("#emailForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const msg = $("#signinMsg"), btn = $("#emailGo");
  const email = $("#auEmail").value.trim(), pass = $("#auPass").value;
  msg.textContent = "";
  if (!email || !pass) { msg.textContent = "Enter your email and password."; return; }
  if (AUTHMODE === "up") {
    const name = $("#auName").value.trim(), h = $("#auHandle").value.trim().replace(/^@/, "").toLowerCase();
    if (!name) { msg.textContent = "Add your name."; return; }
    if (!HANDLE_RE.test(h)) { msg.textContent = "Usernames are 3–20 lowercase letters, numbers or _."; return; }
    if (pass.length < 6) { msg.textContent = "Use at least 6 characters for your password."; return; }
    if (pass !== $("#auPass2").value) { msg.textContent = "Passwords don't match."; return; }
    btn.disabled = true; PENDING = { name, handle: h };
    try { const cred = await createUserWithEmailAndPassword(auth, email, pass); try { await updateProfile(cred.user, { displayName: name }); } catch (_) {} }
    catch (e) { PENDING = null; msg.textContent = authErr(e); }
    btn.disabled = false;
  } else {
    btn.disabled = true;
    try { await signInWithEmailAndPassword(auth, email, pass); }
    catch (e) { msg.textContent = authErr(e); }
    btn.disabled = false;
  }
});
$("#forgotBtn").addEventListener("click", async () => {
  const email = $("#auEmail").value.trim(), msg = $("#signinMsg");
  if (!email) { msg.textContent = "Type your email above, then tap Forgot password again."; return; }
  try { await sendPasswordResetEmail(auth, email); msg.textContent = "If that email has an account, a reset link is on its way. Check spam too."; }
  catch (e) { msg.textContent = authErr(e); }
});
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
  const cached = !wasRedirect && cachedProfile(user.uid);
  if (cached) {
    // Open straight away from the saved profile, then quietly swap in the server copy.
    PROFILE = cached; startApp();
    getDoc(doc(fdb, "users", user.uid)).then(p => { if (p.exists() && p.data().handle && ME && ME.uid === user.uid) { PROFILE = { ...p.data() }; cacheProfile(); const a = $("#acct"); if (a) a.innerHTML = avatar(PROFILE.photoURL, PROFILE.name); } }).catch(() => {});
    return;
  }
  if ($("#boot").hidden) showOnly("gate");
  try {
    const p = await Promise.race([
      getDoc(doc(fdb, "users", user.uid)),
      new Promise((_, rej) => setTimeout(() => rej({ code: "timeout" }), 12000))
    ]);
    if (p.exists() && p.data().handle) { PROFILE = p.data(); cacheProfile(); startApp(); }
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

