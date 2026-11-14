// Pure helpers shared by the email functions (no Firebase calls here, so they can be tested alone).
const SITE = "https://thepitlog.com";

const LV = { private: 0, family: 1, crew: 2, public: 3 };
// Same rule as the app: Crew Family sees "family" and up, the rest of the crew sees "crew" and up.
const canSee = (settings, key, isFamily) => LV[(settings || {})[key] || "public"] >= (isFamily ? LV.family : LV.crew);

// Email preferences live on users/{uid}.settings next to the privacy settings.
const EMAIL_DEFAULTS = { emailRequests: "on", emailTags: "on", emailDigest: "daily", emailReminders: "on", emailWeekly: "on" };
const prefs = user => ({ ...EMAIL_DEFAULTS, ...((user && user.settings) || {}) });

const lineup = s => (Array.isArray(s && s.lineup) ? s.lineup.filter(Boolean) : []);
const ieq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
function sameShow(a, b){
  if (!a.date || a.date !== b.date) return false;
  if (a.venue && b.venue && ieq(a.venue, b.venue)) return true;
  return lineup(a).some(x => lineup(b).some(y => ieq(x, y)));
}

// Dates are stored as YYYY-MM-DD; "today" is in Eastern time, where everyone using the app is.
// Each person's local date/hour (from Settings; Eastern if unknown or invalid).
function localParts(tz, now = new Date()){
  let zone = "America/New_York"; try { if (tz) { new Intl.DateTimeFormat("en-US", { timeZone: tz }); zone = tz; } } catch (_) {}
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const g = t => (p.find(x => x.type === t) || {}).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")), dow: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(g("weekday")), zone };
}
function todayET(now = new Date()){
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = t => p.find(x => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
function addDays(iso, n){ const [y, m, d] = iso.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return dt.toISOString().slice(0, 10); }
const isUpcoming = (iso, today) => !!iso && iso >= today;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function prettyDate(iso){
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}
// A trimmed copy of a show for the email queue (never costs, notes or photos).
const showSummary = (s, id) => ({ id: id || s.id || "", date: s.date || "", lineup: lineup(s).slice(0, 4), coHead: !!s.coHead, venue: s.venue || "", city: s.city || "" });
const showLine = s => { const lu = lineup(s), co = !!s.coHead && lu.length > 1, sup = lu.slice(co ? 2 : 1, co ? 4 : 3);
  return `${co ? lu[0] + " & " + lu[1] : lu[0] || "A show"}${sup.length ? " w/ " + sup.join(", ") : ""}`; };
const placeLine = s => [prettyDate(s.date), [s.venue, s.city].filter(Boolean).join(", ")].filter(Boolean).join(" · ");

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// One email layout for everything: dark, plain, works in Gmail and Apple Mail.
function layout({ title, intro, body = "", button, footer }){
  // The dark colors live on table bgcolor/background (not just <body>, which Gmail and Outlook strip),
  // and color-scheme tells Apple Mail / Outlook / Gmail this email is already dark, so don't recolor it.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<style>:root{color-scheme:dark;supported-color-schemes:dark}body{margin:0;padding:0;background:#0e0b0c}</style></head>
<body bgcolor="#0e0b0c" style="margin:0;padding:0;background:#0e0b0c;font-family:Arial,Helvetica,sans-serif;color:#ece4d4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0e0b0c" style="background:#0e0b0c;background-color:#0e0b0c"><tr><td align="center" bgcolor="#0e0b0c" style="padding:24px 12px;background:#0e0b0c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#171213" style="max-width:520px;background:#171213;background-color:#171213;border:1px solid #3a2f30">
<tr><td style="padding:18px 22px;border-bottom:2px solid #c8141e"><a href="${SITE}" style="text-decoration:none"><img src="${SITE}/brand/email-header.png" width="256" height="96" alt="Pit Log" style="display:block;border:0;width:256px;height:96px;font-family:Georgia,serif;font-size:26px;color:#e0313a"></a></td></tr>
<tr><td style="padding:22px">
<h1 style="margin:0 0 10px;font-family:Georgia,serif;font-weight:normal;font-size:24px;line-height:1.2;color:#ece4d4">${esc(title)}</h1>
${intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#c9bfb3">${intro}</p>` : ""}
${body}
${button ? `<p style="margin:22px 0 4px"><a href="${esc(button.url)}" style="display:inline-block;background:#c8141e;color:#ece4d4;text-decoration:none;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;font-size:13px;padding:12px 18px">${esc(button.label)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:14px 22px;border-top:1px solid #3a2f30;font-size:12px;line-height:1.5;color:#8a7f78">${footer || ""}</td></tr>
</table></td></tr></table></body></html>`;
}
const showCard = (s, note) => `<div style="border:1px solid #3a2f30;background:#0e0b0c;background-color:#0e0b0c;padding:10px 12px;margin:0 0 8px">
<div style="font-size:16px;font-weight:bold;color:#ece4d4">${esc(showLine(s))}</div>
<div style="font-size:13px;color:#a2958d;margin-top:2px">${esc(placeLine(s))}</div>${note ? `<div style="font-size:13px;color:#7f9a5a;margin-top:4px">${esc(note)}</div>` : ""}</div>`;

// Digest: group queued items by friend so a big import reads as one line, not 30.
function buildDigest({ items, reminders, today, onsale = [] }){
  const sections = [];
  // Crew requests and Crew Family news lead the email.
  const reqs = items.filter(i => i.type === "request"), fam = items.filter(i => i.type === "familyInvite");
  const acc = items.filter(i => i.type === "accepted"), famOk = items.filter(i => i.type === "familyApproved");
  const handles = list => list.map(i => "@" + esc(i.fromHandle)).join(", ");
  const line = (t, c = "#ece4d4") => `<p style="margin:0 0 8px;font-size:15px;line-height:1.45;color:${c}">${t}</p>`;
  if (reqs.length || fam.length || acc.length || famOk.length) {
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#e0313a;margin:0 0 8px">Your crew</h2>` +
      (reqs.length ? `<div style="border:1px solid #c8141e;background:#1d1012;padding:12px 14px;margin:0 0 8px">${line(`<b>${reqs.length} crew request${reqs.length > 1 ? "s" : ""}</b> from ${handles(reqs)}. Accept on the Crew tab.`)}</div>` : "") +
      (fam.length ? line(`<b>Crew Family invite</b> from ${handles(fam)}: approve to link logs, so shows either of you add land in both. Ratings, notes, photos and spend stay your own.`) : "") +
      (acc.length ? line(`${handles(acc)} accepted your crew request.`) : "") +
      (famOk.length ? line(`${handles(famOk)} approved Crew Family. Your logs are linked.`) : ""));
  }
  if (reminders.length) {
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#e0313a;margin:${sections.length ? "18px" : "0"} 0 8px">${reminders.length > 1 ? `Your week ahead: ${reminders.length} shows` : "Coming up for you"}</h2>` +
      reminders.map(r => showCard(r.show, r.days === 1 ? "Tomorrow" : `In ${r.days} days`)).join(""));
  }
  if (onsale.length) {
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#c9762f;margin:${sections.length ? "18px" : "0"} 0 8px">Tickets on sale</h2>` +
      onsale.map(o => `<div style="border:1px solid #3a2f30;background:#0e0b0c;padding:10px 12px;margin:0 0 8px"><div style="font-size:16px;font-weight:bold;color:#ece4d4">${esc(o.name)}</div>` +
        `<div style="font-size:13px;color:#c9762f;margin-top:2px">${o.when === "today" ? "On sale today" : "On sale tomorrow"}${o.time ? " at " + esc(o.time) : ""}</div>` +
        (o.url ? `<div style="margin-top:6px"><a href="${esc(o.url)}" style="font-size:13px;color:#e0313a;text-decoration:none;font-weight:bold">Tickets ›</a></div>` : "") + `</div>`).join(""));
  }
  const comments = items.filter(i => i.type === "comment");
  if (comments.length) {
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#7f9a5a;margin:${sections.length ? "18px" : "0"} 0 8px">New comments</h2>` +
      comments.slice(0, 8).map(i => showCard(i.show, `@${i.fromHandle}: “${String(i.text || "").slice(0, 140)}”`)).join("") + (comments.length > 8 ? `<p style="margin:0 0 8px;font-size:13px;color:#a2958d">and ${comments.length - 8} more</p>` : ""));
  }
  const together = items.filter(i => i.type === "together");
  if (together.length) {
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#7f9a5a;margin:18px 0 8px">Same show as your crew</h2>` +
      together.slice(0, 10).map(i => showCard(i.show, `${isUpcoming(i.show.date, today) ? "Looks like @" + i.fromHandle + " is going too" : "@" + i.fromHandle + " was there too"}`)).join(""));
  }
  const tagged = items.filter(i => i.type === "tagged");
  if (tagged.length) {
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#7f9a5a;margin:18px 0 8px">You were tagged</h2>` +
      tagged.slice(0, 6).map(i => showCard(i.show, "Tagged by @" + i.fromHandle)).join("") + (tagged.length > 6 ? `<p style="margin:0 0 8px;font-size:13px;color:#a2958d">and ${tagged.length - 6} more</p>` : "") +
      `<p style="margin:0 0 8px;font-size:13px;color:#a2958d">Add them to your log from the Crew tab, as just the show or with their details.</p>`);
  }
  const added = items.filter(i => i.type === "added");
  if (added.length) {
    const byFriend = new Map();
    for (const i of added) { const e = byFriend.get(i.from) || { handle: i.fromHandle, shows: [] }; e.shows.push(i.show); byFriend.set(i.from, e); }
    const rows = [...byFriend.values()].map(f => {
      const up = f.shows.filter(s => isUpcoming(s.date, today)).sort((a, b) => a.date.localeCompare(b.date));
      const past = f.shows.filter(s => !isUpcoming(s.date, today));
      const shown = [...up, ...past].slice(0, 3);
      const more = f.shows.length - shown.length;
      return `<p style="margin:12px 0 6px;font-size:15px;color:#ece4d4"><b>@${esc(f.handle)}</b> added ${f.shows.length} show${f.shows.length > 1 ? "s" : ""}${up.length ? `, ${up.length} coming up` : ""}</p>` +
        shown.map(s => showCard(s)).join("") + (more > 0 ? `<p style="margin:0 0 8px;font-size:13px;color:#a2958d">and ${more} more</p>` : "");
    });
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#a2958d;margin:18px 0 0">New from your crew</h2>` + rows.join(""));
  }
  const bits = [];
  if (reqs.length) bits.push(`${reqs.length} crew request${reqs.length > 1 ? "s" : ""}`);
  if (fam.length) bits.push("Crew Family invite");
  if (acc.length) bits.push(`${acc.length} accepted`);
  if (famOk.length) bits.push("Crew Family linked");
  if (reminders.length) bits.push(`${reminders.length} show${reminders.length > 1 ? "s" : ""} coming up`);
  if (onsale.length) bits.push(`${onsale.length} going on sale`);
  if (comments.length) bits.push(`${comments.length} comment${comments.length > 1 ? "s" : ""}`);
  if (together.length) bits.push(`${together.length} you share with your crew`);
  if (tagged.length) bits.push(`${tagged.length} tag${tagged.length > 1 ? "s" : ""}`);
  if (added.length) bits.push(`${added.length} new from your crew`);
  const crewNews = reqs.length + fam.length + acc.length + famOk.length;
  const subject = onsale.length && !reqs.length && !fam.length ? `Tickets on sale ${onsale[0].when}: ${onsale[0].name}`
    : comments.length && !reqs.length && !fam.length && !tagged.length && !added.length && !together.length ? `@${comments[0].fromHandle} commented on ${showLine(comments[0].show)}`
    : reqs.length ? `@${reqs[0].fromHandle}${reqs.length > 1 ? ` and ${reqs.length - 1} more` : ""} want${reqs.length > 1 ? "" : "s"} you in their crew`
    : fam.length ? `@${fam[0].fromHandle} invited you to Crew Family`
    : acc.length && !tagged.length && !added.length && !together.length ? `@${acc[0].fromHandle} accepted your crew request`
    : famOk.length && !tagged.length && !added.length && !together.length ? `@${famOk[0].fromHandle} approved Crew Family`
    : reminders.length && items.length === crewNews
    ? (reminders.length > 1 ? `${reminders.length} shows this week, ${reminders[0].days === 1 ? "starting tomorrow" : "next up in " + reminders[0].days + " days"}: ${showLine(reminders[0].show)}`
      : reminders[0].days === 1 ? `Tomorrow: ${showLine(reminders[0].show)}` : `Coming up: ${showLine(reminders[0].show)}`)
    : together.length ? `@${together[0].fromHandle} is at ${showLine(together[0].show)} too`
    : tagged.length && !added.length ? `@${tagged[0].fromHandle} tagged you on ${tagged.length} show${tagged.length > 1 ? "s" : ""}`
    : added.length ? `Your crew logged ${added.length} new show${added.length > 1 ? "s" : ""}` : "Your crew on Pit Log";
  return { subject, body: sections.join(""), summary: bits.join(" · ") };
}

