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
module.exports = { findSetlist, attended, mapSetlist };
