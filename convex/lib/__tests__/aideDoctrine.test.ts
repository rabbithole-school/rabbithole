import { describe, it, expect } from "vitest";
import {
  audienceFromSlackSurface,
  audienceLabel,
  audienceContextLine,
  isPrivateAudience,
  AUDIENCE_DISCLOSURE_DOCTRINE,
  MULTI_PARTY_ETIQUETTE,
} from "../aideAudience";
import {
  SCHOLAR_RECORDS_DOCTRINE,
  SCHOLAR_DOSSIER_DOCTRINE,
  STAFF_SCHOLAR_RECORDS_SECTION,
} from "../staffRecordsDoctrine";
import { buildSlackStaticPrompt } from "../../slackBot";
import { buildCurriculumAssistantSystemPrompt } from "../../http";
import { buildUnitDesignerSystemText } from "../../unitDesignerStream";

describe("audience axis", () => {
  it("maps every Slack surface onto the shared axis", () => {
    expect(audienceFromSlackSurface("dm")).toBe("private");
    expect(audienceFromSlackSurface("mpim")).toBe("group");
    expect(audienceFromSlackSurface("channel")).toBe("open");
  });

  // A group DM is deliberately NOT private: its members were chosen for one
  // conversation, not vetted for a child's record. `writeSurfaceFor` already
  // gates on that; the prose must not contradict it.
  it("treats a group DM as not private", () => {
    expect(isPrivateAudience(audienceFromSlackSurface("mpim"))).toBe(false);
    expect(isPrivateAudience(audienceFromSlackSurface("dm"))).toBe(true);
    expect(isPrivateAudience(audienceFromSlackSurface("channel"))).toBe(false);
  });

  it("names the audience in one per-turn line", () => {
    expect(audienceContextLine("open")).toBe(
      `Audience: this is ${audienceLabel("open")}.`,
    );
    expect(audienceContextLine("private")).toContain("one-to-one");
  });

  // The regression this whole module exists for: an open-ended "be careful
  // with sensitive data in public" is what let the model extend caution to
  // cognitive assessment scores on its own. The list must be stated as closed.
  it("states the restricted list as closed and non-extensible", () => {
    expect(AUDIENCE_DISCLOSURE_DOCTRINE).toContain("CLOSED list");
    expect(AUDIENCE_DISCLOSURE_DOCTRINE).toContain("That list is COMPLETE.");
    expect(AUDIENCE_DISCLOSURE_DOCTRINE).toContain("Do NOT extend it by analogy");
  });

  it("separates whether you may read from where you may say it", () => {
    expect(AUDIENCE_DISCLOSURE_DOCTRINE).toContain(
      "Audience never changes WHETHER you may read something",
    );
  });

  it("scopes bystander etiquette to multi-party conversations", () => {
    expect(MULTI_PARTY_ETIQUETTE).toContain("group or open conversation");
    expect(MULTI_PARTY_ETIQUETTE).toContain(
      "In a one-to-one conversation every turn is yours",
    );
  });
});

describe("staff scholar-records doctrine", () => {
  it("legitimizes the reads the tools already authorize", () => {
    expect(SCHOLAR_RECORDS_DOCTRINE).toContain("normal, expected staff work");
    expect(SCHOLAR_RECORDS_DOCTRINE).toContain("Cross-scholar reads are legitimate");
    expect(SCHOLAR_RECORDS_DOCTRINE).toContain(
      "A tool you HAVE is a tool this person is authorized to use",
    );
  });

  it("forbids the model authoring its own access policy", () => {
    expect(SCHOLAR_RECORDS_DOCTRINE).toContain("Do NOT invent an access policy of your own");
    expect(SCHOLAR_RECORDS_DOCTRINE).toContain("relay its refusal");
  });

  it("keeps uploaded assessments as real evidence", () => {
    expect(SCHOLAR_DOSSIER_DOCTRINE).toContain("cognitive assessments");
    expect(SCHOLAR_DOSSIER_DOCTRINE).toContain("real profile evidence");
  });
});

// The incident in one assertion: three surfaces claim to be the same assistant
// over the same tools, and one of them silently lacked the legitimacy half of
// the doctrine while carrying all of the caution. Whatever else diverges
// between these prompts, this must not.
describe("every staff aide surface carries both halves", () => {
  const prompts: Array<[string, string]> = [
    ["slack", buildSlackStaticPrompt()],
    ["in-app", buildCurriculumAssistantSystemPrompt()],
    ["unit designer", buildUnitDesignerSystemText("", "teacher")],
  ];

  it.each(prompts)("%s states the records doctrine", (_name, prompt) => {
    expect(prompt).toContain(STAFF_SCHOLAR_RECORDS_SECTION);
  });

  it.each(prompts)("%s states the audience doctrine", (_name, prompt) => {
    expect(prompt).toContain(AUDIENCE_DISCLOSURE_DOCTRINE);
  });

  // Deduped, not merely added: the drifting hand-written copies are gone.
  it.each(prompts)("%s states the dossier doctrine exactly once", (_name, prompt) => {
    const occurrences = prompt.split(SCHOLAR_DOSSIER_DOCTRINE).length - 1;
    expect(occurrences).toBe(1);
  });
});

// A group DM is not uniformly non-private: `guardianFormAnswersSurface` counts
// a deliberately-composed one as private, and the form tools ship names + a CSV
// there today. The doctrine must not tell the model to refuse what the tool is
// configured to allow — that is the same prose-vs-gate divergence this whole
// change exists to close, just pointing the other way.
describe("doctrine defers to the tool on each item's boundary", () => {
  it("does not claim a blanket one-to-one requirement", () => {
    expect(AUDIENCE_DISCLOSURE_DOCTRINE).toContain("For (1)–(4) the boundary is the TOOL's to decide");
    expect(AUDIENCE_DISCLOSURE_DOCTRINE).toContain(
      "form names and answers deliberately count a composed private group DM as private",
    );
    expect(AUDIENCE_DISCLOSURE_DOCTRINE).toContain("If it answers, that answer was authorized");
  });

  // Item (5) is the one restriction with no tool behind it: it governs what the
  // model VOLUNTEERS, and the read tools never learn which room they are
  // speaking into. Blanket tool-deference would have silently deleted it.
  it("keeps the one prompt-only item out of tool deference", () => {
    expect(AUDIENCE_DISCLOSURE_DOCTRINE).toContain(
      "(5) is different, and it is yours to hold: no tool can enforce it",
    );
  });
});
