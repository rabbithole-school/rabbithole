#!/usr/bin/env bash
# Download the uptake dataset (Demszky et al. 2021, MIT) at a pinned commit.
set -euo pipefail
cd "$(dirname "$0")"
COMMIT=67fb30cf7c3ea6f619487e33d2f99692dca107d0
SHA256=fe282dcc13696be7ba07beb9f5e9722b3dd4c3da52365470baea8b642b578d00
mkdir -p data
curl -fsSL -o data/uptake_data.csv \
  "https://raw.githubusercontent.com/ddemszky/conversational-uptake/$COMMIT/data/uptake_data.csv"
echo "$SHA256  data/uptake_data.csv" | shasum -a 256 -c -
