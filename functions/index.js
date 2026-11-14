// Pit Log email alerts (Cloud Functions, 2nd gen).
//  - Nothing is instant: crew requests, accepts, Crew Family invites/approvals and tags are queued too.
//  - Queued for the digest: crew members adding shows, and "looks like you're going too" matches.
//  - Digest (daily 6 PM Eastern, or Sundays for weekly): queued crew activity plus your own
//    show reminders (sent when a show is 7 days or 1 day out, listing every show in the next week).
// Email addresses come from Firebase Auth and are never written to Firestore.
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("crypto");
const L = require("./lib");
const C = require("./catalog");
const S = require("./setlists");
const A = require("./artists");

initializeApp();
const DB_ID = "pit-log";
const db = getFirestore(DB_ID);
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const TICKETMASTER_API_KEY = defineSecret("TICKETMASTER_API_KEY");
const SETLISTFM_API_KEY = defineSecret("SETLISTFM_API_KEY");
const SUPPORT = "support@thepitlog.com";
const BUCKET = "pit-log.firebasestorage.app";
const FROM = "Pit Log <alerts@thepitlog.com>";
setGlobalOptions({ region: "us-central1", maxInstances: 3 });

/* ---------- lookups ---------- */
async function userDoc(uid){ const d = await db.doc(`users/${uid}`).get(); return d.exists ? d.data() : null; }
async function emailOf(uid){ try { const u = await getAuth().getUser(uid); return u.email || null; } catch (_) { return null; } }
// Per-person random token for one-tap unsubscribe links (kept in a collection no app user can read).
async function unsubToken(uid){
  const ref = db.doc(`mail/${uid}`); const d = await ref.get();
  if (d.exists && d.data().token) return d.data().token;
  const token = crypto.randomBytes(18).toString("base64url");
  await ref.set({ token }, { merge: true });
  return token;
}
// Anti-spam: remember when someone was last emailed about a given thing (kept in mail/{uid},
// which no app user can read). Returns true if it's been long enough, and records "now" if so.
async function cooldownOk(uid, key, minutes){
  const ref = db.doc(`mail/${uid}`); const d = await ref.get();
  const last = (d.exists && d.data().last && d.data().last[key]) || 0, now = Date.now();
  if (now - last < minutes * 60000) return false;
  await ref.set({ last: { [key]: now } }, { merge: true });
  return true;
}
async function relation(a, b){
  const [x, y] = await Promise.all([db.doc(`friendRequests/${a}_${b}`).get(), db.doc(`friendRequests/${b}_${a}`).get()]);
  const r = [x, y].find(d => d.exists && d.data().status === "accepted");
  return r ? { friends: true, family: r.data().family === "active" } : { friends: false, family: false };
}
async function friendsOf(uid){
  const [a, b] = await Promise.all([
    db.collection("friendRequests").where("from", "==", uid).where("status", "==", "accepted").get(),
    db.collection("friendRequests").where("to", "==", uid).where("status", "==", "accepted").get()]);
  return [...a.docs, ...b.docs].map(d => { const r = d.data(); return { uid: r.from === uid ? r.to : r.from, family: r.family === "active" }; });
}

/* ---------- sending ---------- */
const KIND_PREF = { requests: "emailRequests", tags: "emailTags", digest: "emailDigest", weekly: "emailWeekly" };
async function send(uid, kind, { subject, title, intro, body, button }){
  const user = await userDoc(uid); if (!user) return false;
  const p = L.prefs(user);
  if (kind !== "digest" && p[KIND_PREF[kind]] === "off") return false;
  const to = await emailOf(uid); if (!to) return false;
  const token = await unsubToken(uid);
  const unsub = k => `${L.SITE}/u?u=${encodeURIComponent(uid)}&t=${encodeURIComponent(token)}&k=${k}`;
  const footer = `You're getting this because of your Pit Log notification settings. <a href="${L.SITE}" style="color:#a2958d">Change them in the app</a> (Profile → Settings → Notifications) or <a href="${unsub(kind)}" style="color:#a2958d">stop these emails</a> · <a href="${unsub("all")}" style="color:#a2958d">stop all emails</a>.<br>Questions? <a href="mailto:support@thepitlog.com" style="color:#a2958d">support@thepitlog.com</a>`;
  const html = L.layout({ title, intro, body, button, footer });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY.value()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: "support@thepitlog.com", subject, html,
      headers: { "List-Unsubscribe": `<${unsub(kind === "digest" ? "digest" : kind)}>` } })
  });
  if (!res.ok) { logger.error("resend failed", res.status, await res.text()); return false; }
  return true;
}
const handleOf = u => (u && u.handle) || "someone";
const nameOf = u => (u && (u.name || u.handle)) || "Someone";

