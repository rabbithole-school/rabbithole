import { describe, expect, it } from "vitest";

import {
  alignUtterance,
  beginnerAlphabet,
  beginnerDisplay,
  mapSpans,
  checkDecodable,
  compareReading,
  conversationTextSteps,
  readsAlong,
  lastYourTurnLine,
  YOUR_TURN_CUES,
  yourTurnCue,
  isDecodableWord,
  locateUtterance,
  partSpans,
  splitYourTurn,
  spokenWordInMessage,
  stripYourTurnMarkers,
  withoutYourTurn,
  wordIndexAt,
  wordRuns,
  wordStartFractions,
  wordTokens,
  YourTurnSpeechFilter,
} from "../beginnerReading";

describe("your-turn marker", () => {
  const reply =
    "Foxes dig dens to stay cool.\n\n<your-turn>Can a pig dig?</your-turn>";

  it("splits a reply into text and the child's line", () => {
    const parts = splitYourTurn(reply);
    expect(parts).toEqual([
      { kind: "text", text: "Foxes dig dens to stay cool.\n\n", start: 0 },
      { kind: "yourTurn", text: "Can a pig dig?", start: 41 },
    ]);
    // offsets point back into the raw reply
    for (const p of parts) {
      expect(reply.slice(p.start, p.start + p.text.length)).toBe(p.text);
    }
  });

  it("keeps a reply with no marker whole", () => {
    expect(splitYourTurn("Just text.")).toEqual([
      { kind: "text", text: "Just text.", start: 0 },
    ]);
  });

  it("runs an unclosed line to the end and drops empty lines and stray closers", () => {
    expect(splitYourTurn("Hi.<your-turn> A cat")).toEqual([
      { kind: "text", text: "Hi.", start: 0 },
      { kind: "yourTurn", text: "A cat", start: 15 },
    ]);
    expect(
      splitYourTurn("Hi.<your-turn>  </your-turn> Bye.</your-turn>!")
        .map((p) => p.text)
        .join(""),
    ).toBe("Hi. Bye.!");
  });

  it("strips the tags for plain surfaces, and drops the line for the voice", () => {
    expect(stripYourTurnMarkers(reply)).toBe(
      "Foxes dig dens to stay cool.\n\nCan a pig dig?",
    );
    // mid-stream: a half-arrived tag is hidden, so the text only grows
    expect(stripYourTurnMarkers("Dig. <your-tu")).toBe("Dig. ");
    expect(stripYourTurnMarkers("Dig. <your-turn>A pig</yo")).toBe("Dig. A pig");
    expect(stripYourTurnMarkers("3 <")).toBe("3 <");
    expect(withoutYourTurn(reply)).toBe("Foxes dig dens to stay cool.");
  });

  it("filters a streamed reply even when a tag is split across deltas", () => {
    const f = new YourTurnSpeechFilter();
    const deltas = ["Foxes dig. <you", "r-turn>Can a pig", " dig?</your-t", "urn> Bye."];
    const out = deltas.map((d) => f.push(d)).join("") + f.flush();
    expect(out).toBe("Foxes dig.  Bye.");
  });

  it("lets a '<' that never becomes a tag through on flush", () => {
    const f = new YourTurnSpeechFilter();
    expect(f.push("3 <")).toBe("3 ");
    expect(f.push(" 5")).toBe("< 5");
    const g = new YourTurnSpeechFilter();
    g.push("x <yo");
    expect(g.flush()).toBe("<yo");
  });
});

