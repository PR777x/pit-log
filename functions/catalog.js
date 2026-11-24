// Show catalog: newly announced concerts pulled once a day from the Ticketmaster Discovery API.
// Each show becomes catalog/{id} (readable by signed-in users, written only here), so the app can
// offer "already announced" shows when adding one, list them in band search, and flag new
// announcements for bands people have seen.
const crypto = require("crypto");

const STATES = ["PA", "NJ", "DE", "NY"];       // always fetched; more are added for where people say they live
const MAX_STATES = 16;                          // keeps the daily run well under Ticketmaster's 5,000 calls/day
// Bordering states (lower 48 + DC), used to cover a travel radius that crosses a state line.
const NEIGHBORS = { AL:"FL GA MS TN", AZ:"CA CO NM NV UT", AR:"LA MO MS OK TN TX", CA:"AZ NV OR", CO:"AZ KS NE NM OK UT WY", CT:"MA NY RI", DE:"MD NJ PA", DC:"MD VA",
  FL:"AL GA", GA:"AL FL NC SC TN", ID:"MT NV OR UT WA WY", IL:"IA IN KY MO WI", IN:"IL KY MI OH", IA:"IL MN MO NE SD WI", KS:"CO MO NE OK", KY:"IL IN MO OH TN VA WV",
  LA:"AR MS TX", ME:"NH", MD:"DE PA VA WV DC", MA:"CT NH NY RI VT", MI:"IN OH WI", MN:"IA ND SD WI", MS:"AL AR LA TN", MO:"AR IA IL KS KY NE OK TN", MT:"ID ND SD WY",
  NE:"CO IA KS MO SD WY", NV:"AZ CA ID OR UT", NH:"MA ME VT", NJ:"DE NY PA", NM:"AZ CO OK TX UT", NY:"CT MA NJ PA VT", NC:"GA SC TN VA", ND:"MN MT SD", OH:"IN KY MI PA WV",
  OK:"AR CO KS MO NM TX", OR:"CA ID NV WA", PA:"DE MD NJ NY OH WV", RI:"CT MA", SC:"GA NC", SD:"IA MN MT ND NE WY", TN:"AL AR GA KY MO MS NC VA", TX:"AR LA NM OK",
  UT:"AZ CO ID NM NV WY", VT:"MA NH NY", VA:"KY MD NC TN WV DC", WA:"ID OR", WV:"KY MD OH PA VA", WI:"IA IL MI MN", WY:"CO ID MT NE SD UT" };
const near = (st, miles) => [st, ...(Number(miles) >= 40 && NEIGHBORS[st] ? NEIGHBORS[st].split(" ") : [])];
// Which states to fetch: the base region, then each person's home state (and its neighbors when their
// radius reaches past the line), most-requested first, capped.
function statesFor(homes){
  const score = new Map();
  for (const h of homes || []) { const st = String(h && h.state || "").toUpperCase(); if (!NEIGHBORS[st]) continue;
    near(st, h.radius).forEach((x, i) => score.set(x, (score.get(x) || 0) + (i ? 1 : 3))); }
  const extra = [...score.entries()].filter(([x]) => !STATES.includes(x)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([x]) => x);
  return [...STATES, ...extra].slice(0, MAX_STATES);
}
const GENRES = "Metal,Rock,Alternative,Punk";   // Ticketmaster classification names
const MONTHS_AHEAD = 15;
const KEEP_PAST_DAYS = 400;                      // keep past shows ~a year so people can log them after the fact
const RECENT_DAYS = 14;                          // window for "just announced"
const API = "https://app.ticketmaster.com/discovery/v2/events.json";

const normBand = b => String(b || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
const STOPW = new Set(["the", "and", "tour", "world", "north", "american", "america", "with", "special", "guests", "2023", "2024", "2025", "2026", "2027", "2028"]);
const tourWords = t => [...new Set(String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOPW.has(w)))].slice(0, 10);
const JUNK = /\b(parking|vip|upgrade|package|packages|shuttle|tailgate|meet\s*&?\s*greet|lounge access|fast lane|early entry|soundcheck|locker|hotel|bus|camping|premium|suite)\b/i;
const sha = s => crypto.createHash("sha1").update(s).digest("hex");