/* ---------- crew requests and Crew Family ----------
   Nothing is emailed right away. Each event is queued and goes out in the next daily digest
   (6 PM Eastern), and only if something was actually queued. */
// kind: "requests" or "tags" (each can be turned off on its own); the digest itself can be off too.
async function queue(uid, kind, item){
  const u = await userDoc(uid); if (!u) return false;
  const p = L.prefs(u);
  if (p.emailDigest === "off" || p[KIND_PREF[kind]] === "off") return false;
  await db.collection(`users/${uid}/inbox`).add({ ...item, sent: false, at: FieldValue.serverTimestamp() });
  return true;
}
exports.onCrewRequest = onDocumentCreated({ document: "friendRequests/{id}", database: DB_ID }, async event => {
  const r = event.data && event.data.data(); if (!r || r.status !== "pending") return;
  if (!(await cooldownOk(r.to, `req_${r.from}`, 24 * 60))) return; // re-sent/cancelled requests only count once a day
  const from = await userDoc(r.from);
  await queue(r.to, "requests", { type: "request", from: r.from, fromHandle: handleOf(from), fromName: nameOf(from) });
});

exports.onCrewRequestChange = onDocumentUpdated({ document: "friendRequests/{id}", database: DB_ID }, async event => {
  const b = event.data.before.data(), a = event.data.after.data();
  if (b.status === "pending" && a.status === "accepted") {
    const to = await userDoc(a.to);
    await queue(a.from, "requests", { type: "accepted", from: a.to, fromHandle: handleOf(to), fromName: nameOf(to) });
  }
  if (a.family === "pending" && b.family !== "pending" && a.familyBy && await cooldownOk(a.familyBy === a.from ? a.to : a.from, `fam_${a.familyBy}`, 24 * 60)) {
    const other = a.familyBy === a.from ? a.to : a.from, by = await userDoc(a.familyBy);
    await queue(other, "requests", { type: "familyInvite", from: a.familyBy, fromHandle: handleOf(by), fromName: nameOf(by) });
  }
  if (a.family === "active" && b.family === "pending" && a.familyBy) {
    const other = a.familyBy === a.from ? a.to : a.from, o = await userDoc(other);
    await queue(a.familyBy, "requests", { type: "familyApproved", from: other, fromHandle: handleOf(o), fromName: nameOf(o) });
  }
});

/* ---------- shows: tags and crew activity (both queued for the daily digest) ---------- */
exports.onShowWrite = onDocumentWritten({ document: "users/{uid}/shows/{showId}", database: DB_ID }, async event => {
  const { uid, showId } = event.params;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;
  const owner = await userDoc(uid); if (!owner) return;
  const today = L.todayET();
  const show = L.showSummary(after, showId);

  // Tags: queue for anyone newly tagged (if they allow tags from this person).
  const was = new Set((before && before.taggedUids) || []);
  for (const t of (after.taggedUids || [])) {
    if (t === uid || was.has(t)) continue;
    const rel = await relation(uid, t); if (!rel.friends) continue;
    const tagged = await userDoc(t); if (!L.canSee(L.prefs(tagged), "tagMe", rel.family)) continue;
    await queue(t, "tags", { type: "tagged", from: uid, fromHandle: handleOf(owner), show });
  }

  // New shows only (not edits). Skip copies made by Crew Family syncing or by accepting a tag.
  if (before || after.addedBy || after.copiedFrom) return;
  const ownerSet = owner.settings || {};
  const batch = db.batch(); let n = 0;
  for (const f of await friendsOf(uid)) {
    if (f.family) continue; // linked logs already get the show itself
    const fUser = await userDoc(f.uid);
    if (L.prefs(fUser).emailDigest === "off") continue; // nothing piles up for people who turned the digest off
    if (L.isUpcoming(show.date, today) && !L.canSee(ownerSet, "upcoming", false)) continue;
    const theirs = await db.collection(`users/${f.uid}/shows`).where("date", "==", show.date).get();
    const match = theirs.docs.find(d => L.sameShow(after, d.data()));
    const inbox = db.collection(`users/${f.uid}/inbox`).doc();
    if (match) {
      batch.set(inbox, { type: "together", from: uid, fromHandle: handleOf(owner), show, sent: false, at: FieldValue.serverTimestamp() });
      // ...and tell the person who just added it, if the friend's settings let them see it.
      const friend = fUser;
      if (L.prefs(owner).emailDigest !== "off" && (!L.isUpcoming(show.date, today) || L.canSee((friend && friend.settings) || {}, "upcoming", false)))
        batch.set(db.collection(`users/${uid}/inbox`).doc(), { type: "together", from: f.uid, fromHandle: handleOf(friend), show, sent: false, at: FieldValue.serverTimestamp() });
    } else {
      batch.set(inbox, { type: "added", from: uid, fromHandle: handleOf(owner), show, sent: false, at: FieldValue.serverTimestamp() });
    }
    n++;
  }
  if (n) await batch.commit();
});

