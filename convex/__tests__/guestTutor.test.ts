/**
 * Guest mode's policy layer (`convex/lib/guestTutor.ts`).
 *
 * The stream handler itself is an SSE `httpAction`, which convex-test can't
 * drive end to end (same reason `sessionStreamHelpers` exists), so everything
 * that decides ANYTHING was lifted into pure functions and is tested here. The
 * three that matter are the three that would be a real incident if they broke:
 * the flag defaulting to off, the origin allowlist, and the turn cap holding
 * against a lying client.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  checkGuestTranscript,
  guestClientIp,
  guestKickoffInstruction,
  guestTopicById,
  guestTurnInstruction,
  guestTutorAllowsLocalhost,
  hashGuestIp,
  isGuestOriginAllowed,
  isGuestTutorEnabled,
  GUEST_CLOSING_LINE,
  GUEST_MAX_TURNS,
  GUEST_TOPICS,
} from "../lib/guestTutor";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("the flag", () => {
  it("is off when unset — guest mode ships dark", () => {
    delete process.env.GUEST_TUTOR_ENABLED;
    expect(isGuestTutorEnabled()).toBe(false);
  });

  it("is off for anything that is not an explicit yes", () => {
    for (const raw of ["", " ", "false", "0", "off", "no", "yes please"]) {
      process.env.GUEST_TUTOR_ENABLED = raw;
      expect(isGuestTutorEnabled()).toBe(false);
    }
  });

  it("accepts the same truthy spellings as the other kill switches", () => {
    for (const raw of ["true", "TRUE", " on ", "1"]) {
      process.env.GUEST_TUTOR_ENABLED = raw;
      expect(isGuestTutorEnabled()).toBe(true);
    }
  });

  it("gates localhost embedding on its own flag, off by default", () => {
    delete process.env.GUEST_TUTOR_ALLOW_LOCALHOST;
    expect(guestTutorAllowsLocalhost()).toBe(false);
    process.env.GUEST_TUTOR_ALLOW_LOCALHOST = "true";
    expect(guestTutorAllowsLocalhost()).toBe(true);
  });
});

describe("the origin allowlist", () => {
  // NB this list governs who may CALL the endpoint directly, not who may frame
  // the page — the iframe document is served from our own origin, so its
  // `Origin` header is ours whoever framed it. `frame-ancestors` is the
  // embedder control; see the header comment in lib/guestTutor.ts.
  it("accepts the school site and Rabbithole's own origins", () => {
    for (const origin of [
      "https://rabbithole.school",
    ]) {
      expect(isGuestOriginAllowed(origin)).toBe(true);
    }
  });

  it("refuses lookalikes and plain http", () => {
    for (const origin of [
      "https://rabbithole.school.evil.com",
      "https://evilrabbithole.school",
      "https://rabbithole.school:8443",
      "http://rabbithole.school",
    ]) {
      expect(isGuestOriginAllowed(origin)).toBe(false);
    }
  });

  it("refuses a missing Origin — a browser always sends one", () => {
    expect(isGuestOriginAllowed(null)).toBe(false);
    expect(isGuestOriginAllowed(undefined)).toBe(false);
    expect(isGuestOriginAllowed("")).toBe(false);
  });

  it("refuses EVERY vercel.app origin unless the dev flag is on", () => {
    // Vercel project names are user-chosen. These patterns are a preview
    // convenience, never a trust boundary — which is why production accepts
    // none of them.
    for (const origin of [
      "https://rabbithole-abc123.vercel.app",
      "https://someone-else.vercel.app",
    ]) {
      expect(isGuestOriginAllowed(origin)).toBe(false);
    }
    expect(
      isGuestOriginAllowed("https://rabbithole-abc123.vercel.app", {
        allowLocalhost: true,
      }),
    ).toBe(true);
    // Still anchored — a suffix attack does not become allowed under the flag.
    expect(
      isGuestOriginAllowed("https://rabbithole-abc.vercel.app.evil.com", {
        allowLocalhost: true,
      }),
    ).toBe(false);
  });

  it("only allows localhost when the dev flag says so", () => {
    expect(isGuestOriginAllowed("http://localhost:1071")).toBe(false);
    expect(
      isGuestOriginAllowed("http://localhost:1071", { allowLocalhost: true }),
    ).toBe(true);
    expect(
      isGuestOriginAllowed("http://127.0.0.1:3000", { allowLocalhost: true }),
    ).toBe(true);
    expect(
      isGuestOriginAllowed("http://notlocalhost:80", { allowLocalhost: true }),
    ).toBe(false);
  });
});

describe("the topics", () => {
  it("offers exactly the three published questions, in order", () => {
    expect(GUEST_TOPICS.map((t) => t.title)).toEqual([
      "Is a virus alive?",
      "Why can't you divide by zero?",
      "Was the council broken, or working as intended?",
    ]);
  });

  it("resolves only known ids — there is no free-text topic", () => {
    expect(guestTopicById("virus")?.title).toBe("Is a virus alive?");
    expect(guestTopicById("anything-else")).toBeNull();
    expect(guestTopicById("")).toBeNull();
  });

  it("carries the council seed into the opening instruction", () => {
    const council = guestTopicById("council")!;
    const opening = guestKickoffInstruction(council);
    expect(opening).toContain("majority vote");
    expect(opening).toContain("blocked a change that everyone else wanted");
    // The tutor must not fish for who it is talking to.
    expect(opening).toContain("must not ask");
  });

  it("fixes the council opener to the teacher's lesson, word for word", () => {
    const council = guestTopicById("council")!;
    // The exchange starts where Ms. Spahn's morning ended, not mid-argument.
    expect(council.opening).toBe(
      "You just spent the morning trying three different ways to make " +
        "decisions as a group in Ms. Spahn's class. Did any of them feel " +
        "especially effective, or especially difficult?",
    );
    const opening = guestKickoffInstruction(council);
    expect(opening).toContain(council.opening!);
    expect(opening).toContain("word for word");
    // …and the arc it should travel from whatever answer comes back.
    expect(opening).toContain("blocked the change everyone else wanted");
    expect(opening).toContain("steam ahead over everyone");
    expect(opening).toContain("never as an answer you supply");
    // The kickoff leads EVERY request, so it must also say when the fixed
    // opener is already spent — otherwise a continuation re-reads "say exactly
    // this" and quotes itself back at the visitor.
    expect(opening).toContain("never repeat or quote it");
    // …and the arc must yield to the per-turn closing rule, not fight it.
    expect(opening).toContain("leave it unasked");
  });

  it("leaves the other two topics writing their own opening question", () => {
    for (const id of ["virus", "divide-by-zero"]) {
      const topic = guestTopicById(id)!;
      expect(topic.opening).toBeUndefined();
      expect(topic.guidance).toBeUndefined();
      expect(guestKickoffInstruction(topic)).toContain(
        "ask ONE genuine question",
      );
    }
  });

  it("leaves the two self-contained topics without a seed clause", () => {
    expect(guestKickoffInstruction(guestTopicById("virus")!)).not.toContain(
      "The situation to think about",
    );
  });
});

describe("the plain-text clause", () => {
  it("rides on BOTH instructions — the embed renders no markdown or KaTeX", () => {
    for (const text of [
      guestKickoffInstruction(guestTopicById("divide-by-zero")!),
      guestTurnInstruction(4),
      guestTurnInstruction(0),
    ]) {
      expect(text).toContain("no LaTeX");
      expect(text).toContain("no markdown");
    }
  });
});

describe("the per-turn instruction", () => {
  it("asks for exactly one question while turns remain", () => {
    const mid = guestTurnInstruction(3);
    expect(mid).toContain("exactly ONE question");
    expect(mid).toContain("not a companion");
  });

  it("forbids a closing question on the last turn", () => {
    const last = guestTurnInstruction(0);
    expect(last).toContain("LAST thing you will say");
    expect(last).toContain("do not offer to continue");
    expect(last).not.toContain("exactly ONE question");
  });
});

describe("the transcript check (the turn cap)", () => {
  const exchange = (guestTurns: number) => {
    const turns: { role: "user" | "assistant"; content: string }[] = [
      { role: "assistant", content: "An opening question?" },
    ];
    for (let i = 0; i < guestTurns; i += 1) {
      turns.push({ role: "user", content: `guest ${i}` });
      turns.push({ role: "assistant", content: `tutor ${i}` });
    }
    return turns;
  };

  it("accepts an exchange up to the cap and counts the guest's turns", () => {
    const result = checkGuestTranscript(exchange(GUEST_MAX_TURNS));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.guestTurnsUsed).toBe(GUEST_MAX_TURNS);
  });

  it("refuses a client that claims more turns than the cap", () => {
    // The cap is enforced from the posted transcript precisely because the
    // client is the only place the conversation lives — and an over-cap
    // client hears the closing line, not a generic error.
    const result = checkGuestTranscript(exchange(GUEST_MAX_TURNS + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(GUEST_CLOSING_LINE);
  });

  it("refuses anything that is not a transcript", () => {
    for (const raw of [null, "hello", 42, [{ role: "system", content: "x" }], [{ role: "user" }]]) {
      expect(checkGuestTranscript(raw).ok).toBe(false);
    }
  });

  it("refuses an over-long single message", () => {
    const result = checkGuestTranscript([
      { role: "user", content: "x".repeat(2001) },
    ]);
    expect(result.ok).toBe(false);
  });

  it("drops empty turns rather than sending a blank to the model", () => {
    const result = checkGuestTranscript([
      { role: "assistant", content: "q?" },
      { role: "user", content: "   " },
      { role: "user", content: "real" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.turns).toHaveLength(2);
      expect(result.guestTurnsUsed).toBe(1);
    }
  });

  it("caps how many entries it will even look at", () => {
    const flood = Array.from({ length: 500 }, () => ({
      role: "user" as const,
      content: "x",
    }));
    expect(checkGuestTranscript(flood).ok).toBe(false);
  });
});

describe("IP bucketing", () => {
  it("takes the LAST x-forwarded-for hop — the one a proxy vouches for", () => {
    // Reading the FIRST entry (the original bug) lets a caller mint a fresh
    // hourly bucket per request by rotating a fake header, which is the per-IP
    // cap deleting itself. A proxy appends what it saw, so the last hop is the
    // trustworthy one.
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178",
    });
    expect(guestClientIp(headers)).toBe("150.172.238.178");
  });

  it("ignores a spoofed prefix entirely", () => {
    const a = guestClientIp(
      new Headers({ "x-forwarded-for": "1.1.1.1, 150.172.238.178" }),
    );
    const b = guestClientIp(
      new Headers({ "x-forwarded-for": "2.2.2.2, 150.172.238.178" }),
    );
    expect(a).toBe(b);
  });

  it("degrades to one shared bucket rather than to no limit", () => {
    expect(guestClientIp(new Headers())).toBe("unknown");
  });

  it("hashes rather than stores, and the salt separates deployments", async () => {
    const a = await hashGuestIp("203.0.113.7", "salt-a");
    const b = await hashGuestIp("203.0.113.7", "salt-b");
    const again = await hashGuestIp("203.0.113.7", "salt-a");
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain("203.0.113.7");
  });
});