// Weekly recap (Sunday morning): open requests, your upcoming shows (with crew who are going too),
// your crew's other upcoming shows, plus anything queued for the digest.
function buildRecap({ requests, upcoming, crewUpcoming, items, announced = [], bucketOnSale = [], today }){
  const tix = a => a.url ? `<div style="margin-top:6px"><a href="${esc(a.url)}" style="font-size:13px;color:#e0313a;text-decoration:none;font-weight:bold">Tickets ›</a></div></div>` : "</div>";
  const H = (t, c) => `<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:${c};margin:18px 0 8px">${t}</h2>`;
  const parts = [];
  if (requests > 0) parts.push(`<div style="border:1px solid #c8141e;background:#1d1012;padding:12px 14px;margin:0 0 8px;font-size:15px;color:#ece4d4"><b>${requests} open crew request${requests > 1 ? "s" : ""}</b> waiting for you on the Crew tab.</div>`);
  if (upcoming.length) parts.push(H(`Your upcoming shows (${upcoming.length})`, "#e0313a") +
    upcoming.slice(0, 12).map(u => showCard(u.show, u.crew.length ? `Crew going too: ${u.crew.map(h => "@" + h).join(", ")}` : "")).join("") +
    (upcoming.length > 12 ? `<p style="margin:0 0 8px;font-size:13px;color:#a2958d">and ${upcoming.length - 12} more</p>` : ""));
  else parts.push(H("Your upcoming shows", "#e0313a") + `<p style="margin:0 0 8px;font-size:14px;color:#a2958d">Nothing on the calendar yet. Log your next show so your crew can see it.</p>`);
  if (crewUpcoming.length) parts.push(H("Your crew has coming up", "#7f9a5a") + crewUpcoming.map(f =>
    `<p style="margin:10px 0 6px;font-size:15px;color:#ece4d4"><b>@${esc(f.handle)}</b> · ${f.shows.length} show${f.shows.length > 1 ? "s" : ""}</p>` +
    f.shows.slice(0, 3).map(s => showCard(s)).join("") + (f.shows.length > 3 ? `<p style="margin:0 0 8px;font-size:13px;color:#a2958d">and ${f.shows.length - 3} more</p>` : "")).join(""));
  if (announced.length) parts.push(H(announced.some(a => a.note) ? "Just announced for you" : "Just announced: bands you've seen", "#c9762f") + announced.map(a =>
    showCard(a, a.note || "").replace(/<\/div>$/, tix(a))).join(""));
  if (bucketOnSale.length) parts.push(H("Still on sale: your bucket list", "#c9762f") + bucketOnSale.map(a => showCard(a, "").replace(/<\/div>$/, tix(a))).join(""));
  const news = items.length ? buildDigest({ items, reminders: [], today }) : null;
  if (news) parts.push(H("New this week", "#a2958d") + news.body);
  const crewCount = crewUpcoming.reduce((a, f) => a + f.shows.length, 0), together = upcoming.filter(u => u.crew.length).length;
  const bits = [];
  if (requests) bits.push(`${requests} open request${requests > 1 ? "s" : ""}`);
  bits.push(`${upcoming.length} upcoming show${upcoming.length === 1 ? "" : "s"}`);
  if (together) bits.push(`${together} with crew`);
  if (crewCount) bits.push(`${crewCount} on your crew's calendars`);
  if (announced.length) bits.push(`${announced.length} just announced`);
  if (bucketOnSale.length) bits.push(`${bucketOnSale.length} bucket list date${bucketOnSale.length > 1 ? "s" : ""} on sale`);
  const next = upcoming[0] && upcoming[0].show;
  const subject = requests ? `Your week on Pit Log: ${requests} crew request${requests > 1 ? "s" : ""} waiting`
    : next ? `Your week on Pit Log: ${showLine(next)} is next` : `Your week on Pit Log: ${crewCount} show${crewCount === 1 ? "" : "s"} on your crew's calendars`;
  return { subject, body: parts.join(""), summary: bits.join(" · "), empty: !requests && !upcoming.length && !crewUpcoming.length && !items.length && !announced.length && !bucketOnSale.length };
}

