// Pit Log email alerts (Cloud Functions, 2nd gen).
//  - Instant: crew requests, accepted requests, Crew Family invites/approvals, tags.
//  - Queued for the digest: crew members adding shows, and "looks like you're going too" matches.
//  - Digest (daily 6 PM Eastern, or Sundays for weekly): queued crew activity plus your own
//    show reminders 7 days and 1 day out.
// Email addresses come from Firebase Auth and are never written to Firestore.
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");
const L = require("./lib");

initializeApp();
const DB_ID = "pit-log";
const db = getFirestore(DB_ID);
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
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
const KIND_PREF = { requests: "emailRequests", tags: "emailTags", digest: "emailDigest" };
async function send(uid, kind, { subject, title, intro, body, button }){
  const user = await userDoc(uid); if (!user) return false;
  const p = L.prefs(user);
  if (kind !== "digest" && p[KIND_PREF[kind]] === "off") return false;
  const to = await emailOf(uid); if (!to) return false;
  const token = await unsubToken(uid);
  const unsub = k => `${L.SITE}/u?u=${encodeURIComponent(uid)}&t=${encodeURIComponent(token)}&k=${k}`;
  const footer = `You're getting this because of your Pit Log notification settings. <a href="${L.SITE}" style="color:#a2958d">Change them in the app</a> (Profile → Settings → Notifications) or <a href="${unsub(kind)}" style="color:#a2958d">stop these emails</a> · <a href="${unsub("all")}" style="color:#a2958d">stop all emails</a>.`;
  const html = L.layout({ title, intro, body, button, footer });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY.value()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html,
      headers: { "List-Unsubscribe": `<${unsub(kind === "digest" ? "digest" : kind)}>` } })
  });
  if (!res.ok) { logger.error("resend failed", res.status, await res.text()); return false; }
  return true;
}
const handleOf = u => (u && u.handle) || "someone";
const nameOf = u => (u && (u.name || u.handle)) || "Someone";

/* ---------- crew requests and Crew Family ---------- */
exports.onCrewRequest = onDocumentCreated({ document: "friendRequests/{id}", database: DB_ID, secrets: [RESEND_API_KEY] }, async event => {
  const r = event.data && event.data.data(); if (!r || r.status !== "pending") return;
  const from = await userDoc(r.from);
  await send(r.to, "requests", {
    subject: `${nameOf(from)} wants to add you to their crew`,
    title: `@${handleOf(from)} wants you in their crew`,
    intro: `${L.esc(nameOf(from))} sent you a crew request on Pit Log. Crew can see each other's shows and the ones you hit together.`,
    button: { label: "Open Crew", url: L.SITE } });
});

exports.onCrewRequestChange = onDocumentUpdated({ document: "friendRequests/{id}", database: DB_ID, secrets: [RESEND_API_KEY] }, async event => {
  const b = event.data.before.data(), a = event.data.after.data();
  if (b.status === "pending" && a.status === "accepted") {
    const to = await userDoc(a.to);
    await send(a.from, "requests", { subject: `@${handleOf(to)} accepted your crew request`, title: `@${handleOf(to)} is in your crew`,
      intro: `${L.esc(nameOf(to))} accepted your request. Their shows now show up in your crew.`, button: { label: "See their shows", url: L.SITE } });
  }
  if (a.family === "pending" && b.family !== "pending" && a.familyBy) {
    const other = a.familyBy === a.from ? a.to : a.from, by = await userDoc(a.familyBy);
    await send(other, "requests", { subject: `@${handleOf(by)} invited you to Crew Family`, title: "Crew Family invite",
      intro: `@${L.esc(handleOf(by))} wants to link logs with you. If you approve, every show either of you adds lands in both logs. Ratings, notes, photos and spend stay your own.`,
      button: { label: "Review the invite", url: L.SITE } });
  }
  if (a.family === "active" && b.family === "pending" && a.familyBy) {
    const other = a.familyBy === a.from ? a.to : a.from, o = await userDoc(other);
    await send(a.familyBy, "requests", { subject: `@${handleOf(o)} approved Crew Family`, title: "Your logs are linked",
      intro: `@${L.esc(handleOf(o))} approved Crew Family. Shows either of you add will now land in both logs.`, button: { label: "Open Pit Log", url: L.SITE } });
  }
});