describe("decodability", () => {
  const alpha = beginnerAlphabet(["ck", "sh", "SH", "x1", "e"]);

  it("keeps only valid letter teams from the inventory", () => {
    expect(alpha.teams).toEqual(["ck", "sh"]);
  });

  it("accepts short-a/short-i words and inventory teams, rejects other vowels", () => {
    expect(isDecodableWord("pig", alpha)).toBe(true);
    expect(isDecodableWord("Can", alpha)).toBe(true);
    expect(isDecodableWord("fish", alpha)).toBe(true);
    expect(isDecodableWord("kick", alpha)).toBe(true);
    expect(isDecodableWord("fox", alpha)).toBe(false); // o, x
    expect(isDecodableWord("rock", alpha)).toBe(false); // o
    expect(isDecodableWord("the", alpha)).toBe(false); // e
    expect(isDecodableWord("it's", alpha)).toBe(false);
    expect(isDecodableWord("10", alpha)).toBe(false);
  });

  it("rejects the words the playtest caught (phonics, not just letters)", () => {
    const floor = beginnerAlphabet([]);
    expect(isDecodableWord("shark", alpha)).toBe(false); // ar, even with sh known
    expect(isDecodableWord("lava", floor)).toBe(false); // two vowels, open a
    expect(isDecodableWord("bang", floor)).toBe(false); // ng
    expect(isDecodableWord("with", floor)).toBe(false); // th
    expect(isDecodableWord("with", beginnerAlphabet(["th"]))).toBe(true);
    expect(isDecodableWord("fish", floor)).toBe(false); // sh not known
    expect(isDecodableWord("kick", floor)).toBe(false); // ck not known
  });

  it("is conservative about the sound of a and c", () => {
    const floor = beginnerAlphabet([]);
    expect(isDecodableWord("was", floor)).toBe(false);
    expect(isDecodableWord("ball", floor)).toBe(false);
    expect(isDecodableWord("hi", floor)).toBe(false); // open syllable
    expect(isDecodableWord("rabbit", floor)).toBe(false); // two syllables
    expect(isDecodableWord("rain", floor)).toBe(false); // vowel team
    expect(isDecodableWord("hiss", floor)).toBe(true);
    expect(isDecodableWord("is", floor)).toBe(true);
    expect(isDecodableWord("a", floor)).toBe(true);
    expect(isDecodableWord("I", floor)).toBe(true);
  });

  it("rejects long-i, silent-letter and soft-g traps", () => {
    const floor = beginnerAlphabet([]);
    for (const w of ["kind", "find", "wild", "calm", "half", "lamb", "sign", "gin", "salt", "want"]) {
      expect(isDecodableWord(w, floor)).toBe(false);
    }
    expect(isDecodableWord("big", floor)).toBe(true);
    expect(isDecodableWord("tin", floor)).toBe(true);
  });

  it("accepts words built from known teams that contain a tricky spelling", () => {
    expect(isDecodableWord("catch", beginnerAlphabet(["tch"]))).toBe(true);
    expect(isDecodableWord("high", beginnerAlphabet(["igh"]))).toBe(true);
    expect(isDecodableWord("air", beginnerAlphabet(["air"]))).toBe(true);
    expect(isDecodableWord("chair", beginnerAlphabet(["ch", "air"]))).toBe(true);
    // a known team doesn't excuse the same letters elsewhere
    expect(isDecodableWord("chat", beginnerAlphabet(["tch"]))).toBe(false);
  });

  it("lets a vowel team in the inventory carry its vowel", () => {
    const withEe = beginnerAlphabet(["ee"]);
    expect(isDecodableWord("see", withEe)).toBe(true);
    expect(isDecodableWord("set", withEe)).toBe(false);
  });

  it("checks a whole line: every word, and length", () => {
    expect(checkDecodable("Can a pig dig in a pit?", alpha)).toMatchObject({
      ok: true,
      words: 7,
    });
    expect(checkDecodable("Can a fox sit on a rock?", alpha)).toMatchObject({
      ok: false,
      undecodable: ["fox", "on", "rock"],
    });
    expect(
      checkDecodable("A big pig can sit and dig and sit and dig", alpha),
    ).toMatchObject({ ok: false, tooLong: true });
    expect(checkDecodable("  ", alpha).ok).toBe(false);
  });
});

