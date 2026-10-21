#!/bin/sh
# Builds the ZapWorks upload: index.html at the zip root plus fonts/ and assets/.
# If zappar.js (+ companions from zappar-js.zip) sit next to index.html they are bundled too,
# otherwise index.html falls back to Zappar's CDN at runtime.
set -e
cd "$(dirname "$0")/.."
VERSION=$(grep -o 'Resonance 0\.[0-9]*' index.html | head -1 | cut -d' ' -f2)
OUT="dist/resonance-webar-${VERSION:-build}.zip"
mkdir -p dist && rm -f "$OUT"
FILES="index.html fonts assets"
for f in zappar.js zappar-js.wasm zappar-cv.js zappar-cv.wasm; do [ -e "$f" ] && FILES="$FILES $f"; done
zip -qr "$OUT" $FILES -x '*.DS_Store' 'assets/*.png.orig'
echo "built $OUT ($(du -h "$OUT" | cut -f1))"; unzip -l "$OUT" | tail -1