// Turn one Ticketmaster event into a catalog show, or null if it isn't a real concert listing.
function fromTM(ev){
  if (!ev || !ev.dates || !ev.dates.start || !ev.dates.start.localDate) return null;
  const name = String(ev.name || "").trim();
  if (!name || JUNK.test(name)) return null;
  const status = (ev.dates.status && ev.dates.status.code) || "onsale";
  const emb = ev._embedded || {}, v = (emb.venues || [])[0] || {};
  let lineup = (emb.attractions || []).map(a => String(a.name || "").trim()).filter(Boolean);
  lineup = lineup.filter((b, i) => lineup.findIndex(x => normBand(x) === normBand(b)) === i);
  if (!lineup.length) lineup = [name.split(/\s+(?:w\/|with|featuring|feat\.|:|-|–)\s+/i)[0].trim()];
  if (lineup.some(b => JUNK.test(b))) return null;
  const venue = String(v.name || "").trim(), city = [v.city && v.city.name, v.state && v.state.stateCode].filter(Boolean).join(", ");
  // The event name is the tour when it says "tour" (e.g. "Gojira & Mastodon: Mega Monsters Tour").
  const m = name.match(/[:\-–]\s*(.*\btour\b.*)$/i) || (/\btour\b/i.test(name) ? [null, name] : null);
  const tour = m ? m[1].trim() : "";
  const co = lineup.length > 1 && new RegExp("^\\s*" + lineup[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(&|and|\\+|x)\\s*" + lineup[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(name);
  const key = `${ev.dates.start.localDate}|${normBand(venue)}|${normBand(lineup[0])}`;
  return {
    id: sha(key).slice(0, 20), key,
    date: ev.dates.start.localDate, time: ev.dates.start.localTime ? ev.dates.start.localTime.slice(0, 5) : "",
    lineup: lineup.slice(0, 8), coHead: co, title: name, tour, venue, city,
    url: ev.url || "", status, tmId: ev.id || "",
    lat: (v.location && Math.round(Number(v.location.latitude) * 1000) / 1000) || null, lng: (v.location && Math.round(Number(v.location.longitude) * 1000) / 1000) || null,
    onsale: (ev.sales && ev.sales.public && ev.sales.public.startDateTime) || "",
    genre: (ev.classifications && ev.classifications[0] && ev.classifications[0].genre && ev.classifications[0].genre.name) || "",
    bandKeys: [...new Set(lineup.map(normBand).filter(Boolean))], tourWords: tourWords(tour || name),
    source: "ticketmaster",
  };
}
// Stable fingerprint of the parts people see, so unchanged shows aren't rewritten every day.
const fingerprint = s => sha(JSON.stringify([s.date, s.time, s.lineup, s.coHead, s.title, s.tour, s.venue, s.city, s.url, s.status, s.onsale])).slice(0, 10);

// When several listings collapse to one show (presale + general, etc.) keep the fullest one.
function mergeShows(list){
  const out = new Map();
  for (const s of list) {
    const cur = out.get(s.id);
    if (!cur || s.lineup.length > cur.lineup.length || (!cur.tour && s.tour) || (cur.status !== "onsale" && s.status === "onsale")) out.set(s.id, s);
  }
  return [...out.values()];
}

// Month-by-month windows keep each query under Ticketmaster's 1,000-result paging limit.
function windows(todayISO, months){
  const out = []; const [y, m] = todayISO.split("-").map(Number);
  for (let i = 0; i < months; i++) {
    const a = new Date(Date.UTC(y, m - 1 + i, 1)), b = new Date(Date.UTC(y, m + i, 1));
    out.push([i === 0 ? `${todayISO}T00:00:00Z` : a.toISOString().replace(".000", ""), b.toISOString().replace(".000", "")]);
  }
  return out;
}

async function fetchAll({ apiKey, today, states = STATES, fetchImpl = fetch, pause = ms => new Promise(r => setTimeout(r, ms)), log = () => {} }){
  const found = []; let calls = 0;
  for (const st of states) for (const [from, to] of windows(today, MONTHS_AHEAD)) {
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ apikey: apiKey, countryCode: "US", stateCode: st, classificationName: GENRES, segmentName: "Music",
        startDateTime: from, endDateTime: to, size: "200", page: String(page), sort: "date,asc", includeTBA: "no", includeTBD: "no" });
      let res, body;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetchImpl(`${API}?${q}`); calls++;
        if (res.status === 429) { await pause(1500 * (attempt + 1)); continue; }
        break;
      }
      if (!res.ok) { log(`ticketmaster ${st} ${from.slice(0, 7)} page ${page}: HTTP ${res.status}`); if (res.status === 401) throw new Error("Ticketmaster rejected the API key (401)"); break; }
      body = await res.json();
      for (const ev of (body._embedded && body._embedded.events) || []) { const s = fromTM(ev); if (s) found.push(s); }
      await pause(260); // stay under 5 requests/second
      const pg = body.page || {};
      if (!pg.totalPages || page + 1 >= pg.totalPages || (page + 1) * 200 >= 1000) break;
    }
  }
  return { shows: mergeShows(found), calls };
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const compact = s => ({ i: s.id, d: s.date, l: s.lineup, c: s.coHead ? 1 : 0, v: s.venue, y: s.city, t: s.tour, u: s.url, f: s.firstSeen });

