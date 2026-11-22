"use client";

/**
 * The worksheet itself plus its controls: count, "New set", mixing in another
 * skill, print options, and the optional themed rewrite. The server builds the
 * sheet from the URL (lib/mathWorksheets/sheet.ts); every control here just
 * changes the URL, so the address bar always holds a link that reproduces
 * exactly what is on screen and on paper.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { StemText } from "@/components/practice/StemText";
import { PromptVisual } from "@/components/practice/PromptVisual";
import { SheetSteps } from "@/components/mathWorksheets/SheetSteps";
import { ThemeRewriter } from "@/components/mathWorksheets/ThemeRewriter";
import {
  COUNT_OPTIONS,
  MAX_SKILLS,
  randomSeed,
  sheetQuery,
  worksheetPath,
  type SheetParams,
} from "@/lib/mathWorksheets/params";
import { isRewritable } from "@/lib/mathWorksheets/themeRewrite";
import type { Sheet } from "@/lib/mathWorksheets/sheet";

export type MixOption = { key: string; label: string; grade: string };

const INK = "#23272a";

export function WorksheetMaker({
  slug,
  title,
  subtitle,
  sheet,
  skillLabels,
  mixOptions,
  linkHost,
}: {
  slug: string;
  title: string;
  subtitle: string;
  sheet: Sheet;
  /** Labels for every skill on the sheet, for the mix chips. */
  skillLabels: Record<string, string>;
  mixOptions: MixOption[];
  /** Printed in the sheet footer so a paper copy leads back to its link. */
  linkHost: string;
}) {
  const router = useRouter();
  const p = sheet.params;
  const [rewrites, setRewrites] = useState<Map<number, string>>(new Map());
  const [withSteps, setWithSteps] = useState(true);
  const [withKey, setWithKey] = useState(true);

  const go = (next: SheetParams) => router.push(worksheetPath(slug) + sheetQuery(next), { scroll: false });
  const stemOf = (n: number, stem: string) => rewrites.get(n) ?? stem;

  const candidates = useMemo(
    () => sheet.items.filter(isRewritable).map((i) => ({ n: i.n, stem: i.stem })),
    [sheet.items],
  );
  const stepItems = sheet.items.filter((i) => i.steps);
  const mixable = mixOptions.filter((o) => !p.skillKeys.includes(o.key));
  const link = `${linkHost}${worksheetPath(slug)}${sheetQuery(p)}`;

  return (
    <>
      <div className="mw-surface mw-noprint">
        <div className="mw-controls">
          <label className="mw-field">
            Problems
            <select value={p.count} onChange={(e) => go({ ...p, count: Number(e.target.value) })}>
              {COUNT_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          {mixable.length > 0 && p.skillKeys.length < MAX_SKILLS && (
            <label className="mw-field" style={{ flex: "1 1 240px" }}>
              Mix in another skill
              <select
                value=""
                onChange={(e) => e.target.value && go({ ...p, skillKeys: [...p.skillKeys, e.target.value] })}
              >
                <option value="">Choose a skill…</option>
                {mixable.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label} ({o.grade === "K" ? "K" : `grade ${o.grade}`})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="mw-btn" onClick={() => go({ ...p, seed: randomSeed() })}>
            New set
          </button>
          <button type="button" className="mw-btn mw-btn-primary" onClick={() => window.print()}>
            Print
          </button>
        </div>
        {p.skillKeys.length > 1 && (
          <div className="mw-chips" aria-label="Skills on this sheet">
            {p.skillKeys.map((k, i) => (
              <span className="mw-chip" key={k}>
                {skillLabels[k] ?? k}
                {i > 0 && (
                  <button
                    type="button"
                    aria-label={`Take ${skillLabels[k] ?? k} off this sheet`}
                    onClick={() => go({ ...p, skillKeys: p.skillKeys.filter((x) => x !== k) })}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="mw-print-opts">
          {stepItems.length > 0 && (
            <label>
              <input type="checkbox" checked={withSteps} onChange={(e) => setWithSteps(e.target.checked)} /> Print the
              worked-steps page
            </label>
          )}
          <label>
            <input type="checkbox" checked={withKey} onChange={(e) => setWithKey(e.target.checked)} /> Print the answer
            key
          </label>
        </div>
        {sheet.short && (
          <p className="mw-note">
            This skill has only {sheet.items.length} different problems, so the sheet has {sheet.items.length}.
          </p>
        )}
        <p className="mw-note">
          The link in your address bar makes this exact sheet again. Share it and everyone prints the same problems.
        </p>
      </div>

      {candidates.length > 0 && (
        <ThemeRewriter candidates={candidates} onRewrite={setRewrites} />
      )}

      <section className="mw-sheet mw-page" aria-label="Worksheet">
        <header className="mw-sheet-head">
          <div>
            <h2 className="mw-sheet-title">{title}</h2>
            <p className="mw-sheet-sub">{subtitle}</p>
          </div>
          <div className="mw-name">
            Name ____________________
            <br />
            Date ______________
          </div>
        </header>
        <ol className="mw-items">
          {sheet.items.map((item) => (
            <li key={item.n} className={`mw-item${item.wide ? " mw-item-wide" : ""}`}>
              <span className="mw-num">{item.n}.</span>
              <div className="mw-item-body">
                <StemText value={stemOf(item.n, item.stem)} fontSize={17} align="left" color={INK} weight={400} lineHeight={1.5} />
                {item.promptVisual && (
                  <div className="mw-visual">
                    <PromptVisual spec={item.promptVisual} />
                  </div>
                )}
                {item.choices ? (
                  <div className="mw-choices">
                    {item.choices.map((c) => (
                      <span className="mw-choice" key={c}>
                        {c}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="mw-answer-line" aria-hidden />
                )}
              </div>
            </li>
          ))}
        </ol>
        <footer className="mw-sheet-foot">
          <span>{link}</span>
          <span>Set {p.seed}</span>
        </footer>
      </section>

      {stepItems.length > 0 && (
        <section className={`mw-sheet mw-page${withSteps ? "" : " mw-skip-print"}`} aria-label="Worked steps">
          <header className="mw-sheet-head">
            <div>
              <h2 className="mw-sheet-title">Stuck? Start it together</h2>
              <p className="mw-sheet-sub">
                The first steps are worked out. The last step, the one that gives the answer, is left for your child.
              </p>
            </div>
          </header>
          <div className="mw-steps-grid">
          {stepItems.map((item) => (
            <div className="mw-steps-item" key={item.n}>
              <div className="mw-steps-q">
                <strong>{item.n}.</strong>{" "}
                <StemText value={stemOf(item.n, item.stem)} fontSize={15} align="left" color={INK} weight={400} lineHeight={1.4} />
              </div>
              {item.steps && <SheetSteps steps={item.steps} />}
            </div>
          ))}
          </div>
        </section>
      )}

      <section className={`mw-sheet mw-page${withKey ? "" : " mw-skip-print"}`} aria-label="Answer key">
        <header className="mw-sheet-head">
          <div>
            <h2 className="mw-sheet-title">Answer key</h2>
            <p className="mw-sheet-sub">
              {title} · set {p.seed}
              {sheet.items.some((i) => i.answerText.includes("/")) &&
                ". Fractions are in simplest form; an equal fraction, like 8/6 for 4/3, is right too."}
            </p>
          </div>
        </header>
        <ol className="mw-key">
          {sheet.items.map((item) => (
            <li key={item.n}>
              <strong>{item.n}.</strong> <StemText value={item.answerText} fontSize={15} align="left" color={INK} weight={400} />
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
