#!/usr/bin/env bash
# Download the funneling/focusing dataset (Alic et al. 2022, MIT) at a pinned
# commit, then write the seeded 400-item sample the committed results score.
set -euo pipefail
cd "$(dirname "$0")"
COMMIT=0bcda55da92853c3e26b1d6b2b62f3577094a097
SHA256=8cb2b464b21737e870bec566ba256165f1adcb3d421252d5be5fc3a9f0441509
mkdir -p data
curl -fsSL -o data/funneling_focusing_data.csv \
  "https://raw.githubusercontent.com/sterlingalic/funneling-focusing/$COMMIT/funneling_focusing_data.csv"
echo "$SHA256  data/funneling_focusing_data.csv" | shasum -a 256 -c -
python3 - <<'PY'
import csv, json, random
rows = [r for r in csv.DictReader(open("data/funneling_focusing_data.csv"))
        if r["follow_up_unfiltered_zscore"]]
random.Random(11).shuffle(rows)
json.dump([{"id": r["uidx"], "student": r["student_text"], "tutor": r["teacher_text"],
            "speaker": "Teacher"} for r in rows[:400]], open("data/sample.json", "w"))
print("wrote data/sample.json (400 exchanges)")
PY
