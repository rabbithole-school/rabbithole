"use client";

/**
 * The hub's skill list with grade and topic filters. The server renders the
 * whole list (so search engines and no-JS readers get every link); the two
 * selects only hide rows.
 */

import Link from "next/link";
import { useState } from "react";

export type PickerSkill = { slug: string; label: string; grade: string; domain: string; domainLabel: string };

export function SkillPicker({
  skills,
  grades,
  domains,
}: {
  skills: PickerSkill[];
  grades: { grade: string; name: string }[];
  domains: { domain: string; label: string }[];
}) {
  const [grade, setGrade] = useState("");
  const [domain, setDomain] = useState("");
  const shown = skills.filter((s) => (!grade || s.grade === grade) && (!domain || s.domain === domain));

  return (
    <>
      <div className="mw-filters">
        <label className="mw-field">
          Grade
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            <option value="">All grades</option>
            {grades.map((g) => (
              <option key={g.grade} value={g.grade}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mw-field">
          Topic
          <select value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">All topics</option>
            {domains.map((d) => (
              <option key={d.domain} value={d.domain}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <p className="mw-note" style={{ margin: 0 }}>
          {shown.length} {shown.length === 1 ? "skill" : "skills"}
        </p>
      </div>
      <div style={{ marginTop: 20 }}>
        {grades
          .filter((g) => shown.some((s) => s.grade === g.grade))
          .map((g) => (
            <section key={g.grade} className="mw-grade" aria-labelledby={`mw-g-${g.grade}`}>
              <h2 className="mw-h2" id={`mw-g-${g.grade}`}>
                {g.name}
              </h2>
              {domains
                .filter((d) => shown.some((s) => s.grade === g.grade && s.domain === d.domain))
                .map((d) => (
                  <div key={d.domain}>
                    <h3 className="mw-domain-label">{d.label}</h3>
                    {shown
                      .filter((s) => s.grade === g.grade && s.domain === d.domain)
                      .map((s) => (
                        <div className="mw-skill" key={s.slug}>
                          <Link href={`/math-worksheets/${s.slug}`} prefetch={false}>{s.label}</Link>
                        </div>
                      ))}
                  </div>
                ))}
            </section>
          ))}
      </div>
    </>
  );
}