/* ---------- digest + reminders ---------- */
// hourly: run every hour and only handle people for whom it's 6 PM locally (their Settings time zone).
async function runDigest(now = new Date(), { hourly = false } = {}){
  const users = await db.collection("users").get();
  let sent = 0;
  for (const u of users.docs) {
    const lp = L.localParts((u.data().settings || {}).tz, now);
    if (hourly && lp.hour !== 18) continue;
    const today = lp.date, sunday = lp.dow === 0;
    const p = L.prefs(u.data());
    const digestDue = p.emailDigest === "daily" || (p.emailDigest === "weekly" && sunday);
    if (p.emailDigest === "off") { // turned off: throw away anything queued so it can't arrive later as a backlog
      const old = await db.collection(`users/${u.id}/inbox`).limit(400).get();
      if (old.docs.length) { const b = db.batch(); old.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
    }
    const inbox = digestDue ? await db.collection(`users/${u.id}/inbox`).where("sent", "==", false).limit(200).get() : { docs: [] };
    // Skip shows that were deleted since, and anything listed twice.
    const items = [], seen = new Set();
    for (const d of inbox.docs) {
      const it = d.data(), key = `${it.type}|${it.from}|${it.show && it.show.id}`;
      if (seen.has(key)) continue; seen.add(key);
      if (it.show && it.show.id && !(await db.doc(`users/${it.owner || it.from}/shows/${it.show.id}`).get()).exists) continue;
      items.push(it);
    }
    const reminders = [];
    const md = await db.doc(`mail/${u.id}`).get(), recapToday = md.exists && (md.data() || {}).recapDay === today;
    // Reminders go out when a show is 7 days or 1 day away; that email then lists EVERY show
    // logged for the next 7 days, so nothing in the week is missed (and no daily repeats).
    if (p.emailReminders !== "off" && !recapToday) {
      const s = await db.collection(`users/${u.id}/shows`).where("date", ">=", L.addDays(today, 1)).where("date", "<=", L.addDays(today, 7)).get();
      const week = s.docs.map(d => ({ days: L.daysBetween(today, d.data().date), show: L.showSummary(d.data(), d.id) })).sort((a, b) => a.days - b.days || a.show.date.localeCompare(b.show.date));
      if (week.some(r => r.days === 1 || r.days === 7)) reminders.push(...week);
    }
    // "Interested" tours going on sale today or tomorrow (once each).
    const onsale = [], md0 = md.exists ? (md.data() || {}) : {}, saleSent = md0.saleSent || {};
    for (const it of (Array.isArray(u.data().interested) ? u.data().interested : [])) {
      if (!it || !it.o || saleSent[it.k]) continue;
      const od = L.localParts((u.data().settings || {}).tz, new Date(it.o));
      const when = od.date === today ? "today" : od.date === L.addDays(today, 1) ? "tomorrow" : "";
      if (!when || Date.parse(it.o) < now.getTime()) continue;
      onsale.push({ k: it.k, name: it.n, url: it.u || "", when, time: `${(od.hour % 12) || 12}${od.hour < 12 ? " AM" : " PM"}` });
    }
    if (!items.length && !reminders.length && !onsale.length) { // nothing new: no email, just tidy the queue
      if (inbox.docs.length) { const b = db.batch(); inbox.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
      continue;
    }
    const dg = L.buildDigest({ items, reminders, today, onsale });
    const ok = await send(u.id, "digest", { subject: dg.subject, title: items.length ? (p.emailDigest === "weekly" ? "Your crew this week" : "Your crew today") : "Show reminder",
      intro: L.esc(dg.summary), body: dg.body, button: { label: "Open Pit Log", url: L.SITE } });
    if (ok && inbox.docs.length) { const b = db.batch(); inbox.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
    if (ok && onsale.length) await db.doc(`mail/${u.id}`).set({ saleSent: Object.fromEntries(onsale.map(o => [o.k, today])) }, { merge: true });
    if (ok) sent++;
    await new Promise(r => setTimeout(r, 600)); // stay under the email service's rate limit
  }
  logger.info(`digest sent to ${sent} people`);
}
/* ---------- weekly recap (Sunday 10 AM Eastern) ---------- */
async function runRecap(now = new Date(), { hourly = false } = {}){
  const users = await db.collection("users").get();
  let sent = 0, recent = null;
  for (const u of users.docs) {
    const lp = L.localParts((u.data().settings || {}).tz, now);
    if (hourly && !(lp.dow === 0 && lp.hour === 10)) continue; // Sunday 10 AM their time
    const today = lp.date, horizon = L.addDays(today, 90), crewHorizon = L.addDays(today, 60), weekAgo = L.addDays(today, -7);
    if (!recent) { const recentDoc = await db.doc("catalogMeta/recent").get(); recent = []; try { recent = JSON.parse((recentDoc.exists && recentDoc.data().data) || "[]"); } catch (_) {} }
    const p = L.prefs(u.data()); if (p.emailWeekly === "off") continue;
    const uid = u.id;
    // open requests: crew requests to me + Crew Family invites from someone else
    const [reqs, famA, famB] = await Promise.all([
      db.collection("friendRequests").where("to", "==", uid).where("status", "==", "pending").get(),
      db.collection("friendRequests").where("from", "==", uid).where("family", "==", "pending").get(),
      db.collection("friendRequests").where("to", "==", uid).where("family", "==", "pending").get()]);
    const requests = reqs.docs.length + [...famA.docs, ...famB.docs].filter(d => d.data().familyBy && d.data().familyBy !== uid).length;
    const allMine = (await db.collection(`users/${uid}/shows`).get()).docs.map(d => ({ id: d.id, ...d.data() }));
    const mine = allMine.filter(s => s.date && s.date >= today && s.date <= horizon).sort((a, b) => a.date.localeCompare(b.date));
    // Just announced (this week) for bands this person has logged, minus shows they already have.
    // ...and for bands on their bucket list (bands they want to see), which come first.
    const myBands = new Set(allMine.flatMap(s => L.lineup(s)).map(C.normBand).filter(Boolean));
    // Tours they already have a date for: skip every other date of that tour.
    const tourKey = (lu, co) => { const k = lu.map(C.normBand); return co && k[1] ? "c:" + [k[0], k[1]].sort().join("+") : "h:" + (k[0] || ""); };
    const myTours = new Set();
    for (const s of allMine) if (s.date >= today && L.lineup(s).length) { const lu = L.lineup(s); myTours.add(tourKey(lu, s.coHead)); myTours.add("h:" + C.normBand(lu[0])); if (s.tour && C.normBand(s.tour).length >= 4) myTours.add("t:" + C.normBand(s.tour)); }
    const onMyTour = (lu, co, tour) => myTours.has(tourKey(lu, co)) || myTours.has("h:" + C.normBand(lu[0] || "")) || (!!tour && myTours.has("t:" + C.normBand(tour)));
    const bucket = new Set((Array.isArray(u.data().bucket) ? u.data().bucket : []).map(C.normBand).filter(Boolean));
    const announced = recent.filter(r => r.f >= weekAgo && r.d >= today && r.l.some(b => myBands.has(C.normBand(b)) || bucket.has(C.normBand(b))))
      .filter(r => !allMine.some(s => L.sameShow(s, { date: r.d, lineup: r.l, venue: r.v })) && !onMyTour(r.l, !!r.c, r.t))
      .map(r => ({ r, bk: r.l.some(b => bucket.has(C.normBand(b))) })).sort((a, b) => (b.bk - a.bk) || a.r.d.localeCompare(b.r.d))
      .slice(0, 8).map(({ r, bk }) => ({ ...L.showSummary({ date: r.d, lineup: r.l, coHead: !!r.c, venue: r.v, city: r.y }), url: r.u, note: bk ? "On your bucket list" : "" }));
    // Bucket list bands with dates already on sale (announced before this week, or before the catalog started).
    const onSale = [];
    if (bucket.size) {
      const keys = [...bucket];
      for (let i = 0; i < keys.length; i += 30) {
        const snap = await db.collection("catalog").where("bandKeys", "array-contains-any", keys.slice(i, i + 30)).limit(200).get();
        for (const d of snap.docs) { const c = d.data(); if (c.date >= today && c.date <= L.addDays(today, 180) && c.status !== "cancelled") onSale.push(c); }
      }
    }
    const shownNow = new Set(announced.map(a => a.date + "|" + a.venue));
    const bucketOnSale = onSale.filter(c => !shownNow.has(c.date + "|" + c.venue) && !allMine.some(s => L.sameShow(s, c)) && !onMyTour(L.lineup(c), c.coHead, c.tour))
      .sort((a, b) => a.date.localeCompare(b.date)).filter((c, i, arr) => arr.findIndex(x => x.date === c.date && x.venue === c.venue) === i)
      .slice(0, 6).map(c => ({ ...L.showSummary(c), url: c.url || "" }));
    const upcoming = mine.map(s => ({ raw: s, show: L.showSummary(s, s.id), crew: [] }));
    const crewUpcoming = [];
    for (const f of await friendsOf(uid)) {
      const fu = await userDoc(f.uid); if (!fu) continue;
      if (!L.canSee(fu.settings || {}, "upcoming", f.family)) continue; // they keep upcoming shows private from you
      const theirs = (await db.collection(`users/${f.uid}/shows`).get()).docs.map(d => d.data()).filter(s => s.date && s.date >= today && s.date <= crewHorizon);
      const other = [];
      for (const s of theirs) {
        const m = upcoming.find(x => L.sameShow(x.raw, s));
        if (m) { if (!m.crew.includes(handleOf(fu))) m.crew.push(handleOf(fu)); } else if (!f.family) other.push(L.showSummary(s));
      }
      if (other.length) crewUpcoming.push({ handle: handleOf(fu), shows: other.sort((a, b) => a.date.localeCompare(b.date)) });
    }
    const inbox = p.emailDigest === "off" ? { docs: [] } : await db.collection(`users/${uid}/inbox`).where("sent", "==", false).limit(200).get();
    const items = [];
    for (const d of inbox.docs) { const it = d.data(); if (it.show && it.show.id && !(await db.doc(`users/${it.owner || it.from}/shows/${it.show.id}`).get()).exists) continue; items.push(it); }
    const rc = L.buildRecap({ requests, upcoming, crewUpcoming, items, announced, bucketOnSale, today });
    if (rc.empty) continue; // nothing at all to say: no email
    const ok = await send(uid, "weekly", { subject: rc.subject, title: "Your week on Pit Log", intro: L.esc(rc.summary), body: rc.body, button: { label: "Open Pit Log", url: L.SITE } });
    if (ok) {
      sent++;
      if (inbox.docs.length) { const b = db.batch(); inbox.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
      await db.doc(`mail/${uid}`).set({ recapDay: today }, { merge: true }); // tonight's digest won't repeat today's reminders
    }
    await new Promise(r => setTimeout(r, 600));
  }
  logger.info(`weekly recap sent to ${sent} people`);
}
/* ---------- show catalog (daily, from Ticketmaster) ---------- */
async function runCatalog({ apiKey, now = new Date(), fetchImpl, pause } = {}){
  const key = apiKey !== undefined ? apiKey : TICKETMASTER_API_KEY.value();
  if (!key || key === "none") { logger.info("show catalog: no Ticketmaster key yet, skipping"); return { skipped: true }; }
  const today = L.todayET(now);
  const [idxDoc, recDoc] = await Promise.all([db.doc("catalogMeta/index").get(), db.doc("catalogMeta/recent").get()]);
  let index = {}, recent = [];
  try { index = JSON.parse((idxDoc.exists && idxDoc.data().data) || "{}"); } catch (_) {}
  try { recent = JSON.parse((recDoc.exists && recDoc.data().data) || "[]"); } catch (_) {}
  const { shows, calls } = await C.fetchAll({ apiKey: key, today, fetchImpl, pause, log: m => logger.warn(m) });
  // If Ticketmaster hiccups and returns nothing, don't treat that as "every show was cancelled".
  if (!shows.length && Object.keys(index).length) { logger.error(`show catalog: 0 shows from ${calls} calls; leaving the catalog alone`); return { aborted: true }; }
  const p = C.plan({ shows, index, recent, today });
  const ops = [...p.writes.map(w => ({ ref: db.doc(`catalog/${w.id}`), data: (({ isNew, isAdd, key: _k, ...rest }) => ({ ...rest, updatedAt: today }))(w) })),
               ...p.deletes.map(id => ({ ref: db.doc(`catalog/${id}`), del: true }))];
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch();
    for (const o of ops.slice(i, i + 400)) o.del ? b.delete(o.ref) : b.set(o.ref, o.data);
    await b.commit();
  }
  await db.doc("catalogMeta/index").set({ data: JSON.stringify(p.nextIndex), count: Object.keys(p.nextIndex).length, updated: today });
  // Discover page: one doc per month of upcoming shows, plus the list of months.
  const shards = C.monthShards(shows, p.nextIndex, today), months = Object.keys(shards).sort();
  const oldMonths = await db.doc("catalogMeta/months").get();
  const prev = (oldMonths.exists && oldMonths.data().list || []).map(x => x.m);
  const mb = db.batch();
  for (const m of months) mb.set(db.doc(`catalogMonths/${m}`), { data: JSON.stringify(shards[m]), count: shards[m].length, updated: today });
  for (const m of prev) if (!shards[m]) mb.delete(db.doc(`catalogMonths/${m}`));
  mb.set(db.doc("catalogMeta/months"), { list: months.map(m => ({ m, n: shards[m].length })), updated: today });
  await mb.commit();
  await db.doc("catalogMeta/recent").set({ data: JSON.stringify(p.nextRecent), count: p.nextRecent.length, updated: today });
  logger.info(`show catalog: ${shows.length} listings from ${calls} calls; ${p.added} added${p.backfill ? " (first load, not counted as announcements)" : ""}, ${p.writes.length - p.added} updated, ${p.deletes.length} removed`);
  return { added: p.added, announced: p.announced, updated: p.writes.length - p.added, removed: p.deletes.length, total: Object.keys(p.nextIndex).length };
}
exports.refreshCatalog = onSchedule({ schedule: "17 5 * * *", timeZone: "America/New_York", secrets: [TICKETMASTER_API_KEY], timeoutSeconds: 540, memory: "512MiB" }, () => runCatalog());
module.exports.runCatalog = runCatalog;

exports.weeklyRecap = onSchedule({ schedule: "2 * * * *", timeZone: "UTC", secrets: [RESEND_API_KEY], timeoutSeconds: 540 }, () => runRecap(new Date(), { hourly: true }));
module.exports.runRecap = runRecap;

exports.dailyDigest = onSchedule({ schedule: "5 * * * *", timeZone: "UTC", secrets: [RESEND_API_KEY], timeoutSeconds: 540 }, () => runDigest(new Date(), { hourly: true }));

/* ---------- one-tap unsubscribe (thepitlog.com/u redirects here) ---------- */
/* ---------- account emails: confirm your email + welcome ----------
   Transactional, so notification settings don't apply. Sent once each (resends are rate-limited). */
async function sendAccount(uid, to, { subject, title, intro, body, button }){
  const footer = `You're getting this because this email address was used to sign up for Pit Log. If that wasn't you, you can ignore it.<br>Questions? Just reply, or email <a href="mailto:support@thepitlog.com" style="color:#a2958d">support@thepitlog.com</a>`;
  const html = L.layout({ title, intro, body, button, footer });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY.value()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: "support@thepitlog.com", subject, html }) });
  if (!res.ok) { logger.error("resend failed", res.status, await res.text()); return false; }
  return true;
}
// Our own link (thepitlog.com/?mode=verifyEmail&oobCode=…) so confirming happens on Pit Log's page,
// not Firebase's plain one. The app applies the code itself.
async function verifyLink(email){
  const link = await getAuth().generateEmailVerificationLink(email, { url: `${L.SITE}/?verified=1` });
  const code = new URL(link).searchParams.get("oobCode");
  return `${L.SITE}/?mode=verifyEmail&oobCode=${encodeURIComponent(code)}`;
}
async function sendVerify(uid, au, profile){
  if (!(await cooldownOk(uid, "verify", 3))) return "wait";
  const link = await verifyLink(au.email);
  const name = (profile && profile.name || au.displayName || "").split(" ")[0];
  return (await sendAccount(uid, au.email, L.verifyEmail({ name, link }))) ? "sent" : "failed";
}
async function sendWelcome(uid, au, profile){
  const ref = db.doc(`mail/${uid}`), m = await ref.get();
  if (m.exists && m.data().welcomedAt) return "already";
  await ref.set({ welcomedAt: FieldValue.serverTimestamp() }, { merge: true }); // claim first, so two calls can't both send
  const ok = await sendAccount(uid, au.email, L.welcomeEmail({ name: (profile && profile.name || au.displayName || "").split(" ")[0], handle: profile && profile.handle }));
  if (ok) await db.doc(`users/${uid}`).set({ welcomed: true }, { merge: true });
  else await ref.set({ welcomedAt: null }, { merge: true });
  return ok ? "sent" : "failed";
}
// New profile (right after someone claims their username): Google accounts are already confirmed and get
// the welcome; email-and-password accounts get the "confirm your email" message first.
exports.onUserCreated = onDocumentCreated({ document: "users/{uid}", database: DB_ID, secrets: [RESEND_API_KEY] }, async event => {
  const uid = event.params.uid, profile = event.data && event.data.data();
  let au; try { au = await getAuth().getUser(uid); } catch (_) { return; }
  if (!au.email) return;
  if (au.emailVerified) await sendWelcome(uid, au, profile);
  else { await db.doc(`mail/${uid}`).set({ needsVerify: true }, { merge: true }); await sendVerify(uid, au, profile); }
});
// Called by the app (signed in): { action: "resend" } re-sends the confirm link; { action: "welcome" }
// sends the welcome once the email is confirmed.
// Spotify artist page per band, cached in artistLinks/{key} (re-checked after 30 days, misses after 7).
async function artistLinks(bands, opts){
  const out = {};
  for (const b of bands) {
    const key = A.norm(b); if (!key) continue;
    const ref = db.doc(`artistLinks/${key}`), c = await ref.get();
    const age = c.exists ? Date.now() - (c.data().at || 0) : Infinity;
    if (c.exists && age < (c.data().spotify ? 30 : 7) * 864e5) { out[b] = c.data().spotify || ""; continue; }
    try { const r = await A.lookup(b, opts); out[b] = r.spotify; await ref.set({ name: b, spotify: r.spotify, mbid: r.mbid, at: Date.now() }); }
    catch (e) { logger.warn("artist lookup", b, e.message); out[b] = ""; }
  }
  return out;
}
module.exports.artistLinks = artistLinks;
// Deletes everything a person owns: their shows, photos, public copies, username, crew links and login.
async function deleteAccount(uid){
  const wipe = async q => { for (;;) { const snap = await q.limit(400).get(); if (!snap.docs.length) return; const b = db.batch(); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); if (snap.docs.length < 400) return; } };
  await wipe(db.collection(`users/${uid}/shows`));
  await wipe(db.collection(`users/${uid}/inbox`));
  await wipe(db.collection("publicShows").where("ownerUid", "==", uid));
  await wipe(db.collection("handles").where("uid", "==", uid));
  await wipe(db.collection("friendRequests").where("from", "==", uid));
  await wipe(db.collection("friendRequests").where("to", "==", uid));
  try { await getStorage().bucket(BUCKET).deleteFiles({ prefix: `users/${uid}/` }); } catch (e) { logger.warn("storage cleanup", e.message); }
  await db.doc(`mail/${uid}`).delete().catch(() => {});
  await db.doc(`users/${uid}`).delete();
  await getAuth().deleteUser(uid).catch(e => logger.warn("auth delete", e.message));
  logger.info(`deleted account ${uid}`);
}
exports.account = onRequest({ cors: [/thepitlog\.com$/, /localhost/, /pr777x\.github\.io$/], secrets: [RESEND_API_KEY, SETLISTFM_API_KEY], timeoutSeconds: 120 }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const m = String(req.headers.authorization || "").match(/^Bearer (.+)$/); if (!m) return res.status(401).json({ error: "sign in first" });
  let tok; try { tok = await getAuth().verifyIdToken(m[1]); } catch (_) { return res.status(401).json({ error: "sign in again" }); }
  const uid = tok.uid, au = await getAuth().getUser(uid), profile = await userDoc(uid);
  const action = (req.body && req.body.action) || "";
  if (!au.email) return res.status(400).json({ error: "no email on this account" });
  if (action === "resend") {
    if (au.emailVerified) return res.json({ verified: true });
    const r = await sendVerify(uid, au, profile);
    return res.status(r === "failed" ? 502 : 200).json({ result: r });
  }
  if (action === "delete") {
    if ((req.body && req.body.confirm) !== "DELETE") return res.status(400).json({ error: "type DELETE to confirm" });
    await deleteAccount(uid);
    return res.json({ result: "deleted" });
  }
  if (action === "artistLinks") {
    const bands = (Array.isArray(req.body && req.body.bands) ? req.body.bands : []).map(String).filter(Boolean).slice(0, 8);
    return res.json({ links: await artistLinks(bands) });
  }
  if (action === "setlist" || action === "setlistImport") {
    const key = SETLISTFM_API_KEY.value();
    if (!key || key === "none") return res.status(503).json({ error: "setlist.fm isn't connected yet" });
    try {
      if (action === "setlist") return res.json(await S.findSetlist(key, String(req.body.artist || ""), String(req.body.date || "")));
      return res.json(await S.attended(key, String(req.body.username || "")));
    } catch (e) { logger.warn("setlist.fm", e.message); return res.status(e.status || 502).json({ error: e.message }); }
  }
  if (action === "welcome") {
    if (!au.emailVerified) return res.status(400).json({ error: "confirm your email first" });
    return res.json({ result: await sendWelcome(uid, au, profile) });
  }
  return res.status(400).json({ error: "unknown action" });
});

