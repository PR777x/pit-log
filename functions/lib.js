// Pure helpers shared by the email functions (no Firebase calls here, so they can be tested alone).
const SITE = "https://thepitlog.com";

const LV = { private: 0, family: 1, crew: 2, public: 3 };
// Same rule as the app: Crew Family sees "family" and up, the rest of the crew sees "crew" and up.
const canSee = (settings, key, isFamily) => LV[(settings || {})[key] || "public"] >= (isFamily ? LV.family : LV.crew);

// Email preferences live on users/{uid}.settings next to the privacy settings.
const EMAIL_DEFAULTS = { emailRequests: "on", emailTags: "on", emailDigest: "daily", emailReminders: "on" };
const prefs = user => ({ ...EMAIL_DEFAULTS, ...((user && user.settings) || {}) });

const lineup = s => (Array.isArray(s && s.lineup) ? s.lineup.filter(Boolean) : []);
const ieq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
function sameShow(a, b){
  if (!a.date || a.date !== b.date) return false;
  if (a.venue && b.venue && ieq(a.venue, b.venue)) return true;
  return lineup(a).some(x => lineup(b).some(y => ieq(x, y)));
}

// Dates are stored as YYYY-MM-DD; "today" is in Eastern time, where everyone using the app is.
function todayET(now = new Date()){
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = t => p.find(x => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
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
const showSummary = (s, id) => ({ id: id || s.id || "", date: s.date || "", lineup: lineup(s).slice(0, 4), venue: s.venue || "", city: s.city || "" });
const showLine = s => `${lineup(s)[0] || "A show"}${lineup(s).length > 1 ? " w/ " + lineup(s).slice(1, 3).join(", ") : ""}`;
const placeLine = s => [prettyDate(s.date), [s.venue, s.city].filter(Boolean).join(", ")].filter(Boolean).join(" · ");

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// One email layout for everything: dark, plain, works in Gmail and Apple Mail.
function layout({ title, intro, body = "", button, footer }){
  return `<!doctype html><html><body style="margin:0;background:#0e0b0c;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#ece4d4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#171213;border:1px solid #3a2f30">
<tr><td style="padding:18px 22px;border-bottom:2px solid #c8141e"><span style="font-family:Georgia,serif;font-size:26px;color:#ece4d4">Pit <span style="color:#e0313a">Log</span></span></td></tr>
<tr><td style="padding:22px">
<h1 style="margin:0 0 10px;font-family:Georgia,serif;font-weight:normal;font-size:24px;line-height:1.2;color:#ece4d4">${esc(title)}</h1>
${intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#c9bfb3">${intro}</p>` : ""}
${body}
${button ? `<p style="margin:22px 0 4px"><a href="${esc(button.url)}" style="display:inline-block;background:#c8141e;color:#ece4d4;text-decoration:none;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;font-size:13px;padding:12px 18px">${esc(button.label)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:14px 22px;border-top:1px solid #3a2f30;font-size:12px;line-height:1.5;color:#8a7f78">${footer || ""}</td></tr>
</table></td></tr></table></body></html>`;
}
const showCard = (s, note) => `<div style="border:1px solid #3a2f30;background:#0e0b0c;padding:10px 12px;margin:0 0 8px">
<div style="font-size:16px;font-weight:bold;color:#ece4d4">${esc(showLine(s))}</div>
<div style="font-size:13px;color:#a2958d;margin-top:2px">${esc(placeLine(s))}</div>${note ? `<div style="font-size:13px;color:#7f9a5a;margin-top:4px">${esc(note)}</div>` : ""}</div>`;

// Digest: group queued items by friend so a big import reads as one line, not 30.
function buildDigest({ items, reminders, today }){
  const sections = [];
  if (reminders.length) {
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#e0313a;margin:0 0 8px">Coming up for you</h2>` +
      reminders.map(r => showCard(r.show, r.days === 1 ? "Tomorrow" : `In ${r.days} days`)).join(""));
  }
  const together = items.filter(i => i.type === "together");
  if (together.length) {
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#7f9a5a;margin:18px 0 8px">Same show as your crew</h2>` +
      together.slice(0, 10).map(i => showCard(i.show, `${isUpcoming(i.show.date, today) ? "Looks like @" + i.fromHandle + " is going too" : "@" + i.fromHandle + " was there too"}`)).join(""));
  }
  const tagged = items.filter(i => i.type === "tagged");
  if (tagged.length) {
    sections.push(`<h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#7f9a5a;margin:18px 0 8px">You were tagged</h2>` +
      tagged.slice(0, 6).map(i => showCard(i.show, "Tagged by @" + i.fromHandle)).join("") + (tagged.length > 6 ? `<p style="margin:0 0 8px;font-size:13px;color:#a2958d">and ${tagged.length - 6} more</p>` : ""));
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
  if (reminders.length) bits.push(`${reminders.length} show${reminders.length > 1 ? "s" : ""} coming up`);
  if (together.length) bits.push(`${together.length} you share with your crew`);
  if (tagged.length) bits.push(`${tagged.length} tag${tagged.length > 1 ? "s" : ""}`);
  if (added.length) bits.push(`${added.length} new from your crew`);
  const subject = reminders.length && !items.length
    ? (reminders[0].days === 1 ? `Tomorrow: ${showLine(reminders[0].show)}` : `Coming up: ${showLine(reminders[0].show)}`)
    : together.length ? `@${together[0].fromHandle} is at ${showLine(together[0].show)} too`
    : tagged.length && !added.length ? `@${tagged[0].fromHandle} tagged you on ${tagged.length} show${tagged.length > 1 ? "s" : ""}`
    : `Your crew logged ${added.length} new show${added.length > 1 ? "s" : ""}`;
  return { subject, body: sections.join(""), summary: bits.join(" · ") };
}

module.exports = { SITE, LV, canSee, EMAIL_DEFAULTS, prefs, lineup, sameShow, todayET, addDays, isUpcoming, prettyDate,
  showSummary, showLine, placeLine, esc, layout, showCard, buildDigest };
