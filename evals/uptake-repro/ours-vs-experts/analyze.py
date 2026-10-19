"""Do OUR tutor-quality pedagogy scores track the experts' focusing/funneling labels?

Test set: the exchanges in the seeded sample that have a follow-up prompt (the
dataset's "filtered" z-score: funneling low, focusing high). A dimension that
measures what it claims should rank focusing replies above funneling ones.
Reference points: the codebook judge (funneling/) and the paper's human
leave-out agreement.

Usage: python3 analyze.py results/<model>.jsonl [../funneling/results/claude-opus-5-5.jsonl]
"""
import csv, json, sys
import numpy as np

HERE = __file__.rsplit("/", 1)[0]
rows = {r["uidx"]: r for r in csv.DictReader(open(f"{HERE}/../funneling/data/funneling_focusing_data.csv"))}
DIMS = ["socratic", "overScaffolding", "followUpQuality", "noviceStance", "cognitiveOffloading", "noSpoilers"]


def rank(x):
    x = np.asarray(x, float)
    r = np.empty(len(x))
    r[x.argsort(kind="mergesort")] = np.arange(len(x))
    for v in np.unique(x):
        r[x == v] = r[x == v].mean()
    return r


def spearman(a, b):
    return float(np.corrcoef(rank(a), rank(b))[0, 1])


def auc(score, positive):
    """P(a random positive outranks a random negative); 0.5 = chance."""
    score, positive = np.asarray(score, float), np.asarray(positive, bool)
    r = rank(score)
    n1, n0 = positive.sum(), (~positive).sum()
    return float((r[positive].sum() - n1 * (n1 - 1) / 2) / (n1 * n0))


ours = {j["id"]: j for j in (json.loads(l) for l in open(sys.argv[1]) if l.strip())}
ids = [i for i in ours if rows[i]["follow_up_filtered_zscore"]]
z = {i: float(rows[i]["follow_up_filtered_zscore"]) for i in ids}
maj = {i: rows[i]["follow_up_filtered_majority"] for i in ids}
print(f"exchanges with a follow-up prompt: {len(ids)} "
      f"(majority focusing {sum(m == '1.0' for m in maj.values())}, funneling {sum(m == '0.0' for m in maj.values())}, no majority {sum(m == '' for m in maj.values())})")
print()
print(f"{'dimension':22s} {'scored':>6s} {'Spearman vs z':>14s} {'AUC focus>funnel':>17s}   mean on focusing / funneling")
for d in DIMS:
    s = [i for i in ids if ours[i].get(d) is not None]
    if len(s) < 20:
        print(f"{d:22s} {len(s):6d}   (too few scored)")
        continue
    v = np.array([ours[i][d] for i in s], float)
    lab = [i for i in s if maj[i] != ""]
    pos = np.array([maj[i] == "1.0" for i in lab])
    lv = np.array([ours[i][d] for i in lab], float)
    print(f"{d:22s} {len(s):6d} {spearman(v, [z[i] for i in s]):14.3f} {auc(lv, pos):17.3f}   "
          f"{lv[pos].mean():.2f} / {lv[~pos].mean():.2f}")

# Does the judge let funnels through? Share of expert-funneling replies it rates 4–5.
fun = [i for i in ids if maj[i] == "0.0"]
foc = [i for i in ids if maj[i] == "1.0"]
for d in ("socratic", "overScaffolding"):
    print(f"\n{d}: rated 4–5 on {np.mean([ours[i][d] >= 4 for i in fun]):.0%} of expert-funneling replies, "
          f"{np.mean([ours[i][d] >= 4 for i in foc]):.0%} of expert-focusing replies")

if len(sys.argv) > 2:
    cb = {j["id"]: j for j in (json.loads(l) for l in open(sys.argv[2]) if l.strip())}
    s = [i for i in ids if i in cb]
    pf = [cb[i]["p_focusing"] / max(1, cb[i]["p_focusing"] + cb[i]["p_funneling"]) for i in s]
    lab = [k for k, i in enumerate(s) if maj[i] != ""]
    print(f"\nreference: codebook judge P(focusing | prompt)  Spearman {spearman(pf, [z[i] for i in s]):.3f}  "
          f"AUC {auc([pf[k] for k in lab], [maj[s[k]] == '1.0' for k in lab]):.3f}  (n={len(s)})")
print("reference: paper's human leave-out Spearman on this split .318")
