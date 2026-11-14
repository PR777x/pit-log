// Offline test: runs the real functions against an in-memory fake of Firestore/Auth and a fake email API.
const Module = require("module");
const assert = require("assert");
const store = new Map(); // path -> data
const AUTH = {}; // uid -> fake Firebase Auth user
const DELETED_PREFIX = [], DELETED_USERS = [];
const emails = [];
let auto = 0;
const clone = v => JSON.parse(JSON.stringify(v));
function docRef(path){
  return { path, id: path.split("/").pop(),
    get: async () => ({ exists: store.has(path), id: path.split("/").pop(), ref: docRef(path), data: () => clone(store.get(path)) }),
    set: async (v, o) => { const cur = store.get(path) || {}, nv = clean(v);
      if (o && o.merge) { for (const [k, x] of Object.entries(nv)) cur[k] = x && typeof x === "object" && !Array.isArray(x) ? { ...(cur[k] || {}), ...x } : x; store.set(path, cur); } else store.set(path, nv); },
    update: async v => { const cur = store.get(path) || {}; for (const [k, val] of Object.entries(v)) { if (k.includes(".")) { const [a, b] = k.split("."); cur[a] = { ...(cur[a] || {}), [b]: val }; } else cur[k] = val; } store.set(path, cur); },
    delete: async () => { store.delete(path); } };
}
const clean = v => JSON.parse(JSON.stringify(v, (k, x) => (x && x.__ts ? "ts" : x)));
function coll(path, filters = [], lim = 1e9){
  return { doc: id => docRef(`${path}/${id || "auto" + (++auto)}`), add: async v => docRef(`${path}/auto${++auto}`).set(v),
    where: (f, op, v) => coll(path, [...filters, [f, op, v]], lim), limit: n => coll(path, filters, n),
    get: async () => ({ docs: [...store.keys()].filter(k => k.startsWith(path + "/") && k.split("/").length === path.split("/").length + 1)
      .filter(k => filters.every(([f, op, v]) => { const x = (store.get(k) || {})[f];
        return op === "array-contains-any" ? Array.isArray(x) && x.some(y => v.includes(y)) : op === "array-contains" ? Array.isArray(x) && x.includes(v)
          : op === ">=" ? x !== undefined && x >= v : op === "<=" ? x !== undefined && x <= v : op === "<" ? x !== undefined && x < v : x === v; })).slice(0, lim).map(k => ({ id: k.split("/").pop(), ref: docRef(k), data: () => clone(store.get(k)) })) }) };
}
const fakeDb = { doc: docRef, collection: p => coll(p), batch: () => { const ops = []; return { set: (r, v) => ops.push(() => r.set(v)), delete: r => ops.push(() => r.delete()), commit: async () => { for (const o of ops) await o(); } }; } };
const fakes = {
  "firebase-functions/v2/firestore": { onDocumentCreated: (o, h) => h, onDocumentUpdated: (o, h) => h, onDocumentWritten: (o, h) => h },
  "firebase-functions/v2/scheduler": { onSchedule: (o, h) => h },
  "firebase-functions/v2/https": { onRequest: (o, h) => h },
  "firebase-functions/params": { defineSecret: () => ({ value: () => "test-key" }) },
  "firebase-functions/v2": { setGlobalOptions: () => {}, logger: { info: () => {}, error: (...a) => console.error(...a) } },
  "firebase-admin/app": { initializeApp: () => {} },
  "firebase-admin/storage": { getStorage: () => ({ bucket: () => ({ deleteFiles: async o => { DELETED_PREFIX.push(o.prefix); } }) }) },
  "firebase-admin/auth": { getAuth: () => ({ getUser: async uid => AUTH[uid] || { email: uid + "@example.com", emailVerified: true },
    generateEmailVerificationLink: async (email, s) => `https://pit-log.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=CODE-${encodeURIComponent(email)}&continueUrl=${encodeURIComponent(s.url)}`,
    deleteUser: async uid => { DELETED_USERS.push(uid); },
    verifyIdToken: async t => { if (!t.startsWith("tok-")) throw new Error("bad"); return { uid: t.slice(4) }; } }) },
  "firebase-admin/firestore": { getFirestore: id => { assert.strictEqual(id, "pit-log"); return fakeDb; }, FieldValue: { serverTimestamp: () => ({ __ts: 1 }) } },
};
const orig = Module._load;
Module._load = function (req, ...rest) { return fakes[req] || orig.call(this, req, ...rest); };
global.fetch = async (url, init) => { emails.push({ url, ...JSON.parse(init.body) }); return { ok: true, text: async () => "" }; };
const F = require("./index.js");
const L = require("./lib");

const snap = (exists, data) => ({ exists, data: () => clone(data) });
const write = (path, before, after) => { if (after) store.set(path, clone(after)); else store.delete(path); const [, uid, , showId] = path.split("/");
  return F.onShowWrite({ params: { uid, showId }, data: { before: snap(!!before, before), after: snap(!!after, after) } }); };
