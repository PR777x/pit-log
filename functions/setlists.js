// setlist.fm: look up a show's real setlist, and import someone's "attended" list.
// Needs a free API key (setlist.fm -> API) saved as the SETLISTFM_API_KEY secret.
const API = "https://api.setlist.fm/rest/1.0";
async function get(key, path, fetchImpl = fetch){
  const r = await fetchImpl(API + path, { headers: { "x-api-key": key, Accept: "application/json", "Accept-Language": "en" } });
  if (r.status === 404) return null;
  if (!r.ok) { const e = new Error(r.status === 429 ? "setlist.fm is busy, try again in a minute" : `setlist.fm error ${r.status}`); e.status = r.status === 429 ? 429 : 502; throw e; }
  return r.json();
}
const iso = d => { const [dd, mm, yy] = String(d || "").split("-"); return yy && mm && dd ? `${yy}-${mm}-${dd}` : ""; };
const dmy = isoDate => { const [y, m, d] = String(isoDate).split("-"); return `${d}-${m}-${y}`; };
function mapSetlist(x){
  const v = x.venue || {}, c = v.city || {};
  const songs = [];
  for (const set of ((x.sets || {}).set || [])) for (const s of (set.song || [])) if (s && s.name) songs.push(s.name + (s.tape ? " (tape)" : ""));
  return { id: x.id, date: iso(x.eventDate), artist: (x.artist || {}).name || "", venue: v.name || "", city: [c.name, c.stateCode || (c.country || {}).code].filter(Boolean).join(", "),
    tour: (x.tour || {}).name || "", songs, url: x.url || "" };
}
async function findSetlist(key, artist, date, fetchImpl){
  if (!artist || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { const e = new Error("need a band and a date"); e.status = 400; throw e; }
  const j = await get(key, `/search/setlists?artistName=${encodeURIComponent(artist)}&date=${dmy(date)}&p=1`, fetchImpl);
  const list = ((j && j.setlist) || []).map(mapSetlist).filter(s => s.songs.length);
  return { setlist: list[0] || null };
}
async function attended(key, username, fetchImpl, pause = ms => new Promise(r => setTimeout(r, ms))){
  if (!/^[\w.-]{2,40}$/.test(username)) { const e = new Error("that doesn't look like a setlist.fm username"); e.status = 400; throw e; }
  const out = [];
  for (let p = 1; p <= 20; p++) {
    const j = await get(key, `/user/${encodeURIComponent(username)}/attended?p=${p}`, fetchImpl);
    if (!j) { if (p === 1) { const e = new Error("no setlist.fm user with that name (or their attended list is private)"); e.status = 404; throw e; } break; }
    out.push(...(j.setlist || []).map(mapSetlist));
    if (p * (j.itemsPerPage || 20) >= (j.total || 0)) break;
    await pause(550); // setlist.fm allows about 2 requests a second
  }
  // group sets from the same night (one per band) into one show
  const shows = new Map();
  for (const s of out) {
    const k = s.date + "|" + s.venue.toLowerCase();
    const g = shows.get(k) || { date: s.date, venue: s.venue, city: s.city, tour: "", bands: [], songs: {} }; shows.set(k, g);
    if (s.artist && !g.bands.includes(s.artist)) g.bands.push(s.artist);
    if (s.tour && !g.tour) g.tour = s.tour;
    if (s.songs.length) g.songs[s.artist] = s.songs;
  }
  return { shows: [...shows.values()].sort((a, b) => b.date.localeCompare(a.date)) };
}
// ---- Past shows finder (Discover -> Past shows) ----
const normName = b => String(b || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
// Pick the artist people mean: exact name match first (setlist.fm "relevance" can rank a tribute act higher).
async function findArtist(key, name, fetchImpl){
  const j = await get(key, `/search/artists?artistName=${encodeURIComponent(name)}&sort=relevance&p=1`, fetchImpl);
  const list = (j && j.artist) || [];
  const want = normName(name);
  return list.find(a => normName(a.name) === want) || list[0] || null;
}
function mapPast(x){
  const v = x.venue || {}, c = v.city || {}, songs = ((x.sets || {}).set || []).reduce((n, s) => n + ((s.song || []).length), 0);
  return { id: x.id, date: iso(x.eventDate), artist: (x.artist || {}).name || "", venue: v.name || "", venueId: v.id || "",
    city: [c.name, c.stateCode || (c.country || {}).code].filter(Boolean).join(", "), country: (c.country || {}).code || "",
    tour: (x.tour || {}).name || "", songs, url: x.url || "" };
}
// One "page" here = up to 3 setlist.fm pages (60 shows), newest first.
async function pastShows(key, { artist, mbid, year, page = 1 }, fetchImpl, pause = ms => new Promise(r => setTimeout(r, ms))){
  if (!mbid) {
    if (!String(artist || "").trim()) { const e = new Error("type a band name"); e.status = 400; throw e; }
    const a = await findArtist(key, artist, fetchImpl);
    if (!a) return { artist: artist, mbid: "", shows: [], more: false, total: 0 };
    mbid = a.mbid; artist = a.name;
  }
  const y = /^\d{4}$/.test(String(year || "")) ? String(year) : "";
  const shows = []; let total = 0, last = 0;
  for (let k = 0; k < 3; k++) {
    const p = (page - 1) * 3 + k + 1;
    const j = await get(key, y ? `/search/setlists?artistMbid=${mbid}&year=${y}&p=${p}` : `/artist/${mbid}/setlists?p=${p}`, fetchImpl);
    if (!j) break;
    total = j.total || 0; last = p;
    shows.push(...(j.setlist || []).map(mapPast).filter(s => s.date));
    if (p * (j.itemsPerPage || 20) >= total) break;
    await pause(550);
  }
  const per = 20;
  return { artist, mbid, year: y, page, shows, total, more: last * per < total };
}
// Everyone who played one venue on one night (for the full bill and their setlists).
async function pastNight(key, { venueId, date }, fetchImpl){
  if (!/^[0-9a-f]{6,12}$/i.test(String(venueId || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) { const e = new Error("need a venue and a date"); e.status = 400; throw e; }
  const j = await get(key, `/search/setlists?venueId=${venueId}&date=${dmy(date)}&p=1`, fetchImpl);
  const sets = ((j && j.setlist) || []).map(mapSetlist);
  const bands = []; const songs = {}; let tour = "";
  for (const s of sets) { if (s.artist && !bands.includes(s.artist)) bands.push(s.artist); if (s.songs.length) songs[s.artist] = s.songs; if (s.tour && !tour) tour = s.tour; }
  // Headliner usually plays the longest set.
  bands.sort((a, b) => (songs[b] || []).length - (songs[a] || []).length);
  return { bands, songs, tour, url: (sets.find(s => s.songs.length) || sets[0] || {}).url || "" };
}
module.exports = { findSetlist, attended, mapSetlist, pastShows, pastNight, findArtist, mapPast };