describe("word timing", () => {
  it("tokenises past punctuation, markdown and emoji", () => {
    expect(wordTokens("**Big** pig! 🐷 It's").map((t) => t.key)).toEqual([
      "big",
      "pig",
      "it's",
    ]);
  });

  it("gives longer words and pauses a bigger share of the clip", () => {
    const s = wordStartFractions("A hippopotamus sat. Then a cat.");
    expect(s[0]).toBe(0);
    // "hippopotamus" (5 syllables) takes far more room than "A"
    expect(s[2] - s[1]).toBeGreaterThan(3 * (s[1] - s[0]));
    // "sat" + the sentence-end pause outlasts "a" (same syllables, no pause)
    expect(s[3] - s[2]).toBeGreaterThan(s[5] - s[4]);
    expect(s.every((x, i) => i === 0 || x > s[i - 1])).toBe(true);
    expect(s[s.length - 1]).toBeLessThan(1);
  });

  it("maps the player clock to a word, ignoring the lead-in silence", () => {
    const u = "Can a pig dig?";
    expect(wordIndexAt(u, 0.05, 2)).toBeNull();
    expect(wordIndexAt(u, 0.15, 2)).toBe(0);
    expect(wordIndexAt(u, 1.75, 2)).toBe(3);
    expect(wordIndexAt(u, 1, 0)).toBeNull();
    expect(wordIndexAt("🐷", 1, 2)).toBeNull();
  });

  it("finds a spoken sentence inside its message", () => {
    expect(locateUtterance(["a", "b", "c", "b", "c"], ["b", "c"])).toBe(1);
    expect(locateUtterance(["a", "b", "c", "b", "c"], ["b", "c"], 2)).toBe(3);
    expect(locateUtterance(["a"], ["z"])).toBe(-1);
    expect(locateUtterance(["a"], [])).toBe(-1);
  });

  it("lights a repeated sentence at its own place, moving forward", () => {
    const message = "Dig a pit. Dig a pit. Then nap.";
    expect(spokenWordInMessage(message, "Dig a pit.", 0.15, 2, 0)).toMatchObject({ index: 0, end: 3 });
    expect(spokenWordInMessage(message, "Dig a pit.", 0.15, 2, 3)).toMatchObject({ index: 3, end: 6 });
  });

  it("skips a list number that speech dropped", () => {
    const message = "1. Mix the dough. 2. Bake it.";
    expect(alignUtterance(wordTokens(message).map((t) => t.key), ["mix", "the", "dough", "bake", "it"]))
      .toEqual([1, 2, 3, 5, 6]);
  });

  it("lights the message word the voice is on", () => {
    const message = "Foxes dig dens. **Dens** keep them cool!";
    // second sentence, spoken alone (markdown already stripped by the voice)
    expect(spokenWordInMessage(message, "Dens keep them cool!", 0.15, 2)?.index).toBe(3);
    expect(spokenWordInMessage(message, "Not in here.", 0.5, 2)).toBeNull();
  });
});

describe("wordRuns", () => {
  it("cuts colored segments at word boundaries and tags each word", () => {
    const runs = wordRuns([
      { text: "a fi" },
      { text: "sh", team: "sh", stage: "training" },
      { text: " dig." },
    ]);
    expect(runs).toEqual([
      { text: "a", word: 0 },
      { text: " ", word: null },
      { text: "fi", word: 1 },
      { text: "sh", word: 1, team: "sh", stage: "training" },
      { text: " ", word: null },
      { text: "dig", word: 2 },
      { text: ".", word: null },
    ]);
    expect(runs.map((r) => r.text).join("")).toBe("a fish dig.");
  });
});

describe("partSpans", () => {
  it("keeps a part's spans and shifts them onto the part", () => {
    const reply = "Fish!\n<your-turn>A ship</your-turn>";
    const [text, line] = splitYourTurn(reply);
    const spans = [
      { start: 2, end: 4, team: "sh" }, // Fi[sh]
      { start: 19, end: 21, team: "sh" }, // A [sh]ip
      { start: 8, end: 10, team: "ou" }, // inside the tag: dropped
    ];
    expect(partSpans(text, spans)).toEqual([{ start: 2, end: 4, team: "sh" }]);
    expect(partSpans(line, spans)).toEqual([{ start: 2, end: 4, team: "sh" }]);
    expect(line.text.slice(2, 4)).toBe("sh");
  });
});

