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
async function lookup(name, { fetchImpl = fetch, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}){
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
// Band profile: MusicBrainz basics (origin, formed, genres, official links) + the Wikipedia summary and photo.
const LINKS = [["spotify", /open\.spotify\.com\/artist\//], ["instagram", /instagram\.com\//], ["bandcamp", /bandcamp\.com/], ["youtube", /youtube\.com\/(channel|c|user|@)/], ["facebook", /facebook\.com\//], ["x", /(twitter|x)\.com\//]];
async function bandInfo(name, { fetchImpl = fetch, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}){
  const q = encodeURIComponent(`artist:"${String(name).replace(/"/g, "")}"`);
  const res = await getJSON(`https://musicbrainz.org/ws/2/artist?query=${q}&fmt=json&limit=5`, fetchImpl);
  const cands = (res.artists || []).filter(a => norm(a.name) === norm(name) || (a.aliases || []).some(x => norm(x.name) === norm(name)))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = cands[0]; if (!best || (best.score || 0) < 80) return { found: false, name };
  await pause(1100);
  const art = await getJSON(`https://musicbrainz.org/ws/2/artist/${best.id}?inc=url-rels+tags+genres&fmt=json`, fetchImpl);
  const urls = (art.relations || []).map(r => ({ type: r.type, url: r.url && r.url.resource })).filter(x => x.url);
  const links = {};
  const home = urls.find(x => x.type === "official homepage"); if (home) links.site = home.url;
  for (const [k, re] of LINKS) { const u = urls.find(x => re.test(x.url)); if (u) links[k] = u.url.split("?")[0]; }
  const genres = [...(art.genres || []), ...(art.tags || [])].sort((a, b) => (b.count || 0) - (a.count || 0)).map(g => g.name).filter((g, i, a) => a.indexOf(g) === i).slice(0, 5);
  const area = [art["begin-area"] && art["begin-area"].name, art.area && art.area.name].filter(Boolean);
  const out = { found: true, name: art.name || name, mbid: best.id, type: art.type || "", origin: [...new Set(area)].join(", "),
    formed: ((art["life-span"] || {}).begin || "").slice(0, 4), ended: (art["life-span"] || {}).ended ? ((art["life-span"] || {}).end || "").slice(0, 4) || "yes" : "",
    genres, links, about: "", image: "", wiki: "", disambiguation: art.disambiguation || "" };
  // Wikipedia summary + lead photo, through the band's Wikidata entry (English article).
  const wd = urls.find(x => /wikidata\.org\/wiki\/Q\d+/.test(x.url));
  let title = "";
  try {
    if (wd) {
      const qid = wd.url.match(/Q\d+/)[0];
      const ent = await getJSON(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, fetchImpl);
      const e = ((ent.entities || {})[qid]) || {};
      title = ((e.sitelinks || {}).enwiki || {}).title || "";
      const sp = ((e.claims || {}).P1902 || [])[0]; const sid = sp && sp.mainsnak && sp.mainsnak.datavalue && sp.mainsnak.datavalue.value;
      if (!links.spotify && sid) links.spotify = `https://open.spotify.com/artist/${sid}`;
    }
    const wp = urls.find(x => /en\.wikipedia\.org\/wiki\//.test(x.url)); if (!title && wp) title = decodeURIComponent(wp.url.split("/wiki/")[1]);
    if (title) {
      const sum = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, fetchImpl);
      if (sum && sum.type !== "disambiguation") {
        out.about = String(sum.extract || "").slice(0, 900);
        out.image = (sum.originalimage && sum.originalimage.width <= 2400 ? sum.originalimage.source : (sum.thumbnail || {}).source) || "";
        out.wiki = ((sum.content_urls || {}).desktop || {}).page || "";
      }
    }
  } catch (_) {}
  return out;
}
module.exports = { lookup, norm, bandInfo };
