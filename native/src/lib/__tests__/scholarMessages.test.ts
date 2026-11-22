import { describe, expect, it } from "vitest";

import type { Id } from "@/lib/convex";
import {
  attachmentsByMessage,
  teamStarterLine,
  threadSubtitle,
  ideaPreview,
  kindFilterFrom,
  mergeThreadLists,
  pickedPhotoFileName,
  previewLine,
  splitThreadSections,
  teamStartedWorkshopThreads,
  threadHeadline,
  type ScholarThreadAttachment,
  type ScholarThreadSummary,
} from "../scholarMessages";

function summary(over: Partial<ScholarThreadSummary>): ScholarThreadSummary {
  return {
    _id: "t1" as Id<"parentThreads">,
    flavor: "general",
    kind: "mentor",
    title: "Pat Rivera",
    suggestionTitle: null,
    suggestionId: null,
    scholarId: "u1" as Id<"users">,
    scholarName: "Test Scholar",
    staffParticipants: [],
    lastMessagePreview: "",
    lastMessageAuthorName: null,
    lastMessageAt: 0,
    startedByStaff: false,
    topic: null,
    startedByName: null,
    unread: false,
    ...over,
  };
}

describe("thread copy", () => {
  it("gives a general thread no subtitle and a Workshop thread its idea", () => {
    expect(threadSubtitle({ flavor: "general", suggestion: null })).toBeNull();
    expect(threadSubtitle({ flavor: "workshop", suggestion: { title: "Text color" } })).toBe(
      "Text color",
    );
    expect(threadSubtitle({ flavor: "workshop", suggestion: null })).toBeNull();
  });
});

describe("previews", () => {
  it("prefixes the author and collapses whitespace", () => {
    expect(previewLine("You", "yay\n thank you!!")).toBe("You: yay thank you!!");
    expect(previewLine(null, "hello")).toBe("hello");
    expect(previewLine("Pat", "   ")).toBe("");
  });

  it("says You for the scholar's own last message on an idea card", () => {
    expect(ideaPreview({ authorName: "Test Scholar", body: "ok", mine: true })).toBe("You: ok");
    expect(ideaPreview({ authorName: "Pat Rivera", body: "Found it", mine: false })).toBe(
      "Pat Rivera: Found it",
    );
    expect(ideaPreview(null)).toBe("");
  });

  it("bylines a team-started card with who opened it, else the team", () => {
    expect(teamStarterLine("Pat Rivera")).toBe("From Pat Rivera");
    expect(teamStarterLine(null)).toBe("From the Rabbithole team");
    expect(teamStarterLine("  ")).toBe("From the Rabbithole team");
  });
});

describe("thread list", () => {
  it("puts people before Workshop, keeping server order within each", () => {
    const a = summary({ _id: "a" as Id<"parentThreads">, flavor: "workshop", kind: "workshop" });
    const b = summary({ _id: "b" as Id<"parentThreads">, flavor: "general", kind: "mentor" });
    const c = summary({ _id: "c" as Id<"parentThreads">, flavor: "workshop", kind: "workshop" });
    const { people, workshop } = splitThreadSections([a, b, c]);
    expect(people.map((t) => t._id)).toEqual(["b"]);
    expect(workshop.map((t) => t._id)).toEqual(["a", "c"]);
  });

  it("titles a Workshop row by its idea, then its topic", () => {
    expect(threadHeadline(summary({ flavor: "workshop", kind: "workshop", suggestionTitle: "Text color" }))).toBe(
      "Text color",
    );
    expect(threadHeadline(summary({ flavor: "workshop", kind: "workshop", topic: "About your report" }))).toBe(
      "About your report",
    );
    expect(threadHeadline(summary({ flavor: "general", kind: "mentor" }))).toBe("Pat Rivera");
  });

  it("finds only team-started Workshop threads with no idea behind them", () => {
    const team = summary({ flavor: "workshop", kind: "workshop", startedByStaff: true, topic: "Hi" });
    const idea = summary({
      flavor: "workshop",
      kind: "workshop",
      suggestionId: "s1" as Id<"scholarSuggestions">,
    });
    const mentor = summary({ flavor: "general", kind: "mentor", startedByStaff: true });
    expect(teamStartedWorkshopThreads([team, idea, mentor])).toEqual([team]);
    expect(teamStartedWorkshopThreads(undefined)).toEqual([]);
  });
});

describe("attachments", () => {
  it("groups attachments under their message", () => {
    const att = (id: string, messageId: string): ScholarThreadAttachment => ({
      _id: id as Id<"parentMessageAttachments">,
      messageId: messageId as Id<"parentMessages">,
      fileName: `${id}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 10,
      url: null,
      withdrawn: false,
      retracted: false,
      canRetract: false,
    });
    const map = attachmentsByMessage([att("x", "m1"), att("y", "m2"), att("z", "m1")]);
    expect(map.get("m1" as Id<"parentMessages">)?.map((a) => a._id)).toEqual(["x", "z"]);
    expect(map.get("m2" as Id<"parentMessages">)?.length).toBe(1);
  });

  it("names a picked photo so its extension matches the uploaded mime", () => {
    expect(pickedPhotoFileName(null, "image/jpeg", 5)).toBe("photo-5.jpg");
    expect(pickedPhotoFileName("IMG_0001.HEIC", "image/jpeg", 5)).toBe("IMG_0001.jpg");
    expect(pickedPhotoFileName("tank.png", "image/png", 5)).toBe("tank.png");
  });
});

describe("kind filter", () => {
  it("reads ?kind= leniently, defaulting to all", () => {
    expect(kindFilterFrom("workshop")).toBe("workshop");
    expect(kindFilterFrom("people")).toBe("people");
    // The People filter's old name, from older links.
    expect(kindFilterFrom("mentor")).toBe("people");
    expect(kindFilterFrom("family")).toBe("all");
    expect(kindFilterFrom(undefined)).toBe("all");
  });
});

describe("about threads", () => {
  const wonder = summary({
    _id: "w" as Id<"parentThreads">,
    flavor: "about",
    kind: "about",
    title: "Your teachers",
    about: { type: "wonder", seedId: "s1" as Id<"seeds"> },
    aboutTitle: "Why do owls turn their heads so far?",
    lastMessageAt: 20,
  });

  it("heads an about row with its subject and sorts it into its own section", () => {
    expect(threadHeadline(wonder)).toBe("Why do owls turn their heads so far?");
    expect(threadHeadline({ ...wonder, aboutTitle: undefined })).toBe("Your teachers");
    expect(splitThreadSections([wonder]).about).toEqual([wonder]);
  });

  it("names the subject at the top of the open thread", () => {
    expect(
      threadSubtitle({
        flavor: "about",
        suggestion: null,
        about: { type: "quest" },
        aboutTitle: "Angle croc",
      }),
    ).toBe("About your Quest · Angle croc");
    expect(threadSubtitle({ flavor: "about", suggestion: null, about: { type: "wonder" } })).toBe(
      "About your wonder",
    );
  });

  it("merges the plain and about lists newest first", () => {
    const mentor = summary({ _id: "m" as Id<"parentThreads">, lastMessageAt: 10 });
    expect(mergeThreadLists([mentor], [wonder]).map((t) => t._id)).toEqual(["w", "m"]);
  });
});