/* ---------- reports, comments, ops ---------- */
async function mailSupport(subject, html){
  const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY.value()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [SUPPORT], subject, html }) });
  if (!res.ok) logger.error("support mail failed", res.status, await res.text());
  return res.ok;
}
exports.onReport = onDocumentCreated({ document: "reports/{id}", database: DB_ID, secrets: [RESEND_API_KEY] }, async event => {
  const r = event.data && event.data.data(); if (!r) return;
  const by = await userDoc(r.by), target = await userDoc(r.target);
  await mailSupport(`Report: @${handleOf(target)} (${r.reason || "no reason"})`,
    `<p><b>@${L.esc(handleOf(by))}</b> (${L.esc(r.by)}) reported <b>@${L.esc(handleOf(target))}</b> (${L.esc(r.target)}).</p><p>Reason: ${L.esc(r.reason || "")}</p><p>${L.esc(r.note || "")}</p>`);
});
exports.onComment = onDocumentCreated({ document: "showComments/{key}/c/{id}", database: DB_ID }, async event => {
  const c = event.data && event.data.data(); if (!c) return;
  const [owner, showId] = String(event.params.key).split("__");
  if (!owner || !showId || c.uid === owner) return;
  const show = await db.doc(`users/${owner}/shows/${showId}`).get(); if (!show.exists) return;
  const ou = await userDoc(owner); if (!ou || L.prefs(ou).emailDigest === "off") return;
  const by = await userDoc(c.uid);
  await db.collection(`users/${owner}/inbox`).add({ type: "comment", from: c.uid, owner, fromHandle: handleOf(by), show: L.showSummary(show.data(), showId), text: String(c.text || "").slice(0, 300), sent: false, at: FieldValue.serverTimestamp() });
});
// Every morning: email support if the app logged errors, or if the Discover catalog didn't refresh.
async function runOps(now = new Date()){
  const since = new Date(now.getTime() - 864e5);
  const errs = (await db.collection("errors").where("at", ">=", since).limit(300).get()).docs.map(d => d.data());
  const months = await db.doc("catalogMeta/months").get(), today = L.todayET(now);
  const stale = !months.exists || months.data().updated !== today;
  const problems = [];
  if (stale) problems.push(`<p><b>Discover catalog didn't refresh today</b> (last update: ${L.esc(months.exists ? months.data().updated : "never")}). Check the refreshCatalog job and the Ticketmaster key.</p>`);
  if (errs.length) {
    const groups = new Map(); for (const e of errs) { const k = String(e.msg || "").slice(0, 160); const g = groups.get(k) || { n: 0, e }; g.n++; groups.set(k, g); }
    problems.push(`<p><b>${errs.length} app error${errs.length > 1 ? "s" : ""} in the last day</b></p><ul>` + [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 15)
      .map(g => `<li>${g.n}× ${L.esc(g.e.msg)}<br><span style="color:#888;font-size:12px">${L.esc(g.e.where || "")} · build ${L.esc(g.e.build || "?")} · ${L.esc(g.e.ua || "")}</span></li>`).join("") + "</ul>");
  }
  const old = await db.collection("errors").where("at", "<", new Date(now.getTime() - 7 * 864e5)).limit(400).get();
  if (old.docs.length) { const b = db.batch(); old.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
  if (problems.length) await mailSupport(`Pit Log daily check: ${errs.length} error${errs.length === 1 ? "" : "s"}${stale ? ", catalog stale" : ""}`, problems.join(""));
  return { errors: errs.length, stale };
}
exports.opsReport = onSchedule({ schedule: "37 7 * * *", timeZone: "America/New_York", secrets: [RESEND_API_KEY] }, () => runOps());
module.exports.runOps = runOps;
module.exports.deleteAccount = deleteAccount;

exports.unsubscribe = onRequest({ cors: false }, async (req, res) => {
  const { u, t, k } = req.query;
  const page = msg => res.status(200).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0e0b0c;color:#ece4d4;font-family:Arial,sans-serif;padding:32px"><h1 style="font-family:Georgia,serif;font-weight:normal">Pit Log</h1><p>${msg}</p><p><a style="color:#e0313a" href="${L.SITE}">Open Pit Log</a></p><p style="color:#a2958d;font-size:14px">Questions? <a style="color:#a2958d" href="mailto:support@thepitlog.com">support@thepitlog.com</a></p></body>`);
  if (!u || !t) return page("That link isn't complete.");
  const d = await db.doc(`mail/${u}`).get();
  if (!d.exists || d.data().token !== t) return page("That link has expired. Change your emails in the app under Profile → Settings → Notifications.");
  const keys = k === "all" ? ["emailRequests", "emailTags", "emailDigest", "emailReminders", "emailWeekly"] : [KIND_PREF[k] || "emailDigest"];
  const patch = {}; for (const key of keys) patch[`settings.${key}`] = "off";
  await db.doc(`users/${u}`).update(patch);
  page(k === "all" ? "Done. Pit Log won't email you anymore." : "Done. You won't get those emails anymore.");
});

module.exports.runDigest = runDigest; // used by the tests
