// Offline test: runs the real functions against an in-memory fake of Firestore/Auth and a fake email API.
const Module = require("module");
const assert = require("assert");
const store = new Map(); // path -> data
const emails = [];
let auto = 0;
const clone = v => JSON.parse(JSON.stringify(v));
function docRef(path){
  return { path, id: path.split("/").pop(),
    get: async () => ({ exists: store.has(path), id: path.split("/").pop(), ref: docRef(path), data: () => clone(store.get(path)) }),
    set: async (v, o) => { store.set(path, o && o.merge ? { ...(store.get(path) || {}), ...clean(v) } : clean(v)); },
    update: async v => { const cur = store.get(path) || {}; for (const [k, val] of Object.entries(v)) { if (k.includes(".")) { const [a, b] = k.split("."); cur[a] = { ...(cur[a] || {}), [b]: val }; } else cur[k] = val; } store.set(path, cur); },
    delete: async () => { store.delete(path); } };
}
const clean = v => JSON.parse(JSON.stringify(v, (k, x) => (x && x.__ts ? "ts" : x)));
function coll(path, filters = [], lim = 1e9){
  return { doc: id => docRef(`${path}/${id || "auto" + (++auto)}`),
    where: (f, op, v) => coll(path, [...filters, [f, op, v]], lim), limit: n => coll(path, filters, n),
    get: async () => ({ docs: [...store.keys()].filter(k => k.startsWith(path + "/") && k.split("/").length === path.split("/").length + 1)
      .filter(k => filters.every(([f, , v]) => (store.get(k) || {})[f] === v)).slice(0, lim).map(k => ({ id: k.split("/").pop(), ref: docRef(k), data: () => clone(store.get(k)) })) }) };
}
const fakeDb = { doc: docRef, collection: p => coll(p), batch: () => { const ops = []; return { set: (r, v) => ops.push(() => r.set(v)), delete: r => ops.push(() => r.delete()), commit: async () => { for (const o of ops) await o(); } }; } };
const fakes = {
  "firebase-functions/v2/firestore": { onDocumentCreated: (o, h) => h, onDocumentUpdated: (o, h) => h, onDocumentWritten: (o, h) => h },
  "firebase-functions/v2/scheduler": { onSchedule: (o, h) => h },
  "firebase-functions/v2/https": { onRequest: (o, h) => h },
  "firebase-functions/params": { defineSecret: () => ({ value: () => "test-key" }) },
  "firebase-functions/v2": { setGlobalOptions: () => {}, logger: { info: () => {}, error: (...a) => console.error(...a) } },
  "firebase-admin/app": { initializeApp: () => {} },
  "firebase-admin/auth": { getAuth: () => ({ getUser: async uid => ({ email: uid + "@example.com" }) }) },
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

  // 1. Crew request -> email to the person asked
  const req = { from: "pat", to: "stacie", status: "pending" };
  store.set("friendRequests/pat_stacie", req);
  await F.onCrewRequest({ data: { data: () => req } });
  assert.strictEqual(sentTo("stacie").length, 1); assert.match(sentTo("stacie")[0].subject, /Pat wants to add you/);
  // accepted -> email back to Pat
  const acc = { ...req, status: "accepted" }; store.set("friendRequests/pat_stacie", acc);
  await F.onCrewRequestChange({ data: { before: { data: () => req }, after: { data: () => acc } } });
  assert.match(sentTo("pat")[0].subject, /@stacie accepted/);
  store.set("friendRequests/pat_carly", { from: "pat", to: "carly", status: "accepted" });
  store.set("friendRequests/ken_pat", { from: "ken", to: "pat", status: "accepted" });

  // 2. Tags: Carly gets an email; Stacie turned tag emails off
  emails.length = 0;
  await write("users/pat/shows/s1", null, { date: soon, lineup: ["Insomnium", "Amorphis"], venue: "Reverb", city: "Reading, PA", taggedUids: ["carly", "stacie"], notes: "secret", ticketTotal: 90 });
  assert.strictEqual(sentTo("carly").length, 1); assert.match(sentTo("carly")[0].subject, /tagged you at Insomnium/);
  assert.strictEqual(sentTo("stacie").length, 0);
  assert.ok(!sentTo("carly")[0].html.includes("secret") && !sentTo("carly")[0].html.includes("90"), "no private details in emails");
  // editing the show again doesn't re-send tags or re-queue activity
  const before = store.get("users/pat/shows/s1");
  await write("users/pat/shows/s1", before, { ...before, rating: 4 });
  assert.strictEqual(sentTo("carly").length, 1);

  // 3. Activity queue: Carly and Stacie get "added", Ken (who has the same show) gets "together", and so does Pat
  const inbox = uid => [...store.keys()].filter(k => k.startsWith(`users/${uid}/inbox/`)).map(k => store.get(k));
  assert.deepStrictEqual(inbox("carly").map(i => i.type), ["added"]);
  assert.deepStrictEqual(inbox("stacie").map(i => i.type), ["added"]);
  assert.strictEqual(inbox("carly")[0].show.notes, undefined, "queued show has no notes");
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
  // running again sends nothing new to Carly except tomorrow's reminder
  emails.length = 0; await F.runDigest();
  assert.ok(!/added/.test((sentTo("carly")[0] || {}).html || ""));

  // 5. Unsubscribe link turns emails off
  const tok = store.get("mail/carly").token; let page = "";
  const res = { status: () => ({ send: h => { page = h; } }) };
  await F.unsubscribe({ query: { u: "carly", t: tok, k: "digest" } }, res);
  assert.strictEqual(store.get("users/carly").settings.emailDigest, "off"); assert.match(page, /won't get those/);
  await F.unsubscribe({ query: { u: "carly", t: "wrong", k: "all" } }, res); assert.match(page, /expired/);

  console.log("All email function tests passed.");
})().catch(e => { console.error(e); process.exit(1); });
