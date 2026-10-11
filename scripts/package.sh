#!/usr/bin/env bash
# Builds the zip you upload to the Chrome Web Store: the contents of extension/, manifest at the top level.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
out="dist/repodag-$version.zip"
mkdir -p dist
rm -f "$out"
(cd extension && zip -qr "../$out" . -x '.*' -x '*/.*')
echo "Built $out"