// Pure planning step: given today's listings and what's stored, decide what to write and delete.
function plan({ shows, index, recent, today }){
  const writes = [], seenNow = new Set(), nextIndex = {};
  // The very first run loads everything already on sale; none of that is "just announced".
  const backfill = !Object.keys(index).length;
  for (const s of shows) {
    seenNow.add(s.id);
    const fp = fingerprint(s), old = index[s.id];
    const firstSeen = old ? old.f : backfill ? "" : today;
    nextIndex[s.id] = { h: fp, f: firstSeen, d: s.date };
    if (!old || old.h !== fp) writes.push({ ...s, firstSeen, isNew: !old && !backfill, isAdd: !old });
  }
  const deletes = [];
  for (const [id, old] of Object.entries(index)) {
    if (seenNow.has(id)) continue;
    // Shows that dropped off Ticketmaster: keep past ones for a year (people log after the fact),
    // drop future ones that vanished (cancelled or moved), and prune very old ones.
    if (old.d < today && daysBetween(old.d, today) <= KEEP_PAST_DAYS) nextIndex[id] = old;
    else deletes.push(id);
  }
  const fresh = new Map((recent || []).filter(r => r.f && daysBetween(r.f, today) < RECENT_DAYS && !deletes.includes(r.i)).map(r => [r.i, r]));
  for (const w of writes) if (w.isNew || fresh.has(w.id)) fresh.set(w.id, compact(w));
  const nextRecent = [...fresh.values()].filter(r => r.d >= today).sort((a, b) => b.f.localeCompare(a.f) || a.d.localeCompare(b.d)).slice(0, 2500);
  return { writes, deletes, nextIndex, nextRecent, added: writes.filter(w => w.isAdd).length, announced: writes.filter(w => w.isNew).length, backfill };
}

// Upcoming shows split into one small document per month, for the app's Discover page
// (a few reads per visit instead of one per show).
const stateOf = city => (String(city || "").match(/, ([A-Z]{2})$/) || [])[1] || "";
function monthShards(shows, nextIndex, today, { only } = {}){
  const by = {};
  for (const s of shows) {
    if (s.date < today || s.status === "cancelled") continue;
    if (only && !only.includes(stateOf(s.city))) continue;
    const m = s.date.slice(0, 7), ix = nextIndex[s.id] || {};
    const row = { i: s.id, d: s.date, h: s.time || "", l: s.lineup, c: s.coHead ? 1 : 0, v: s.venue, y: s.city, t: s.tour, u: s.url, g: s.genre || "", s: s.status === "onsale" ? "" : s.status, f: ix.f || "", o: s.onsale || "" };
    if (s.lat && s.lng) { row.a = s.lat; row.n = s.lng; }
    (by[m] = by[m] || []).push(row);
  }
  for (const m of Object.keys(by)) by[m].sort((a, b) => a.d.localeCompare(b.d) || a.h.localeCompare(b.h) || a.v.localeCompare(b.v));
  return by;
}
// The same shows split by month AND state ("2026-12_PA"), so the app loads only the states it needs.
function stateShards(shows, nextIndex, today){
  const all = monthShards(shows, nextIndex, today), out = {};
  for (const [m, rows] of Object.entries(all)) for (const r of rows) { const k = `${m}_${stateOf(r.y) || "XX"}`; (out[k] = out[k] || []).push(r); }
  return out;
}

module.exports = { stateShards, statesFor, NEIGHBORS, near, stateOf, MAX_STATES, monthShards, fromTM, fingerprint, mergeShows, windows, fetchAll, plan, normBand, tourWords, STATES, GENRES, RECENT_DAYS };