const sentTo = who => emails.filter(e => e.to[0] === who + "@example.com");

(async () => {
  const today = L.todayET(), soon = L.addDays(today, 7), tomorrow = L.addDays(today, 1);
  store.set("users/pat", { name: "Pat", handle: "pat" });
  store.set("users/carly", { name: "Carly", handle: "carly_r" });
  store.set("users/stacie", { name: "Stacie", handle: "stacie", settings: { emailTags: "off" } });
  store.set("users/ken", { name: "Ken", handle: "kenny", settings: { upcoming: "private" } });

  const inbox = uid => [...store.keys()].filter(k => k.startsWith(`users/${uid}/inbox/`)).map(k => store.get(k));
  const clearInbox = () => { for (const k of [...store.keys()]) if (/\/inbox\//.test(k)) store.delete(k); };
  // 1. Crew request -> nothing sent right away; it's queued for the person asked
  const req = { from: "pat", to: "stacie", status: "pending" };
  store.set("friendRequests/pat_stacie", req);
  await F.onCrewRequest({ data: { data: () => req } });
  assert.strictEqual(emails.length, 0, "no instant emails");
  assert.deepStrictEqual(inbox("stacie").map(i => [i.type, i.fromHandle]), [["request", "pat"]]);
  // accepted -> queued for Pat; the 6 PM digest delivers both
  const acc = { ...req, status: "accepted" }; store.set("friendRequests/pat_stacie", acc);
  await F.onCrewRequestChange({ data: { before: { data: () => req }, after: { data: () => acc } } });
  assert.strictEqual(emails.length, 0);
  await F.runDigest();
  assert.match(sentTo("stacie")[0].subject, /@pat wants you in their crew/); assert.match(sentTo("stacie")[0].html, /1 crew request/);
  assert.match(sentTo("pat")[0].subject, /@stacie accepted/);
  assert.strictEqual(emails.length, 2, "only the two people with news get an email");
  // Crew Family invite + approval, also through the digest
  emails.length = 0;
  const f0 = { from: "pat", to: "stacie", status: "accepted" }, f1 = { ...f0, family: "pending", familyBy: "pat" };
  await F.onCrewRequestChange({ data: { before: { data: () => f0 }, after: { data: () => f1 } } });
  await F.onCrewRequestChange({ data: { before: { data: () => f1 }, after: { data: () => ({ ...f1, family: "active" }) } } });
  assert.strictEqual(emails.length, 0); await F.runDigest();
  assert.match(sentTo("stacie")[0].subject, /invited you to Crew Family/); assert.match(sentTo("pat")[0].html, /approved Crew Family/);
  emails.length = 0; clearInbox();
  store.set("friendRequests/pat_carly", { from: "pat", to: "carly", status: "accepted" });
  store.set("friendRequests/ken_pat", { from: "ken", to: "pat", status: "accepted" });

  // 2. Tags: queued for Carly (no instant email); Stacie turned tags off
  await write("users/pat/shows/s1", null, { date: soon, lineup: ["Insomnium", "Amorphis"], venue: "Reverb", city: "Reading, PA", taggedUids: ["carly", "stacie"], notes: "secret", ticketTotal: 90 });
  assert.strictEqual(emails.length, 0, "tags aren't emailed right away");
  assert.ok(inbox("carly").some(i => i.type === "tagged")); assert.ok(!inbox("stacie").some(i => i.type === "tagged"));
  // editing the show again doesn't re-queue tags or activity
  const before = store.get("users/pat/shows/s1");
  await write("users/pat/shows/s1", before, { ...before, rating: 4 });
  assert.strictEqual(inbox("carly").filter(i => i.type === "tagged").length, 1);

  // 3. Activity queue: Carly and Stacie get "added", Ken (who has the same show) gets "together", and so does Pat
  assert.deepStrictEqual(inbox("carly").map(i => i.type).sort(), ["added", "tagged"]);
  assert.deepStrictEqual(inbox("stacie").map(i => i.type), ["added"]);
  assert.strictEqual(inbox("carly").find(i => i.type === "added").show.notes, undefined, "queued show has no notes");
  store.set("users/ken/shows/k1", { date: soon, lineup: ["Insomnium"], venue: "Reverb" });
  await write("users/pat/shows/s2", null, { date: soon, lineup: ["Amorphis"], venue: "Reverb" });
  assert.ok(inbox("ken").some(i => i.type === "together" && i.fromHandle === "pat"));
  // Ken keeps upcoming shows private, so Pat is NOT told Ken is going
  assert.ok(!inbox("pat").some(i => i.type === "together"));
  // Family copies don't queue anything
  const n0 = inbox("carly").length;
  await write("users/pat/shows/fam1", null, { date: soon, lineup: ["X"], addedBy: "carly" });
  assert.strictEqual(inbox("carly").length, n0);

  // 4. A big import reads as one grouped line in the digest
  for (let i = 0; i < 12; i++) await write(`users/pat/shows/imp${i}`, null, { date: L.addDays(today, -100 - i), lineup: ["Band " + i], venue: "TLA" });
  store.set("users/carly/shows/c1", { date: tomorrow, lineup: ["Die Spitz"], venue: "Union Transfer" });
  emails.length = 0;
  await F.runDigest();
  const d = sentTo("carly")[0];
  assert.ok(d, "Carly gets a digest");
  assert.match(d.html, /Coming up for you/); assert.match(d.html, /Tomorrow/);
  assert.match(d.html, /@pat<\/b> added 14 shows, 2 coming up/); assert.match(d.html, /and 11 more/);
  assert.strictEqual(inbox("carly").length, 0, "digest clears the queue");
  assert.ok(sentTo("ken")[0] && /going too/.test(sentTo("ken")[0].html));
  assert.match(d.html, /You were tagged/); assert.ok(!d.html.includes("secret") && !/\b90\b/.test(d.html), "no private details in emails");
  // running again sends nothing new to Carly except tomorrow's reminder
  emails.length = 0; await F.runDigest();
  assert.ok(!/added/.test((sentTo("carly")[0] || {}).html || ""));

  // 5. Unsubscribe link turns emails off
  const tok = store.get("mail/carly").token; let page = "";
  const res = { status: () => ({ send: h => { page = h; } }) };
  await F.unsubscribe({ query: { u: "carly", t: tok, k: "digest" } }, res);
  assert.strictEqual(store.get("users/carly").settings.emailDigest, "off"); assert.match(page, /won't get those/);
  await F.unsubscribe({ query: { u: "carly", t: "wrong", k: "all" } }, res); assert.match(page, /expired/);

  // 6. Anti-spam
  // a) a quiet day sends nothing at all
  for (const k of [...store.keys()]) if (/\/inbox\//.test(k)) store.delete(k);
  store.delete("users/carly/shows/c1"); store.set("users/carly", { name: "Carly", handle: "carly_r" });
  for (const k of [...store.keys()]) if (/\/shows\//.test(k) && [soon, tomorrow].includes(store.get(k).date)) store.delete(k); // no reminders due
  emails.length = 0; await F.runDigest();
  assert.strictEqual(emails.length, 0, "no news, no email");
  // b) re-sending a crew request the same day only counts once
  store.set("users/dana", { name: "Dana", handle: "dana" });
  const r2 = { from: "dana", to: "carly", status: "pending" };
  await F.onCrewRequest({ data: { data: () => r2 } }); await F.onCrewRequest({ data: { data: () => r2 } });
  assert.strictEqual(inbox("carly").filter(i => i.type === "request").length, 1, "one request per person per day");
  // c) bulk tagging (linking old tags) + the request: still ONE email that evening
  for (let i = 0; i < 10; i++) await write(`users/pat/shows/old${i}`, { date: L.addDays(today, -300 - i), lineup: ["Old " + i] }, { date: L.addDays(today, -300 - i), lineup: ["Old " + i], taggedUids: ["carly"] });
  assert.strictEqual(emails.length, 0);
  emails.length = 0; await F.runDigest();
  assert.strictEqual(sentTo("carly").length, 1); assert.match(sentTo("carly")[0].html, /You were tagged/); assert.match(sentTo("carly")[0].html, /and 4 more/);
  assert.match(sentTo("carly")[0].subject, /@dana wants you in their crew/);
  // d2) tags turned off: nothing queued
  store.set("users/carly", { name: "Carly", handle: "carly_r", settings: { emailTags: "off" } });
  await write("users/pat/shows/t9", { date: L.addDays(today, -5), lineup: ["T9"] }, { date: L.addDays(today, -5), lineup: ["T9"], taggedUids: ["carly"] });
  assert.ok(!inbox("carly").some(i => i.type === "tagged"));
  store.set("users/carly", { name: "Carly", handle: "carly_r" });
  // d) shows deleted before the digest aren't reported
  await write("users/pat/shows/gone", null, { date: soon, lineup: ["Deleted Band"], venue: "TLA" });
  await write("users/pat/shows/gone", store.get("users/pat/shows/gone"), null);
  emails.length = 0; await F.runDigest();
  assert.ok(!emails.some(e => /Deleted Band/.test(e.html)), "deleted shows are skipped");
  assert.ok(!sentTo("carly").length, "and if that was the only news, no email");
  // e) digest off: nothing queues, and nothing arrives later as a backlog
  store.set("users/carly", { name: "Carly", handle: "carly_r", settings: { emailDigest: "off" } });
  await write("users/pat/shows/x9", null, { date: soon, lineup: ["Queued Band"], venue: "TLA" });
  assert.strictEqual(inbox("carly").length, 0);
  store.set("users/carly", { name: "Carly", handle: "carly_r" }); emails.length = 0; await F.runDigest();
  assert.ok(!sentTo("carly").some(e => /Queued Band/.test(e.html)));

  // 7. Weekly recap
  for (const k of [...store.keys()]) if (/\/(inbox|shows)\//.test(k) || k.startsWith("friendRequests/") || k.startsWith("mail/")) store.delete(k);
  store.set("users/carly", { name: "Carly", handle: "carly_r" });
  store.set("friendRequests/pat_carly", { from: "pat", to: "carly", status: "accepted" });
  store.set("friendRequests/ken_pat", { from: "ken", to: "pat", status: "accepted" });
  store.set("friendRequests/dana_pat", { from: "dana", to: "pat", status: "pending" });
  store.set("users/pat/shows/w1", { date: L.addDays(today, 10), lineup: ["Gatecreeper"], venue: "Union Transfer", ticketTotal: 55, notes: "secret" });
  store.set("users/pat/shows/w0", { date: L.addDays(today, -5), lineup: ["Past Band"], venue: "TLA" });
  store.set("users/carly/shows/cw1", { date: L.addDays(today, 10), lineup: ["Gatecreeper"], venue: "Union Transfer" });
  store.set("users/carly/shows/cw2", { date: L.addDays(today, 20), lineup: ["Frozen Soul"], venue: "Reverb" });
  store.set("users/ken/shows/kw1", { date: L.addDays(today, 10), lineup: ["Gatecreeper"], venue: "Union Transfer" }); // Ken hides upcoming shows
  emails.length = 0; await F.runRecap();
  const w = sentTo("pat")[0];
  assert.ok(w, "Pat gets a weekly recap");
  assert.match(w.subject, /1 crew request waiting/);
  assert.match(w.html, /1 open crew request/); assert.match(w.html, /Gatecreeper/);
  assert.match(w.html, /Crew going too: @carly_r/); assert.ok(!/@kenny/.test(w.html), "private upcoming stays private");
  assert.match(w.html, /Frozen Soul/); assert.ok(!/Past Band/.test(w.html)); assert.ok(!/secret/.test(w.html), "no notes in emails");
  assert.ok(sentTo("carly")[0] && /Crew going too: @pat/.test(sentTo("carly")[0].html), "Carly sees Pat is going too");
  // nothing at all -> no recap; weekly off -> no recap
  store.set("users/zed", { name: "Zed", handle: "zed" });
  store.set("users/ken", { name: "Ken", handle: "kenny", settings: { upcoming: "private", emailWeekly: "off" } });
  emails.length = 0; await F.runRecap(); assert.ok(!sentTo("ken").length && !sentTo("zed").length);
  // the Sunday evening digest doesn't repeat reminders the recap already covered
  store.set("users/pat/shows/w2", { date: tomorrow, lineup: ["Tomorrow Band"], venue: "TLA" });
  emails.length = 0; await F.runRecap(); await F.runDigest();
  assert.strictEqual(sentTo("pat").length, 1, "one email that day, not two");

  // 8. Show catalog (Ticketmaster)
  const C = require("./catalog");
  const ev = (id, date, name, bands, venue, city = "Philadelphia", st = "PA", status = "onsale") => ({ id, name, url: "https://tm.example/" + id,
    dates: { start: { localDate: date, localTime: "19:00:00" }, status: { code: status } }, classifications: [{ genre: { name: "Metal" } }],
    _embedded: { venues: [{ name: venue, city: { name: city }, state: { stateCode: st } }], attractions: bands.map(n => ({ name: n })) } });
  const g = C.fromTM(ev("a", L.addDays(today, 30), "Gojira & Mastodon: Mega Monsters Tour", ["Gojira", "Mastodon", "Lorna Shore"], "Xfinity Mobile Arena"));
  assert.strictEqual(g.tour, "Mega Monsters Tour"); assert.strictEqual(g.coHead, true); assert.deepStrictEqual(g.bandKeys, ["gojira", "mastodon", "lornashore"]);
  assert.strictEqual(C.fromTM(ev("p", L.addDays(today, 30), "PARKING: Gojira", ["Gojira"], "Xfinity Mobile Arena")), null, "parking passes skipped");
  assert.strictEqual(C.fromTM(ev("v", L.addDays(today, 30), "Gojira - VIP Packages", ["Gojira"], "Xfinity Mobile Arena")), null, "VIP listings skipped");
  let tmEvents = { PA: [ev("a", L.addDays(today, 30), "Gojira & Mastodon: Mega Monsters Tour", ["Gojira", "Mastodon", "Lorna Shore"], "Xfinity Mobile Arena"),
                        ev("a2", L.addDays(today, 30), "Gojira & Mastodon: Mega Monsters Tour - Presale", ["Gojira", "Mastodon"], "Xfinity Mobile Arena"),
                        ev("b", L.addDays(today, 45), "Insomnium", ["Insomnium", "Omnium Gatherum"], "Reverb", "Reading"),
                        ev("x", L.addDays(today, 50), "Some Pop Act", ["Pop Star"], "Liacouras Center")] };
  const calls = [];
  const tmFetch = async url => { const u = new URL(url); calls.push(u.searchParams.get("apikey"));
    const st = u.searchParams.get("stateCode"), from = u.searchParams.get("startDateTime").slice(0, 10), to = u.searchParams.get("endDateTime").slice(0, 10);
    const list = (tmEvents[st] || []).filter(e => e.dates.start.localDate >= from && e.dates.start.localDate < to);
    return { ok: true, status: 200, json: async () => ({ _embedded: list.length ? { events: list } : undefined, page: { totalPages: 1, number: 0 } }) }; };
  const nop = async () => {};
  assert.deepStrictEqual(await F.runCatalog({ apiKey: "none", fetchImpl: tmFetch, pause: nop }), { skipped: true });
  let c1 = await F.runCatalog({ apiKey: "k", fetchImpl: tmFetch, pause: nop });
  assert.strictEqual(c1.added, 3, "presale listing merged into the same show"); assert.strictEqual(c1.announced, 0, "first load isn't 'just announced'"); assert.ok(calls.length > 40 && calls.every(k => k === "k"));
  const cat = () => [...store.keys()].filter(k => k.startsWith("catalog/")).map(k => store.get(k));
  const goj = cat().find(c => c.bandKeys.includes("gojira"));
  assert.strictEqual(goj.lineup.length, 3); assert.strictEqual(goj.firstSeen, ""); assert.strictEqual(goj.key, undefined);
  assert.strictEqual(JSON.parse(store.get("catalogMeta/recent").data).length, 0);
  // Discover month shards
  const ml = store.get("catalogMeta/months").list; assert.ok(ml.length >= 1);
  const allUp = ml.flatMap(x => JSON.parse(store.get(`catalogMonths/${x.m}`).data));
  assert.strictEqual(allUp.length, 3); assert.ok(allUp.every(x => x.d >= today && x.u && x.l.length));
  // second day, nothing changed: no writes
  let c2 = await F.runCatalog({ apiKey: "k", fetchImpl: tmFetch, pause: nop, now: new Date(Date.now() + 864e5) });
  assert.strictEqual(c2.added + c2.updated + c2.removed, 0, "unchanged shows aren't rewritten");
  // a time change updates the show but keeps firstSeen; a vanished future show is removed
  tmEvents.PA[2] = { ...tmEvents.PA[2], dates: { ...tmEvents.PA[2].dates, start: { localDate: tmEvents.PA[2].dates.start.localDate, localTime: "20:00:00" } } };
  tmEvents.PA = tmEvents.PA.filter(e => e.id !== "x");
  let c3 = await F.runCatalog({ apiKey: "k", fetchImpl: tmFetch, pause: nop });
  assert.strictEqual(c3.updated, 1); assert.strictEqual(c3.removed, 1); assert.strictEqual(cat().length, 2);
  // a show announced after the first load is "just announced"
  tmEvents.PA.push(ev("n", L.addDays(today, 70), "Insomnium", ["Insomnium", "Omnium Gatherum"], "Union Transfer"));
  const c4 = await F.runCatalog({ apiKey: "k", fetchImpl: tmFetch, pause: nop });
  assert.strictEqual(c4.announced, 1); assert.strictEqual(cat().find(c => c.venue === "Union Transfer").firstSeen, today);
  // Ticketmaster returns nothing: catalog left alone
  const saved = tmEvents; tmEvents = {};
  assert.deepStrictEqual(await F.runCatalog({ apiKey: "k", fetchImpl: tmFetch, pause: nop }), { aborted: true }); assert.strictEqual(cat().length, 3);
  tmEvents = saved;
  // weekly recap mentions new announcements for bands Pat has logged (Insomnium), not ones he hasn't
  store.set("users/pat/shows/old-ins", { date: L.addDays(today, -400), lineup: ["Insomnium"], venue: "Reverb" });
  emails.length = 0; await F.runRecap();
  const wr = sentTo("pat")[0]; assert.match(wr.html, /Just announced: bands you've seen/); assert.match(wr.html, /Insomnium w\/ Omnium Gatherum/); assert.match(wr.html, /Union Transfer/); assert.ok(!/Reverb, Reading/.test(wr.html.split("Just announced")[1] || ""), "first-load shows aren't 'just announced'");
  assert.ok(!/Gojira/.test(wr.html.split("Just announced")[1] || ""), "only bands you've logged");
  assert.match(wr.html, /tm\.example\/n/);
  // bucket list: Gojira (never seen) now shows up too, first, with a note
  store.set("users/pat", { ...store.get("users/pat"), bucket: ["Gojira"] });
  emails.length = 0; await F.runRecap();
  const wb = sentTo("pat")[0].html;
  // Gojira was in the first load (not "just announced"), so it shows as still on sale
  assert.match(wb, /Still on sale: your bucket list/); assert.match(wb, /Gojira &amp; Mastodon/);
  assert.match(sentTo("pat")[0].subject + wb, /bucket list date on sale/);
  // a brand-new Gojira date is "just announced", flagged as bucket list, and not repeated under "still on sale"
  tmEvents.PA.push(ev("g2", L.addDays(today, 90), "Gojira", ["Gojira"], "The Fillmore Philadelphia"));
  await F.runCatalog({ apiKey: "k", fetchImpl: tmFetch, pause: nop });
  emails.length = 0; await F.runRecap();
  const wn = sentTo("pat")[0].html; assert.match(wn, /Just announced for you/); assert.match(wn, /On your bucket list/);
  assert.strictEqual(wn.split("The Fillmore Philadelphia").length - 1, 1, "new date listed once");

  // 8b. a tour Pat already has a date for: no other dates of it in the recap
  store.set("users/pat/shows/gojtix", { date: L.addDays(today, 30), lineup: ["Gojira", "Mastodon"], coHead: true, venue: "Xfinity Mobile Arena" });
  emails.length = 0; await F.runRecap();
  assert.ok(!/Still on sale: your bucket list/.test(sentTo("pat")[0].html) || !/Gojira &amp; Mastodon/.test(sentTo("pat")[0].html.split("Still on sale")[1] || ""), "tour already logged: other dates hidden");
  assert.ok(!/The Fillmore Philadelphia/.test(sentTo("pat")[0].html.split("Just announced")[1] || ""), "new Gojira date hidden too");
  store.delete("users/pat/shows/gojtix");

  // 9. Show reminders list every show in the next week, but only fire on 7-day / 1-day marks
  for (const k of [...store.keys()]) if (/\/(inbox|shows)\//.test(k) || k.startsWith("mail/") || k.startsWith("catalog")) store.delete(k);
  store.set("users/zz", { name: "Zed", handle: "zed" });
  store.set("users/zz/shows/a", { date: L.addDays(today, 1), lineup: ["Alpha"], venue: "TLA" });
  store.set("users/zz/shows/b", { date: L.addDays(today, 4), lineup: ["Bravo"], venue: "Reverb" });
  store.set("users/zz/shows/c", { date: L.addDays(today, 7), lineup: ["Charlie"], venue: "Union Transfer" });
  store.set("users/zz/shows/d", { date: L.addDays(today, 9), lineup: ["Delta"], venue: "Union Transfer" });
  emails.length = 0; await F.runDigest();
  const rz = sentTo("zz")[0]; assert.ok(rz, "reminder sent");
  assert.match(rz.html, /Your week ahead: 3 shows/); for (const n of ["Alpha", "Bravo", "Charlie"]) assert.match(rz.html, new RegExp(n));
  assert.ok(!/Delta/.test(rz.html), "only the next 7 days"); assert.match(rz.html, /In 4 days/); assert.match(rz.subject, /3 shows this week, starting tomorrow/);
  assert.ok(rz.html.indexOf("Alpha") < rz.html.indexOf("Bravo") && rz.html.indexOf("Bravo") < rz.html.indexOf("Charlie"), "in date order");
  // a show 4 days out alone doesn't trigger an email every day
  store.delete("users/zz/shows/a"); store.delete("users/zz/shows/c");
  emails.length = 0; await F.runDigest(); assert.ok(!sentTo("zz").length, "no 7/1-day mark today, no email");

  // 10. Account emails: confirm-your-email for email sign-ups, welcome once confirmed (or right away for Google)
  emails.length = 0;
  AUTH.newbie = { email: "newbie@example.com", emailVerified: false };
  store.set("users/newbie", { name: "Sam Rivera", handle: "samr" });
  await F.onUserCreated({ params: { uid: "newbie" }, data: { data: () => store.get("users/newbie") } });
  const ve = sentTo("newbie")[0]; assert.ok(ve, "verification sent");
  assert.match(ve.subject, /Confirm your email/); assert.match(ve.html, /Sam, one/);
  assert.match(ve.html, /https:\/\/thepitlog\.com\/\?mode=verifyEmail&amp;oobCode=CODE-newbie/); assert.ok(!/firebaseapp/.test(ve.html), "branded link, not Firebase's page");
  assert.ok(!/stop all emails/.test(ve.html), "no notification-unsubscribe footer on account emails");
  const call = async (tok, body) => { let code = 200, out; const res = { status: c => { code = c; return res; }, json: j => { out = j; } };
    await F.account({ method: "POST", headers: { authorization: tok ? "Bearer " + tok : "" }, body }, res); return { code, out }; };
  assert.strictEqual((await call("", { action: "resend" })).code, 401);
  assert.deepStrictEqual((await call("tok-newbie", { action: "resend" })).out, { result: "wait" }, "resend is rate-limited");
  assert.strictEqual((await call("tok-newbie", { action: "welcome" })).code, 400, "no welcome before confirming");
  AUTH.newbie.emailVerified = true; emails.length = 0;
  assert.deepStrictEqual((await call("tok-newbie", { action: "welcome" })).out, { result: "sent" });
  assert.match(sentTo("newbie")[0].subject, /Welcome to the pit, Sam/); assert.match(sentTo("newbie")[0].html, /@samr/); assert.match(sentTo("newbie")[0].html, /Log your first show/);
  assert.deepStrictEqual((await call("tok-newbie", { action: "welcome" })).out, { result: "already" }, "welcome only once");
  assert.strictEqual(store.get("users/newbie").welcomed, true);
  assert.deepStrictEqual((await call("tok-newbie", { action: "resend" })).out, { verified: true });
  // Google sign-up: already confirmed, so the welcome goes out when the profile is created
  emails.length = 0; AUTH.gg = { email: "gg@example.com", emailVerified: true }; store.set("users/gg", { name: "Gee", handle: "gee" });
  await F.onUserCreated({ params: { uid: "gg" }, data: { data: () => store.get("users/gg") } });
  assert.strictEqual(sentTo("gg").length, 1); assert.match(sentTo("gg")[0].subject, /Welcome/);

  assert.ok(emails.every(e => e.reply_to === "support@thepitlog.com"), "replies go to support");
  assert.ok(emails.every(e => /support@thepitlog\.com/.test(e.html)), "every email names support");
  // 11. Per-person time zones: the hourly digest only goes to people for whom it's 6 PM locally
  for (const k of [...store.keys()]) if (/\/(inbox|shows)\//.test(k) || k.startsWith("mail/")) store.delete(k);
  store.set("users/east", { name: "East", handle: "east", settings: { tz: "America/New_York" } });
  store.set("users/west", { name: "West", handle: "west", settings: { tz: "America/Los_Angeles" } });
  for (const u of ["east", "west"]) store.set(`users/${u}/shows/s`, { date: "2030-01-02", lineup: ["Tz Band"], venue: "TLA" });
  const sixET = new Date("2030-01-01T23:00:00Z"); // 6 PM Eastern = 3 PM Pacific, Jan 1 2030 (show is tomorrow)
  emails.length = 0; await F.runDigest(sixET, { hourly: true });
  assert.ok(sentTo("east").length === 1 && !sentTo("west").length, "east coast at 6 PM, west coast not yet");
  emails.length = 0; await F.runDigest(new Date("2030-01-02T02:00:00Z"), { hourly: true }); // 6 PM Pacific
  assert.ok(sentTo("west").length === 1 && !sentTo("east").length);
  // 12. On-sale alert for an "interested" tour, sent once
  emails.length = 0;
  store.set("users/east", { name: "East", handle: "east", settings: { tz: "America/New_York" }, interested: [{ k: "h:sleeptoken", n: "Sleep Token", u: "https://tm.example/st", o: "2030-01-02T15:00:00Z" }] });
  store.delete("users/east/shows/s");
  await F.runDigest(sixET, { hourly: true });
  assert.match(sentTo("east")[0].subject, /Tickets on sale tomorrow: Sleep Token/); assert.match(sentTo("east")[0].html, /10 AM/);
  emails.length = 0; await F.runDigest(sixET, { hourly: true }); assert.ok(!sentTo("east").length, "only once");
  // 13. Comments land in the owner's digest
  store.set("users/east/shows/c1", { date: "2029-05-05", lineup: ["Comment Band"], venue: "TLA" });
  await F.onComment({ params: { key: "east__c1" }, data: { data: () => ({ uid: "west", text: "That pit was unreal" }) } });
  await F.onComment({ params: { key: "east__c1" }, data: { data: () => ({ uid: "east", text: "own comment" }) } });
  emails.length = 0; await F.runDigest(sixET, { hourly: true });
  assert.match(sentTo("east")[0].html, /New comments/); assert.match(sentTo("east")[0].html, /That pit was unreal/); assert.ok(!/own comment/.test(sentTo("east")[0].html));
  // 14. Reports go to support
  emails.length = 0;
  await F.onReport({ data: { data: () => ({ by: "east", target: "west", reason: "Spam", note: "keeps adding me" }) } });
  assert.strictEqual(emails[0].to[0], "support@thepitlog.com"); assert.match(emails[0].subject, /Report: @west/);
  // 15. Unconfirmed sign-ups are flagged for the database rules
  AUTH.unver = { email: "unver@example.com", emailVerified: false }; store.set("users/unver", { name: "U", handle: "unver" });
  await F.onUserCreated({ params: { uid: "unver" }, data: { data: () => store.get("users/unver") } });
  assert.strictEqual(store.get("mail/unver").needsVerify, true);
  // 16. Delete account wipes everything they own
  store.set("users/gone", { name: "Gone", handle: "gone" }); store.set("users/gone/shows/a", { date: "2025-01-01", lineup: ["X"] });
  store.set("users/gone/inbox/i", { type: "added", sent: false }); store.set("publicShows/gone_a", { ownerUid: "gone" }); store.set("handles/gone", { uid: "gone" });
  store.set("friendRequests/gone_east", { from: "gone", to: "east", status: "accepted" }); store.set("friendRequests/west_gone", { from: "west", to: "gone", status: "pending" });
  store.set("publicShows/east_x", { ownerUid: "east" });
  let code = 0, out; const res2 = { status: c => { code = c; return res2; }, json: j => { out = j; } };
  await F.account({ method: "POST", headers: { authorization: "Bearer tok-gone" }, body: { action: "delete" } }, res2); assert.strictEqual(code, 400, "must type DELETE");
  code = 200; await F.account({ method: "POST", headers: { authorization: "Bearer tok-gone" }, body: { action: "delete", confirm: "DELETE" } }, res2);
  assert.deepStrictEqual(out, { result: "deleted" });
  assert.ok(![...store.keys()].some(k => k.includes("gone")), "nothing left: " + [...store.keys()].filter(k => k.includes("gone")).join(","));
  assert.ok(store.has("publicShows/east_x"), "other people's data untouched");
  assert.deepStrictEqual(DELETED_PREFIX, ["users/gone/"]); assert.deepStrictEqual(DELETED_USERS, ["gone"]);
  // 17. Daily ops check emails support about errors / a stale catalog
  emails.length = 0; store.set("catalogMeta/months", { list: [], updated: L.todayET() });
  let ops = await F.runOps(); assert.strictEqual(emails.length, 0, "quiet day, no email"); assert.deepStrictEqual(ops, { errors: 0, stale: false });
  store.set("errors/e1", { msg: "TypeError: x is undefined", where: "app.js:10", build: "44", at: new Date() });
  store.set("errors/e2", { msg: "TypeError: x is undefined", where: "app.js:10", build: "44", at: new Date() });
  store.set("errors/old", { msg: "ancient", at: new Date(Date.now() - 10 * 864e5) });
  store.set("catalogMeta/months", { list: [], updated: "2020-01-01" });
  ops = await F.runOps(); assert.match(emails[0].subject, /2 errors, catalog stale/); assert.match(emails[0].html, /2× TypeError/); assert.ok(!store.has("errors/old"), "old errors cleaned up");
  // 18. setlist.fm mapping and grouping
  const SL = require("./setlists");
  const fakeSL = async url => ({ ok: true, status: 200, json: async () => url.includes("/attended") ? { itemsPerPage: 20, total: 3, setlist: [
      { id: "1", eventDate: "05-10-2025", artist: { name: "Gojira" }, venue: { name: "Xfinity Mobile Arena", city: { name: "Philadelphia", stateCode: "PA" } }, tour: { name: "Mega Monsters" }, sets: { set: [{ song: [{ name: "Stranded" }, { name: "Amazonia" }] }] } },
      { id: "2", eventDate: "05-10-2025", artist: { name: "Mastodon" }, venue: { name: "Xfinity Mobile Arena", city: { name: "Philadelphia", stateCode: "PA" } }, sets: { set: [{ song: [{ name: "Blood and Thunder" }] }] } },
      { id: "3", eventDate: "01-02-2024", artist: { name: "Insomnium" }, venue: { name: "Reverb", city: { name: "Reading", stateCode: "PA" } }, sets: { set: [] } } ] }
    : { setlist: [{ id: "9", eventDate: "05-10-2025", artist: { name: "Gojira" }, venue: { name: "X", city: { name: "Philadelphia", stateCode: "PA" } }, sets: { set: [{ song: [{ name: "Stranded" }, { name: "Intro", tape: true }] }] } }] } });
  const att = await SL.attended("k", "pitfan", fakeSL, async () => {});
  assert.strictEqual(att.shows.length, 2); assert.deepStrictEqual(att.shows[0].bands, ["Gojira", "Mastodon"]); assert.strictEqual(att.shows[0].tour, "Mega Monsters");
  assert.deepStrictEqual(att.shows[0].songs.Gojira, ["Stranded", "Amazonia"]); assert.strictEqual(att.shows[1].date, "2024-02-01");
  const one = await SL.findSetlist("k", "Gojira", "2025-10-05", fakeSL); assert.deepStrictEqual(one.setlist.songs, ["Stranded", "Intro (tape)"]);

  console.log("All email function tests passed.");
})().catch(e => { console.error(e); process.exit(1); });
