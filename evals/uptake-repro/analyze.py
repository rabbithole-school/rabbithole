"""Compare an LLM uptake judge with the human raters in uptake_data.csv.

The CSV publishes, per item, the rating mean, how many raters agreed, and the
majority, but not the individual ratings. Most items had three raters; some had
two or one (a rater who marked an exchange off-task skipped uptake). On a 0/1/2
scale the aggregates pin the rating multiset down uniquely for every item but
one pattern: mean 1.0 with no agreement fits {1}, {0,2} and {0,1,2}. Those 126
items are dropped from per-rater metrics and kept in the vs-mean metrics. Rater
identities are not published, so ratings within an item are exchangeable.

Usage: python3 analyze.py results/<model>.jsonl [more.jsonl ...]
"""
import csv, itertools, json, os, sys, random
from collections import Counter
import numpy as np

HERE = __file__.rsplit("/", 1)[0]
rows = {f"{r['obs_id']}:{r['exchange_idx']}": r
        for r in csv.DictReader(open(f"{HERE}/data/uptake_data.csv"))
        if r["uptake"] != ""}


def ratings(r):
    """The unique rating multiset consistent with the aggregates, or None."""
    fits = []
    for k in (1, 2, 3):
        for ms in itertools.combinations_with_replacement((0, 1, 2), k):
            if abs(sum(ms) / k - float(r["uptake"])) > 1e-6:
                continue
            c = Counter(ms)
            top = max(c.values())
            if top != int(r["uptake_num_agree"]):
                continue
            if top >= 2 and float(r["uptake_majority"]) != c.most_common(1)[0][0]:
                continue
            if top == 1 and k > 1 and r["uptake_majority"] != "":
                continue
            fits.append(list(ms))
    if len(fits) == 1:
        return fits[0]
    # AMBIG=012 resolves the one ambiguous pattern to its three-rater reading.
    return [0, 1, 2] if os.environ.get("AMBIG") == "012" else None


def rank(x):
    x = np.asarray(x, float)
    order = x.argsort(kind="mergesort")
    ranks = np.empty(len(x))
    ranks[order] = np.arange(len(x))
    for v in np.unique(x):  # average ties
        idx = x == v
        ranks[idx] = ranks[idx].mean()
    return ranks


def spearman(a, b):
    return float(np.corrcoef(rank(a), rank(b))[0, 1])


def pearson(a, b):
    return float(np.corrcoef(a, b)[0, 1])


def alpha(units, metric):
    """Krippendorff's alpha; units = per-item rating lists (any length)."""
    vals = sorted({v for u in units for v in u})
    ix = {v: i for i, v in enumerate(vals)}
    o = np.zeros((len(vals), len(vals)))
    for u in units:
        m = len(u)
        if m < 2:
            continue
        for i in range(m):
            for j in range(m):
                if i != j:
                    o[ix[u[i]], ix[u[j]]] += 1 / (m - 1)
    n_c = o.sum(1)
    n = n_c.sum()
    d = np.array([[metric(a, b) for b in vals] for a in vals])
    return float(1 - ((o * d).sum() / n) / ((np.outer(n_c, n_c) * d).sum() / (n * (n - 1))))


interval = lambda a, b: (a - b) ** 2
nominal = lambda a, b: float(a != b)


