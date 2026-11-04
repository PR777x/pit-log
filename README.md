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
