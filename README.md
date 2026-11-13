# Pit Log

Concert tracker with Google sign-in, private per-person logs, a friends ("Crew") view, and shows-together matching.
Static site (HTML/CSS/JS) on Firebase Auth, Firestore and Storage. Installable as an app (PWA).

## One-time Firebase setup
1. Authentication → Sign-in method → Google → Enable.
2. Firestore → Create database (nam5, production mode) → Rules tab → paste `firestore.rules` → Publish.
3. Storage → Rules tab → paste `storage.rules` → Publish.
4. Authentication → Settings → Authorized domains → add the domain this site is hosted on.

## Files
- `index.html`, `styles.css`, `app.js`: the app (Firebase config is at the top of app.js; it is not secret)
- `manifest.webmanifest`, `sw.js`, `icons/`: install-as-app support
- `firestore.rules`, `storage.rules`: security rules to paste into the Firebase console

## Email alerts (Cloud Functions in `functions/`)
Sent from alerts@thepitlog.com through Resend. Deployed by `.github/workflows/deploy-functions.yml` on every push that changes `functions/`.
- Instant: crew requests, accepted requests, Crew Family invites and approvals, tags.
- Digest at 6 PM Eastern (daily, or Sundays for weekly): shows your crew added, "looks like you're going too" matches, and your own show reminders 7 days and 1 day out.
- Each person controls these in Profile → Settings → Notifications; every email has one-tap unsubscribe links (`/u`).
- `node functions/test.js` runs the functions offline against an in-memory fake of Firestore.
Setup needs: Firebase Blaze plan, a verified thepitlog.com domain in Resend, and the repo secrets `FIREBASE_SERVICE_ACCOUNT` and `RESEND_API_KEY`.

## Show catalog (newly announced concerts)
`refreshCatalog` runs every morning (5:17 AM Eastern) and pulls Metal / Rock / Alternative / Punk
listings in PA, NJ, DE and NY for the next 15 months from the Ticketmaster Discovery API.
- Each show is stored once in `catalog/{id}` (parking, VIP and presale duplicates are merged or skipped).
  Unchanged shows aren't rewritten; shows that vanish before their date are removed; past ones are kept ~a year.
- `catalogMeta/recent` holds the last two weeks of new announcements (used for "Just announced").
- The app uses it when adding a show (matching shows), in band search, and in Search → Bands → Just announced.
  The Sunday recap lists new announcements for bands each person has logged.
- Needs a free Ticketmaster key (developer.ticketmaster.com → Consumer Key) saved as the GitHub
  secret `TICKETMASTER_API_KEY`. Without it the job skips quietly.
- To change genres or states, edit `GENRES` / `STATES` in `functions/catalog.js`.