/* ---------- shows: tags (instant) and crew activity (queued for the digest) ---------- */
exports.onShowWrite = onDocumentWritten({ document: "users/{uid}/shows/{showId}", database: DB_ID, secrets: [RESEND_API_KEY] }, async event => {
  const { uid, showId } = event.params;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;
  const owner = await userDoc(uid); if (!owner) return;
  const today = L.todayET();
  const show = L.showSummary(after, showId);

  // Tags: email anyone newly tagged (if they allow tags from this person).
  const was = new Set((before && before.taggedUids) || []);
  for (const t of (after.taggedUids || [])) {
    if (t === uid || was.has(t)) continue;
    const rel = await relation(uid, t); if (!rel.friends) continue;
    const tagged = await userDoc(t); if (!L.canSee(L.prefs(tagged), "tagMe", rel.family)) continue;
    await send(t, "tags", { subject: `@${handleOf(owner)} tagged you at ${L.showLine(show)}`, title: `@${handleOf(owner)} tagged you`,
      intro: "Add it to your log with one tap from the Crew tab, as just the show or with their details.", body: L.showCard(show), button: { label: "Open Pit Log", url: L.SITE } });
  }

  // New shows only (not edits). Skip copies made by Crew Family syncing or by accepting a tag.
  if (before || after.addedBy || after.copiedFrom) return;
  const ownerSet = owner.settings || {};
  const batch = db.batch(); let n = 0;
  for (const f of await friendsOf(uid)) {
    if (f.family) continue; // linked logs already get the show itself
    if (L.isUpcoming(show.date, today) && !L.canSee(ownerSet, "upcoming", false)) continue;
    const theirs = await db.collection(`users/${f.uid}/shows`).where("date", "==", show.date).get();
    const match = theirs.docs.find(d => L.sameShow(after, d.data()));
    const inbox = db.collection(`users/${f.uid}/inbox`).doc();
    if (match) {
      batch.set(inbox, { type: "together", from: uid, fromHandle: handleOf(owner), show, sent: false, at: FieldValue.serverTimestamp() });
      // ...and tell the person who just added it, if the friend's settings let them see it.
      const friend = await userDoc(f.uid);
      if (!L.isUpcoming(show.date, today) || L.canSee((friend && friend.settings) || {}, "upcoming", false))
        batch.set(db.collection(`users/${uid}/inbox`).doc(), { type: "together", from: f.uid, fromHandle: handleOf(friend), show, sent: false, at: FieldValue.serverTimestamp() });
    } else {
      batch.set(inbox, { type: "added", from: uid, fromHandle: handleOf(owner), show, sent: false, at: FieldValue.serverTimestamp() });
    }
    n++;
  }
  if (n) await batch.commit();
});

/* ---------- digest + reminders ---------- */
async function runDigest(now = new Date()){
  const today = L.todayET(now), sunday = new Date(today + "T12:00:00Z").getUTCDay() === 0;
  const users = await db.collection("users").get();
  let sent = 0;
  for (const u of users.docs) {
    const p = L.prefs(u.data());
    const digestDue = p.emailDigest === "daily" || (p.emailDigest === "weekly" && sunday);
    const inbox = digestDue ? await db.collection(`users/${u.id}/inbox`).where("sent", "==", false).limit(200).get() : { docs: [] };
    const items = inbox.docs.map(d => d.data());
    const reminders = [];
    if (p.emailReminders !== "off") for (const days of [1, 7]) {
      const day = L.addDays(today, days);
      const s = await db.collection(`users/${u.id}/shows`).where("date", "==", day).get();
      for (const d of s.docs) reminders.push({ days, show: L.showSummary(d.data(), d.id) });
    }
    if (!items.length && !reminders.length) continue;
    const dg = L.buildDigest({ items, reminders, today });
    const ok = await send(u.id, "digest", { subject: dg.subject, title: items.length ? (p.emailDigest === "weekly" ? "Your crew this week" : "Your crew today") : "Show reminder",
      intro: L.esc(dg.summary), body: dg.body, button: { label: "Open Pit Log", url: L.SITE } });
    if (ok && inbox.docs.length) { const b = db.batch(); inbox.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
    if (ok) sent++;
    await new Promise(r => setTimeout(r, 600)); // stay under the email service's rate limit
  }
  logger.info(`digest sent to ${sent} people`);
}
exports.dailyDigest = onSchedule({ schedule: "0 18 * * *", timeZone: "America/New_York", secrets: [RESEND_API_KEY], timeoutSeconds: 540 }, () => runDigest());

/* ---------- one-tap unsubscribe (thepitlog.com/u redirects here) ---------- */
exports.unsubscribe = onRequest({ cors: false }, async (req, res) => {
  const { u, t, k } = req.query;
  const page = msg => res.status(200).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0e0b0c;color:#ece4d4;font-family:Arial,sans-serif;padding:32px"><h1 style="font-family:Georgia,serif;font-weight:normal">Pit Log</h1><p>${msg}</p><p><a style="color:#e0313a" href="${L.SITE}">Open Pit Log</a></p></body>`);
  if (!u || !t) return page("That link isn't complete.");
  const d = await db.doc(`mail/${u}`).get();
  if (!d.exists || d.data().token !== t) return page("That link has expired. Change your emails in the app under Profile → Settings → Notifications.");
  const keys = k === "all" ? ["emailRequests", "emailTags", "emailDigest", "emailReminders"] : [KIND_PREF[k] || "emailDigest"];
  const patch = {}; for (const key of keys) patch[`settings.${key}`] = "off";
  await db.doc(`users/${u}`).update(patch);
  page(k === "all" ? "Done. Pit Log won't email you anymore." : "Done. You won't get those emails anymore.");
});

module.exports.runDigest = runDigest; // used by the tests
