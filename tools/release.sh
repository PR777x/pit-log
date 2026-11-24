#!/usr/bin/env bash
# Usage: tools/release.sh <build number>
# Bumps every version string for a new build and rebuilds app.min.js (the file the site actually loads).
# app.js stays the readable source; never edit app.min.js by hand.
set -euo pipefail
N="$1"; cd "$(dirname "$0")/.."
sed -i -E "s/styles\.css\?v=[0-9]+/styles.css?v=$N/; s/app\.min\.js\?v=[0-9]+/app.min.js?v=$N/; s/<!-- app\.js\?v=[0-9]+/<!-- app.js?v=$N/; s/build [0-9]+<\/p>/build $N<\/p>/" index.html
sed -i -E "s/venues\.js\?v=[0-9]+/venues.js?v=$N/" app.js
sed -i -E "s/^const V = \"[0-9]+\";/const V = \"$N\";/; s/pitlog-v[0-9]+/pitlog-v$N/" sw.js
ESB="${ESBUILD:-$(command -v esbuild || echo /opt/npm-tools/node_modules/@esbuild/linux-x64/bin/esbuild)}"
"$ESB" app.js --minify --format=esm --target=es2020 --legal-comments=none --log-level=warning --outfile=app.min.js
grep -q "venues.js?v=$N" app.min.js && grep -q "app.min.js?v=$N" index.html && echo "Build $N ready"
