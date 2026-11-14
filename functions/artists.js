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
module.exports = { lookup, norm };
