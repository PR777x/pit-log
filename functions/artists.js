// Spotify artist pages for bands, without a Spotify app: MusicBrainz lists each artist's official links
// (often including Spotify); if not, its Wikidata entry usually has the Spotify artist ID (P1902).
// Results (including "not found") are cached in artistLinks/{key} so each band is looked up once a month.
const UA = "PitLog/1.0 (https://thepitlog.com; support@thepitlog.com)";
const norm = b => String(b || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
async function getJSON(url, fetchImpl){
  const r = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) { const e = new Error("lookup " + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function lookup(name, opts = {}){
  let wdOk = false;
  try { const hit = await findBandEntity(name, opts.fetchImpl || fetch); wdOk = true; const sp = hit && claim(hit.e, "P1902")[0]; if (sp) return { spotify: `https://open.spotify.com/artist/${sp}`, mbid: "" }; } catch (_) {}
  try { return await lookupMB(name, opts); }
  catch (e) { if (wdOk) return { spotify: "", mbid: "" }; throw e; } // both sources down: don't cache a "not found"
}
async function lookupMB(name, { fetchImpl = fetch, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}){
  const q = encodeURIComponent(`artist:"${name.replace(/"/g, "")}"`);
  const res = await getJSON(`https://musicbrainz.org/ws/2/artist?query=${q}&fmt=json&limit=5`, fetchImpl);
  const cands = (res.artists || []).filter(a => norm(a.name) === norm(name) || (a.aliases || []).some(x => norm(x.name) === norm(name)))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = cands[0]; if (!best || (best.score || 0) < 80) return { spotify: "", mbid: "" };
  await pause(1100); // MusicBrainz asks for at most 1 request a second
  const art = await getJSON(`https://musicbrainz.org/ws/2/artist/${best.id}?inc=url-rels&fmt=json`, fetchImpl);
  const urls = (art.relations || []).map(r => r.url && r.url.resource).filter(Boolean);
  let spotify = urls.find(u => /open\.spotify\.com\/artist\//.test(u)) || "";
  if (!spotify) {
    const wd = urls.find(u => /wikidata\.org\/wiki\/Q\d+/.test(u));
    if (wd) {
      const qid = wd.match(/Q\d+/)[0];
      try {
        const ent = await getJSON(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, fetchImpl);
        const c = (((ent.entities || {})[qid] || {}).claims || {}).P1902;
        const id = c && c[0] && c[0].mainsnak && c[0].mainsnak.datavalue && c[0].mainsnak.datavalue.value;
        if (id) spotify = `https://open.spotify.com/artist/${id}`;
      } catch (_) {}
    }
  }
  return { spotify: spotify.split("?")[0], mbid: best.id };
}
// Band profile from Wikidata + Wikipedia (MusicBrainz turns away requests from cloud servers with 503s).
// Wikidata: origin, formed/split years, genres, official links, Spotify. Wikipedia: summary and lead photo.
const WD = "https://www.wikidata.org/w/api.php";
const BAND_TYPES = new Set(["Q215380", "Q5741069", "Q2088357", "Q56816954", "Q641066", "Q9212979", "Q7210356", "Q105543609", "Q4438121"]);
const BANDISH = /\b(band|group|musical|musician|singer|rapper|duo|trio|project|ensemble|artist)\b/i;
const claim = (e, p) => ((e.claims || {})[p] || []).map(c => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value).filter(v => v != null);
const yearOf = v => { const m = v && v.time && String(v.time).match(/^[+-]?(\d{4})/); return m ? m[1] : ""; };
async function wdEntities(ids, props, fetchImpl){
  if (!ids.length) return {};
  const j = await getJSON(`${WD}?action=wbgetentities&ids=${ids.slice(0, 40).join("|")}&props=${props}&languages=en&format=json&origin=*`, fetchImpl);
  return j.entities || {};
}
async function findBandEntity(name, fetchImpl){
  const j = await getJSON(`${WD}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&type=item&limit=10&format=json&origin=*`, fetchImpl);
  const hits = (j.search || []).filter(h => norm(h.label) === norm(name) || norm((h.match || {}).text) === norm(name));
  if (!hits.length) return null;
  const ents = await wdEntities(hits.map(h => h.id), "claims|sitelinks|labels|descriptions", fetchImpl);
  const scored = hits.map((h, i) => { const e = ents[h.id] || {}; const types = claim(e, "P31").map(v => v.id);
    const d = h.description || "", notBand = /^(\d{4}\s+)?(song|single|album|ep|film|novel|book|episode|video game|television|tv)\b/i.test(d) || /\b(song|single|album) (by|from)\b/i.test(d);
    const band = notBand ? 0 : types.some(t => BAND_TYPES.has(t)) ? 3 : BANDISH.test(d) ? 2 : 0;
    return { e, id: h.id, band, s: band * 10 - i + (((e.sitelinks || {}).enwiki) ? 1 : 0) }; }).sort((a, b) => b.s - a.s);
  return scored[0] && scored[0].band >= 2 ? scored[0] : null;
}
async function wikiSummary(title, fetchImpl){
  const sum = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, fetchImpl);
  if (!sum || sum.type === "disambiguation") return null;
  // Big originals get a 1200px copy (Wikimedia's thumbnail URLs take the width in the path).
  const o = sum.originalimage, t = (sum.thumbnail || {}).source || "";
  // Wikimedia only serves thumbnails at standard widths (…, 330, 500, 960, 1280); 960 looks sharp on phones.
  const small = t ? t.replace(/\?.*$/, "") : "";
  const image = o && o.width <= 1280 ? o.source : small ? small.replace(/\/\d+px-/, "/960px-") : (o && o.source) || "";
  return { about: String(sum.extract || "").slice(0, 900), image, imageSmall: small || image, wiki: ((sum.content_urls || {}).desktop || {}).page || "", wd: sum.wikibase_item || "" };
}
async function bandInfo(name, { fetchImpl = fetch } = {}){
  const hit = await findBandEntity(name, fetchImpl);
  const out = { found: false, name, origin: "", formed: "", ended: "", genres: [], links: {}, about: "", image: "", wiki: "" };
  let title = "";
  if (hit) { await fillFromEntity(out, hit.e, hit.id, name, fetchImpl); title = ((hit.e.sitelinks || {}).enwiki || {}).title || ""; }
  // No Wikidata match (or no English article linked): try Wikipedia directly. Only accept a page that says it's about a band.
  const IS_BAND = /\b(is|are|was|were)\s+(an?\s+|the\s+)?[^.]{0,80}?\b(band|group|duo|trio|supergroup|musical project)\b/i;
  let tries = title ? [title] : [`${name} (band)`, `${name} (American band)`, name];
  if (!title) try {
    const sr = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name + " band")}&srlimit=5&format=json&origin=*`, fetchImpl);
    for (const r of ((sr.query || {}).search || [])) if (norm(String(r.title).replace(/\s*\(.*\)$/, "")) === norm(name) && !tries.includes(r.title)) tries.splice(1, 0, r.title);
  } catch (_) {}
  for (const t of tries) {
    try { const w = await wikiSummary(t, fetchImpl); if (w && (title || IS_BAND.test(w.about.slice(0, 300)))) {
      out.about = w.about; out.wiki = w.wiki; if (w.image) { out.image = w.image; out.imageSmall = w.imageSmall; } out.found = true;
      // Found the article without Wikidata search: its Wikidata entry still has origin, genres and links.
      if (!out.wd && w.wd) try { const ents = await wdEntities([w.wd], "claims|sitelinks|labels", fetchImpl); if (ents[w.wd]) await fillFromEntity(out, ents[w.wd], w.wd, name, fetchImpl); } catch (_) {}
      break; } } catch (_) {}
  }
  // Still no photo: Deezer's artist picture (free, no key). Skip its blank placeholder.
  if (!out.image) try {
    const dz = await getJSON(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`, fetchImpl);
    const a = ((dz && dz.data) || []).find(x => norm(x.name) === norm(name) && x.picture_xl && !/\/artist\/\/|\/images\/artist\/\//.test(x.picture_xl));
    if (a) { out.image = a.picture_xl; out.imageSmall = a.picture_big || a.picture_xl; out.imageCredit = "Deezer"; out.found = true; if (!out.links.deezer && a.link) out.links.deezer = a.link; }
  } catch (_) {}
  return out;
}
async function fillFromEntity(out, e, id, name, fetchImpl){
  {
    out.found = true; out.name = ((e.labels || {}).en || {}).value || out.name || name; out.wd = id;
    out.formed = yearOf(claim(e, "P571")[0]); const end = yearOf(claim(e, "P576")[0]); if (end) out.ended = end;
    const place = claim(e, "P740").map(v => v.id), country = claim(e, "P495").map(v => v.id), genres = claim(e, "P136").map(v => v.id).slice(0, 6);
    const labels = await wdEntities([...new Set([...place.slice(0, 1), ...country.slice(0, 1), ...genres])], "labels", fetchImpl).catch(() => ({}));
    const L = id => ((labels[id] || {}).labels || {}).en ? labels[id].labels.en.value : "";
    out.origin = [...new Set([L(place[0]), L(country[0])].filter(Boolean))].join(", ");
    out.genres = genres.map(L).filter(Boolean).slice(0, 5);
    const site = claim(e, "P856")[0], sp = claim(e, "P1902")[0], ig = claim(e, "P2003")[0], bc = claim(e, "P3283")[0], yt = claim(e, "P2397")[0];
    if (site) out.links.site = site; if (sp) out.links.spotify = `https://open.spotify.com/artist/${sp}`;
    if (ig) out.links.instagram = `https://www.instagram.com/${ig}/`; if (bc) out.links.bandcamp = `https://${bc}.bandcamp.com`;
    if (yt) out.links.youtube = `https://www.youtube.com/channel/${yt}`;
    const p18 = claim(e, "P18")[0]; if (p18 && !out.image) out.image = out.imageSmall = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(p18)}?width=960`;
  }
}
module.exports = { lookup, norm, bandInfo };
