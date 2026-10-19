"""Compare the follow-up-type judge with the human labels in Alic et al. (2022).

Labels: the dataset's 3-rater majority and averaged z-score. Unfiltered scale is
none (0) < funneling (1) < focusing (2); the filtered scale keeps only exchanges
with a follow-up prompt and codes funneling 0 < focusing 1. Individual ratings
are not published, so this compares against the 3-rater aggregate, the same way
the paper evaluates its trained models.

Usage: python3 analyze.py results/<model>.jsonl
"""
import csv, json, sys
import numpy as np

HERE = __file__.rsplit("/", 1)[0]
rows = {r["uidx"]: r for r in csv.DictReader(open(f"{HERE}/data/funneling_focusing_data.csv"))}


def rank(x):
    x = np.asarray(x, float)
    r = np.empty(len(x))
    r[x.argsort(kind="mergesort")] = np.arange(len(x))
    for v in np.unique(x):
        r[x == v] = r[x == v].mean()
    return r


def spearman(a, b):
    return float(np.corrcoef(rank(a), rank(b))[0, 1])


J = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
P = np.array([[j["p_none"], j["p_funneling"], j["p_focusing"]] for j in J], float)
P /= P.sum(1, keepdims=True)
EV = P @ np.array([0, 1, 2])
L = np.array([{"none": 0, "funneling": 1, "focusing": 2}[j["follow_up"]] for j in J])
Z = np.array([float(rows[j["id"]]["follow_up_unfiltered_zscore"]) for j in J])
maj = [rows[j["id"]]["follow_up_unfiltered_majority"] for j in J]
has = [i for i, m in enumerate(maj) if m != ""]
M = np.array([int(float(maj[i])) for i in has])
names = ["none", "funneling", "focusing"]

print(f"n={len(J)} exchanges ({len(has)} with a majority label)")
print("-- three-way (none < funneling < focusing) vs the 3-rater z-score")
print(f"   Spearman: expected value {spearman(EV, Z):.3f}, label {spearman(L, Z):.3f}")
print("   paper: human leave-out .644; best trained model (RoBERTa) ~.76")
print(f"   exact match with the majority label: {np.mean(L[has] == M):.1%}")
print("   label mix  humans " + " / ".join(f"{n} {np.mean(M == k):.0%}" for k, n in enumerate(names)))
print("              judge  " + " / ".join(f"{n} {np.mean(L == k):.0%}" for k, n in enumerate(names)))
print("   confusion (rows = human majority, cols = judge), order none/funneling/focusing")
for a in range(3):
    print("    ", f"{names[a]:9s}", [int(np.sum((M == a) & (L[has] == b))) for b in range(3)])

f = [i for i, j in enumerate(J) if rows[j["id"]]["follow_up_filtered_zscore"]]
ZF = np.array([float(rows[J[i]["id"]]["follow_up_filtered_zscore"]) for i in f])
PF = np.array([P[i, 2] / (P[i, 1] + P[i, 2] + 1e-9) for i in f])
print("-- funneling vs focusing only (exchanges with a follow-up prompt)")
print(f"   Spearman P(focusing | prompt) vs filtered z-score: {spearman(PF, ZF):.3f}  (n={len(f)}; paper: human leave-out .318)")
mf = [i for i in f if rows[J[i]["id"]]["follow_up_filtered_majority"] != ""]
hum = np.array([rows[J[i]["id"]]["follow_up_filtered_majority"] == "1.0" for i in mf])
jud = np.array([P[i, 2] > P[i, 1] for i in mf])
print(f"   agreement with majority: {np.mean(hum == jud):.1%} (n={len(mf)}; focusing base rate {hum.mean():.0%}, judge calls focusing {jud.mean():.0%})")
