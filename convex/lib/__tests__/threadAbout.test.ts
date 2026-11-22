import { describe, expect, test } from "vitest";
import { pickAboutSlackTarget, sameAbout, scholarsAddressedBy } from "../threadAbout";
import type { Id } from "../../_generated/dataModel";

const line = (scholarId: string, scholarName: string, n = 1) => ({
  scholarId,
  scholarName,
  n,
});
const person = (scholarId: string, scholarName: string) => ({ scholarId, scholarName });

const quinn = line("q", "Quinn Test");
const remy = line("r", "Remy Test");
// Schoolmates; Zara is on no line of any root below.
const roster = [person("q", "Quinn Test"), person("r", "Remy Test"), person("z", "Zara Test")];

describe("scholarsAddressedBy", () => {
  test("only a name at the very start, before a comma, colon or dash, addresses", () => {
    expect(scholarsAddressedBy(roster, "Quinn, count your neck bones")).toEqual(new Set(["q"]));
    expect(scholarsAddressedBy(roster, "  quinn test: nice")).toEqual(new Set(["q"]));
    expect(scholarsAddressedBy(roster, "Remy - see me")).toEqual(new Set(["r"]));
    expect(scholarsAddressedBy(roster, "Nice one, Quinn!")).toEqual(new Set());
    expect(scholarsAddressedBy(roster, "Quinn and Remy, see me")).toEqual(new Set());
    expect(scholarsAddressedBy(roster, "Quinnley, hi")).toEqual(new Set());
  });

  test("a name that is also a word addresses nobody unless it leads with a comma", () => {
    const will = [person("w", "Will Test")];
    expect(scholarsAddressedBy(will, "Will you look at this?")).toEqual(new Set());
    expect(scholarsAddressedBy(will, "Great question; we will investigate tomorrow")).toEqual(
      new Set(),
    );
    expect(scholarsAddressedBy(will, "Will, look at this")).toEqual(new Set(["w"]));
  });

  test("a shared name addresses everyone it fits", () => {
    const sams = [person("a", "Sam Lee"), person("b", "Sam Lee"), person("c", "Sam Birch")];
    expect(scholarsAddressedBy(sams, "Sam Lee, nice")).toEqual(new Set(["a", "b"]));
    expect(scholarsAddressedBy(sams, "Sam Birch, nice")).toEqual(new Set(["c"]));
    expect(scholarsAddressedBy(sams, "Sam, nice")).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("Slack markup before or around the name", () => {
  const remyAddressed = [
    "*Remy*, nice work",
    "_Remy_: nice work",
    "~Remy~ - nice work",
    "`Remy`, nice work",
    "> Remy, nice work",
    "&gt; Remy, nice work",
    ":wave: Remy, nice work",
    "👋 Remy, nice work",
    "<@U123> Remy, nice work",
    "<https://example.test|link> Remy, nice work",
    "&gt; :wave: <@U123> *Remy Test*: nice work",
  ];

  test.each(remyAddressed)("%s addresses Remy", (text) => {
    expect(scholarsAddressedBy(roster, text)).toEqual(new Set(["r"]));
  });

  test.each(remyAddressed)("%s under Quinn's own root is refused", (text) => {
    expect(pickAboutSlackTarget([quinn], roster, text)).toEqual({
      ok: false,
      reason: "names_someone_else",
    });
  });

  test.each(remyAddressed)("%s on a day's note goes to Remy", (text) => {
    expect(pickAboutSlackTarget([quinn, remy], roster, text)).toEqual({
      ok: true,
      target: remy,
    });
  });

  test("*Quinn*, great still reaches Quinn", () => {
    expect(pickAboutSlackTarget([quinn], roster, "*Quinn*, great")).toEqual({
      ok: true,
      target: quinn,
    });
    expect(pickAboutSlackTarget([quinn, remy], roster, "*Quinn*, great")).toEqual({
      ok: true,
      target: quinn,
    });
  });
});

describe("pickAboutSlackTarget: a root about several scholars", () => {
  test("goes to the one mapped scholar the reply addresses", () => {
    expect(pickAboutSlackTarget([quinn, remy], roster, "quinn, count your neck bones")).toEqual({
      ok: true,
      target: quinn,
    });
    expect(pickAboutSlackTarget([quinn, remy], roster, "Remy Test: nice one")).toEqual({
      ok: true,
      target: remy,
    });
  });

  test("refuses everything else", () => {
    const refuse = (targets: (typeof quinn)[], people: typeof roster, text: string) =>
      pickAboutSlackTarget(targets, people, text);
    expect(refuse([quinn, remy], roster, "Great questions today")).toEqual({
      ok: false,
      reason: "no_address",
    });
    expect(refuse([quinn, remy], roster, "Nice one, Remy!")).toEqual({
      ok: false,
      reason: "no_address",
    });
    expect(refuse([quinn, remy], roster, "Zara, ask Quinn tomorrow")).toEqual({
      ok: false,
      reason: "names_someone_else",
    });
    const quinn2 = line("q", "Quinn Test", 2);
    expect(refuse([quinn, quinn2, remy], roster, "Quinn, yes")).toEqual({
      ok: false,
      reason: "several_lines",
    });
  });

  test("two mapped scholars who share a full name: refused, never the first one", () => {
    const samA = line("a", "Sam Lee");
    const samB = line("b", "Sam Lee");
    expect(pickAboutSlackTarget([samA, samB], [], "Sam Lee, nice")).toEqual({
      ok: false,
      reason: "several_names",
    });
    // A schoolmate sharing the name is enough to refuse too.
    expect(
      pickAboutSlackTarget([samA, remy], [person("x", "Sam Lee")], "Sam Lee, nice"),
    ).toEqual({ ok: false, reason: "several_names" });
  });

  test("a name used as a word goes to nobody", () => {
    const will = line("w", "Will Test");
    for (const text of ["Great question; we will investigate tomorrow", "Will you look at this?"]) {
      expect(pickAboutSlackTarget([will, remy], roster, text)).toEqual({
        ok: false,
        reason: "no_address",
      });
    }
  });
});

describe("pickAboutSlackTarget: a root about one scholar", () => {
  test("a reply that addresses nobody, or only them, goes to them", () => {
    for (const text of ["Who is it for?", "Great question, tell me more", "Quinn, who is it for?"]) {
      expect(pickAboutSlackTarget([quinn], roster, text)).toEqual({ ok: true, target: quinn });
    }
  });

  test("a reply addressed to any other scholar at the school is refused", () => {
    expect(pickAboutSlackTarget([quinn], roster, "Zara, nice work")).toEqual({
      ok: false,
      reason: "names_someone_else",
    });
    expect(pickAboutSlackTarget([quinn], roster, "Remy Test: nice work")).toEqual({
      ok: false,
      reason: "names_someone_else",
    });
    // The root's scholar shares a first name with a schoolmate.
    expect(
      pickAboutSlackTarget([quinn], [...roster, person("q2", "Quinn Other")], "Quinn, hi"),
    ).toEqual({ ok: false, reason: "several_names" });
  });

  test("their two lines on one root still can't be told apart", () => {
    expect(pickAboutSlackTarget([quinn, line("q", "Quinn Test", 2)], roster, "Yes!")).toEqual({
      ok: false,
      reason: "several_lines",
    });
  });
});

describe("sameAbout", () => {
  const unit = "u1" as Id<"units">;
  const seed = "s1" as Id<"seeds">;
  test("compares type and id", () => {
    expect(sameAbout({ type: "quest", unitId: unit }, { type: "quest", unitId: unit })).toBe(true);
    expect(sameAbout({ type: "wonder", seedId: seed }, { type: "quest", unitId: unit })).toBe(false);
    expect(sameAbout(undefined, { type: "wonder", seedId: seed })).toBe(false);
  });
});