describe("your-turn line capture and cue", () => {
  it("collects the lines a streamed reply carried, even split across deltas", () => {
    const f = new YourTurnSpeechFilter();
    ["Dig! <your-t", "urn>Can a pi", "g dig?</your-turn> Bye."].forEach((d) => f.push(d));
    f.flush();
    expect(f.lines).toEqual(["Can a pig dig?"]);
    const g = new YourTurnSpeechFilter();
    g.push("Hi <your-turn>A cat");
    g.flush();
    expect(g.lines).toEqual(["A cat"]);
  });

  it("picks a stable cue per line from the fixed set", () => {
    const cue = yourTurnCue("Can a pig dig?");
    expect(YOUR_TURN_CUES).toContain(cue);
    expect(yourTurnCue("Can a pig dig?")).toBe(cue);
    const seen = new Set(
      ["A cat sat.", "Pigs dig.", "Is it big?", "Kits nap.", "A rat ran."].map(yourTurnCue),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("finds the line a reply asks the child to read", () => {
    expect(lastYourTurnLine("Hi.\n<your-turn>Can a pig dig?</your-turn>")).toBe(
      "Can a pig dig?",
    );
    expect(lastYourTurnLine("No line here.")).toBeNull();
  });
});

describe("compareReading", () => {
  it("counts a clean read as all matched, whatever the case and punctuation", () => {
    expect(compareReading("Can a pig dig?", "can a pig dig")).toMatchObject({
      words: 4,
      matched: 4,
      misses: [],
    });
  });

  it("pairs a misread word with what was heard in its place", () => {
    expect(compareReading("Can a pig dig?", "Can a big dig?")).toMatchObject({
      words: 4,
      matched: 3,
      misses: [{ word: "pig", heard: "big" }],
    });
  });

  it("reports a skipped word without a pair, and ignores extra words", () => {
    expect(compareReading("A cat sat in a pit.", "um a cat sat in pit")).toMatchObject({
      words: 6,
      matched: 5,
      misses: [{ word: "a" }],
    });
  });

  it("handles an empty transcript", () => {
    expect(compareReading("Kits nap.", "")).toMatchObject({
      words: 2,
      matched: 0,
      misses: [{ word: "Kits" }, { word: "nap" }],
    });
  });
});

describe("compareReading — was it a real try?", () => {
  it("a refusal that shares a word with the line is not an attempt", () => {
    const check = compareReading("Can I sip it?", "um I can't read that");
    expect(check.attempted).toBe(false);
  });

  it("refusals (straight or curly) and silence are not attempts", () => {
    expect(compareReading("Can a pig dig?", "i don't know").attempted).toBe(false);
    expect(compareReading("Can a pig dig?", "I don’t know").attempted).toBe(false);
    expect(compareReading("Can a pig dig?", "I can’t read that").attempted).toBe(false);
    expect(compareReading("Can a pig dig?", "help").attempted).toBe(false);
    expect(compareReading("Can a pig dig?", "").attempted).toBe(false);
  });

  it("a misread is an attempt, with the missed word placed positionally", () => {
    expect(compareReading("It is big.", "it is pig")).toMatchObject({
      attempted: true,
      matched: 2,
      misses: [{ word: "big", heard: "pig" }],
    });
    expect(compareReading("Tap a lip!", "tap a lid")).toMatchObject({
      attempted: true,
      misses: [{ word: "lip", heard: "lid" }],
    });
    expect(compareReading("A pig!", "a big")).toMatchObject({
      attempted: true,
      misses: [{ word: "pig", heard: "big" }],
    });
    // only one of three "dig"s was missed
    expect(compareReading("Dig, dig, dig!", "dig dig")).toMatchObject({
      matched: 2,
      misses: [{ word: "dig" }],
    });
    expect(compareReading("Can a pig dig?", "um a").attempted).toBe(true);
  });

  it("a real try with a slip is still an attempt", () => {
    expect(compareReading("Can a pig dig?", "can a big dig").attempted).toBe(true);
    expect(compareReading("Can a pig dig?", "can a pig").attempted).toBe(true);
    expect(compareReading("A big cat sat.", "a big cat sat").attempted).toBe(true);
  });

  it("a refusal word that is part of the line doesn't count against it", () => {
    expect(compareReading("Help a cat!", "help a cat").attempted).toBe(true);
  });
});

describe("beginnerDisplay", () => {
  it("drops markdown markers and keeps the words", () => {
    expect(beginnerDisplay("A **big** cat and *a* pig.").text).toBe("A big cat and a pig.");
    expect(beginnerDisplay("# Pigs\n- dig\n`sit`").text).toBe("Pigs\ndig\nsit");
  });

  it("drops a lone emoji but keeps a counting row", () => {
    expect(beginnerDisplay("Catch the 🧊 ice!").text).toBe("Catch the ice!");
    expect(beginnerDisplay("Count them: 🍪🍪🍪").text).toBe("Count them: 🍪🍪🍪");
    expect(beginnerDisplay("Hi 👋🏽 there").text).toBe("Hi there");
  });

  it("maps spans from the raw text onto what is shown", () => {
    const raw = "A **fish** can 🐟 swish.";
    const { text, map } = beginnerDisplay(raw);
    expect(text).toBe("A fish can swish.");
    const spans = mapSpans(
      [
        { start: 6, end: 8, team: "sh" }, // fi[sh]
        { start: raw.indexOf("swish") + 3, end: raw.indexOf("swish") + 5, team: "sh" },
      ],
      map,
    );
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["sh", "sh"]);
  });
});

describe("who gets read-along and bigger text", () => {
  it("highlight and tap-a-word apply to listener and beginner, not reader", () => {
    expect(readsAlong("listener")).toBe(true);
    expect(readsAlong("beginner")).toBe(true);
    expect(readsAlong("reader")).toBe(false);
    expect(readsAlong(undefined)).toBe(false);
    expect(readsAlong(null)).toBe(false);
  });

  it("listener text is two steps larger, beginner one, reader none", () => {
    expect(conversationTextSteps("listener")).toBe(2);
    expect(conversationTextSteps("beginner")).toBe(1);
    expect(conversationTextSteps("reader")).toBe(0);
    expect(conversationTextSteps(undefined)).toBe(0);
  });
});
