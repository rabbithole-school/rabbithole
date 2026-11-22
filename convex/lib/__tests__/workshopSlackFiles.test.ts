import { describe, expect, test } from "vitest";
import { isSupportedMessageAttachment } from "../../../shared/messageAttachments";
import {
  emptyReplyNotice,
  messageBudgetRefusal,
  screenWorkshopReplyFile,
  skippedFilesNotice,
  storedMimeType,
  workshopFileName,
  type WorkshopReplyFile,
} from "../workshopSlackFiles";

const MB = 1024 * 1024;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const TEXT = new TextEncoder().encode("plain words");

function photo(id: string, overrides: Partial<WorkshopReplyFile> = {}) {
  return {
    id,
    name: `${id}.png`,
    mimetype: "image/png",
    size: 1 * MB,
    url_private_download: `https://files.slack.com/${id}`,
    ...overrides,
  };
}

const screen = (file: WorkshopReplyFile) =>
  screenWorkshopReplyFile(file, workshopFileName(file));

describe("screenWorkshopReplyFile", () => {
  test("passes what the in-app composer would accept", () => {
    expect(screen(photo("a"))).toBeNull();
    expect(
      screen(photo("plan", { name: "plan.pdf", mimetype: "application/pdf" })),
    ).toBeNull();
  });

  test("refuses what the app can't carry, before downloading it", () => {
    expect(
      screen(photo("clip", { name: "clip.mov", mimetype: "video/quicktime" })),
    ).toBe("unsupported");
    expect(screen(photo("huge", { size: 26 * MB }))).toBe("too_large");
  });

  test("a stub with no download link is a download problem, not a type problem", () => {
    // What Slack sends for a file it is withholding: an id and little else.
    expect(screen({ id: "F1" })).toBe("download_failed");
  });

  test("names a file from its title when Slack sends no name", () => {
    expect(workshopFileName({ id: "F1", title: "Screenshot.png" })).toBe(
      "Screenshot.png",
    );
    expect(workshopFileName({ id: "F1", name: "../../etc/x.png" })).toBe("x.png");
    expect(workshopFileName({ id: "F1" })).toBe("Slack attachment");
  });
});

describe("messageBudgetRefusal", () => {
  test("counts only what is already stored", () => {
    expect(messageBudgetRefusal(0, 0, 20 * MB)).toBeNull();
    expect(messageBudgetRefusal(1, 20 * MB, 20 * MB)).toBe("over_total");
    // A withheld 20 MB file was never stored, so a later 15 MB one still fits.
    expect(messageBudgetRefusal(0, 0, 15 * MB)).toBeNull();
    expect(messageBudgetRefusal(10, 10, 1)).toBe("too_many");
  });
});

describe("storedMimeType", () => {
  const typed = (declared: string, head: Uint8Array, name: string, response = "") =>
    storedMimeType(declared, head, response, name);

  test("the bytes correct a label that claims an image or PDF, or says nothing", () => {
    expect(typed("image/png", JPEG, "a.png")).toEqual({ mimeType: "image/jpeg" });
    expect(typed("application/octet-stream", PDF, "a")).toEqual({
      mimeType: "application/pdf",
    });
    expect(typed("", PNG, "a")).toEqual({ mimeType: "image/png" });
  });

  test("a text file that happens to start like a GIF stays a text file", () => {
    const giant = new TextEncoder().encode("GIANT squids are real");
    // Whether Slack labels it, says nothing, or calls it opaque bytes.
    for (const label of ["text/plain", "", "application/octet-stream"]) {
      expect(typed(label, giant, "notes.txt")).toEqual({ mimeType: "text/plain" });
    }
    // A real GIF with no label is still recognised.
    const gif = new TextEncoder().encode("GIF89a....");
    expect(typed("", gif, "anim")).toEqual({ mimeType: "image/gif" });
  });

  test("HEIC has no signature to sniff, so it keeps Slack's label", () => {
    expect(typed("image/heic", new Uint8Array([0, 0, 0, 0x18]), "a.heic")).toEqual({
      mimeType: "image/heic",
    });
  });

  test("a label outside the composer's list is replaced by the extension's type", () => {
    expect(typed("text/html", TEXT, "notes.txt")).toEqual({ mimeType: "text/plain" });
    expect(typed("image/svg+xml", TEXT, "x.png")).toEqual({ mimeType: "image/png" });
    expect(typed("text/html", TEXT, "page.html")).toEqual({ skip: "unsupported" });
  });

  test("every accepted extension maps to a type the composer accepts", () => {
    for (const ext of ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "pdf", "txt", "md", "rtf", "doc", "docx"]) {
      const result = typed("application/x-unknown", TEXT, `file.${ext}`);
      expect("mimeType" in result && isSupportedMessageAttachment(result.mimeType, "")).toBe(true);
    }
  });

  test("a sign-in page served in place of the file is a failed download", () => {
    expect(
      typed("image/png", new Uint8Array([0x3c, 0x21]), "a.png", "text/html; charset=utf-8"),
    ).toEqual({ skip: "download_failed" });
  });
});

describe("thread notices", () => {
  const none = { skipped: [], forwarded: false };

  test("a recorded reply says nothing when everything went", () => {
    expect(skippedFilesNotice(none)).toBeNull();
  });

  test("names each file that didn't go, and why", () => {
    expect(
      skippedFilesNotice({
        skipped: [
          { name: "clip.mov", reason: "unsupported" },
          { name: "huge.png", reason: "too_large" },
        ],
        forwarded: false,
      }),
    ).toBe(
      "⚠️ Your reply reached the scholar without `clip.mov` (Rabbithole messages carry only photos, PDFs, text files and Word documents), `huge.png` (over the 25 MB limit per file).",
    );
  });

  test("a forward is named, never passed on", () => {
    expect(skippedFilesNotice({ skipped: [], forwarded: true })).toContain(
      "without the forwarded message (forwards aren't passed on to scholars",
    );
    expect(emptyReplyNotice({ skipped: [], forwarded: true })).toContain(
      "I didn't send that to the scholar. Nothing in it could go: the forwarded message",
    );
  });

  test("an empty reply says so instead of falling silent", () => {
    expect(emptyReplyNotice(none)).toBe(
      "⚠️ I didn't send that to the scholar: the reply was empty.",
    );
    expect(
      emptyReplyNotice({
        skipped: [{ name: "x.png", reason: "download_failed" }],
        forwarded: false,
      }),
    ).toBe(
      "⚠️ I didn't send that to the scholar. Nothing in it could go: `x.png` (Slack wouldn't let me download it).",
    );
  });

  test("a filename can't break out into Slack markup", () => {
    expect(
      skippedFilesNotice({
        skipped: [{ name: "<!channel> `x`.png", reason: "too_large" }],
        forwarded: false,
      }),
    ).toContain("`&lt;!channel&gt; 'x'.png`");
  });
});