def report(path):
    judged = [json.loads(l) for l in open(path) if l.strip()]
    judged = [j for j in judged if j["id"] in rows]
    n_all = len(judged)
    J_all = np.array([j["uptake"] for j in judged], float)
    P = np.array([[j["p_low"], j["p_mid"], j["p_high"]] for j in judged], float)
    EV_all = (P / P.sum(1, keepdims=True)) @ np.array([0, 1, 2])
    M_all = np.array([float(rows[j["id"]]["uptake"]) for j in judged])
    Z_all = np.array([float(rows[j["id"]]["uptake_zscore"]) for j in judged])
    R = [ratings(rows[j["id"]]) for j in judged]
    rng = random.Random(0)

    # Items with exactly three known ratings: the leave-one-out test.
    t3 = [i for i, r in enumerate(R) if r is not None and len(r) == 3]
    H = np.array([R[i] for i in t3])
    J, EV = J_all[t3], EV_all[t3]
    n = len(t3)

    def loo_once(idx, held_k):
        Hs = H[idx]
        held = Hs[np.arange(len(idx)), held_k]
        rest = (Hs.sum(1) - held) / 2
        return held, rest

    hs, js, es = [], [], []
    for _ in range(200):
        held, rest = loo_once(np.arange(n), np.array([rng.randrange(3) for _ in range(n)]))
        hs.append(spearman(held, rest)); js.append(spearman(J, rest)); es.append(spearman(EV, rest))
    gaps, egaps = [], []
    for _ in range(1000):
        s = np.array([rng.randrange(n) for _ in range(n)])
        held, rest = loo_once(s, np.array([rng.randrange(3) for _ in range(n)]))
        gaps.append(spearman(J[s], rest) - spearman(held, rest))
        egaps.append(spearman(EV[s], rest) - spearman(held, rest))

    # Pairwise exact agreement over every item with >= 2 known ratings.
    known = [(i, r) for i, r in enumerate(R) if r is not None]
    hh, jh, hh_d, jh_d = [], [], [], []
    for i, r in known:
        for a, b in itertools.combinations(r, 2):
            hh.append(a == b); hh_d.append(abs(a - b))
        for a in r:
            jh.append(J_all[i] == a); jh_d.append(abs(J_all[i] - a))

    # Alpha over all known items: humans, then judge swapped in for one human.
    multi = [r for _, r in known if len(r) >= 2]
    a_h = alpha(multi, interval)
    swaps = []
    for _ in range(50):
        units = []
        for i, r in known:
            if len(r) < 2:
                continue
            u = list(r); u[rng.randrange(len(u))] = int(J_all[i]); units.append(u)
        swaps.append(alpha(units, interval))
    a_add = alpha([list(r) + [int(J_all[i])] for i, r in known], interval)

    maj = np.array([rows[j["id"]]["uptake_majority"] for j in judged])
    has_maj = maj != ""
    s_on = np.array([int(rows[j["id"]]["student_on_task_majority"]) for j in judged])
    t_on = np.array([int(rows[j["id"]]["teacher_on_task_majority"]) for j in judged])
    js_on = np.array([j["student_on_task"] for j in judged])
    jt_on = np.array([j["teacher_on_task"] for j in judged])

    dist = lambda v: " / ".join(f"{np.mean(np.asarray(v) == k):.0%}" for k in (0, 1, 2))
    model = path.rsplit("/", 1)[-1].removesuffix(".jsonl")
    print(f"\n=== {model}  (n={n_all} exchanges; {n} with three known ratings) ===")
    print(f"label mix low/mid/high   humans {dist([v for _, r in known for v in r])}   judge {dist(J_all)}")
    print(f"three-rater items where all three disagree: {np.mean([len(set(h)) == 3 for h in H.tolist()]):.0%}")
    print("-- leave-one-out Spearman vs the other two raters' mean (three-rater items)")
    print(f"   a held-out human      {np.mean(hs):.3f}")
    print(f"   judge (label)         {np.mean(js):.3f}   gap vs human 95% CI [{np.percentile(gaps, 2.5):+.3f}, {np.percentile(gaps, 97.5):+.3f}]")
    print(f"   judge (expected val.) {np.mean(es):.3f}   gap vs human 95% CI [{np.percentile(egaps, 2.5):+.3f}, {np.percentile(egaps, 97.5):+.3f}]")
    print("-- vs the published aggregates (all items)")
    print(f"   rater mean: label Spearman {spearman(J_all, M_all):.3f}  expected-value Spearman {spearman(EV_all, M_all):.3f}")
    print(f"   z-score:    label Spearman {spearman(J_all, Z_all):.3f}  expected-value Spearman {spearman(EV_all, Z_all):.3f}  Pearson {pearson(EV_all, Z_all):.3f}")
    print("-- pairwise agreement with a single rater (items with known ratings)")
    print(f"   exact: human-human {np.mean(hh):.1%}   judge-human {np.mean(jh):.1%}")
    print(f"   mean |diff|: human-human {np.mean(hh_d):.3f}   judge-human {np.mean(jh_d):.3f}")
    print(f"   judge matches the majority label (n={has_maj.sum()}): {np.mean(J_all[has_maj] == maj[has_maj].astype(float)):.1%}")
    print("-- Krippendorff's alpha (interval)")
    print(f"   humans {a_h:.3f}   judge swapped in for one human {np.mean(swaps):.3f}   judge added as extra rater {a_add:.3f}   (humans nominal {alpha(multi, nominal):.3f})")
    print("-- on-task validity vs majority")
    print(f"   student: agreement {np.mean(js_on == s_on):.1%}  (on-task rate: humans {s_on.mean():.0%}, judge {js_on.mean():.0%})")
    print(f"   teacher: agreement {np.mean(jt_on == t_on):.1%}  (on-task rate: humans {t_on.mean():.0%}, judge {jt_on.mean():.0%})")
    hm = np.rint(M_all + 1e-9).astype(int)
    print("-- confusion (rows = rounded rater mean low/mid/high, cols = judge low/mid/high)")
    for a in range(3):
        print("   ", ["low", "mid", "high"][a], [int(np.sum((hm == a) & (J_all == b))) for b in range(3)])
    u = [j["usage"] for j in judged]
    print(f"tokens: in {sum(x['input_tokens'] for x in u):,}  cache read {sum(x.get('cache_read_input_tokens', 0) or 0 for x in u):,}  out {sum(x['output_tokens'] for x in u):,}")


for p in sys.argv[1:]:
    report(p)