// Account emails
function verifyEmail({ name, link }){
  return { subject: "Confirm your email for Pit Log",
    title: `${name ? esc(name) + ", one" : "One"} more step`,
    intro: "Tap the button to confirm this is your email. Then you're in: log shows, rate the pits, and bring the crew.",
    body: `<p style="margin:0 0 8px;font-size:13px;color:#a2958d">The link works for 3 days. If the button doesn't work, copy this into your browser:<br><span style="word-break:break-all;color:#c9bfb3">${esc(link)}</span></p>`,
    button: { label: "Confirm my email", url: link } };
}
function welcomeEmail({ name, handle }){
  const step = (n, h, t) => `<tr><td style="padding:0 0 12px;vertical-align:top;width:40px"><div style="font-family:Georgia,serif;font-size:26px;line-height:1;color:#e0313a">${n}</div></td><td style="padding:0 0 12px"><div style="font-size:15px;font-weight:bold;color:#ece4d4">${h}</div><div style="font-size:14px;line-height:1.5;color:#c9bfb3">${t}</div></td></tr>`;
  return { subject: `Welcome to the pit${name ? ", " + name : ""}`,
    title: `Welcome to the pit${name ? ", " + esc(name) : ""}`,
    intro: `Your log is ready${handle ? ` and your username is <b style="color:#ece4d4">@${esc(handle)}</b>` : ""}. Here's how to make it yours:`,
    body: `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:6px 0 4px">` +
      step("01", "Log your first show", "Tap + and type a band. Pit Log finds the show and fills in the venue, date and lineup.") +
      step("02", "Rate the carnage", "Skulls for the show, bars for the pit, where you stood, and the moment you'll never shut up about.") +
      step("03", "Bring your crew", "Add friends by username to see their shows, tag them on the nights they were there, and link logs with Crew Family.") +
      step("04", "Build your bucket list", "Add the bands you still need to see. When they announce a date nearby, it shows up in Discover and your Sunday recap.") +
      `</table><p style="margin:4px 0 0;font-size:13px;color:#a2958d">Tip: open thepitlog.com on your phone and choose "Add to Home screen" so it opens like an app.</p>`,
    button: { label: "Log a show", url: SITE } };
}

module.exports = { localParts, verifyEmail, welcomeEmail, daysBetween, buildRecap, SITE, LV, canSee, EMAIL_DEFAULTS, prefs, lineup, sameShow, todayET, addDays, isUpcoming, prettyDate,
  showSummary, showLine, placeLine, esc, layout, showCard, buildDigest };
