import { describe, expect, test, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyMetaSignature,
  whatsAppWindowOpen,
  isStopKeyword,
  renderOffPortalText,
  welcomeMessage,
  flattenTemplateParam,
} from "../parentMessageChannels";

describe("parentMessageChannels — Meta webhook signature verification", () => {
  afterEach(() => {
    delete process.env.WHATSAPP_APP_SECRET;
  });

  // Meta signs the RAW body: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(body).
  const SECRET = "app_secret_123";
  const BODY = JSON.stringify({
    entry: [
      {
        changes: [
          { value: { messages: [{ from: "16505551234", type: "text", text: { body: "hi" } }] } },
        ],
      },
    ],
  });
  const sign = (secret: string, body: string) =>
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  test("accepts a valid X-Hub-Signature-256", async () => {
    process.env.WHATSAPP_APP_SECRET = SECRET;
    expect(await verifyMetaSignature(BODY, sign(SECRET, BODY))).toBe(true);
  });

  test("rejects a tampered body, signature, or wrong secret", async () => {
    process.env.WHATSAPP_APP_SECRET = SECRET;
    expect(await verifyMetaSignature(BODY, "sha256=deadbeef")).toBe(false);
    expect(await verifyMetaSignature(BODY + " ", sign(SECRET, BODY))).toBe(false);
    expect(await verifyMetaSignature(BODY, sign("wrong_secret", BODY))).toBe(false);
  });

  test("fails closed without app secret or signature", async () => {
    expect(await verifyMetaSignature(BODY, sign(SECRET, BODY))).toBe(false); // no secret env
    process.env.WHATSAPP_APP_SECRET = SECRET;
    expect(await verifyMetaSignature(BODY, null)).toBe(false); // no header
  });
});

describe("parentMessageChannels — WhatsApp 24h window + STOP", () => {
  test("window is open within 24h of the last inbound, else closed", () => {
    expect(whatsAppWindowOpen(Date.now() - 60_000)).toBe(true);
    expect(whatsAppWindowOpen(Date.now() - 25 * 60 * 60 * 1000)).toBe(false);
    expect(whatsAppWindowOpen(null)).toBe(false);
    expect(whatsAppWindowOpen(undefined)).toBe(false);
  });

  test("STOP keywords are detected", () => {
    expect(isStopKeyword("STOP")).toBe(true);
    expect(isStopKeyword(" unsubscribe ")).toBe(true);
    expect(isStopKeyword("please stop sending")).toBe(false);
  });
});

describe("parentMessageChannels — off-portal sender attribution", () => {
  const portalUrl = "https://app.example.invalid/parent";

  test("teacher messages are attributed to the human teacher (not 'automated')", () => {
    const text = renderOffPortalText({
      authorType: "teacher",
      authorName: "Ms. Kawena",
      childName: "Keoni",
      body: "Keoni did great today.",
      portalUrl,
    });
    const firstLine = text.split("\n")[0];
    expect(firstLine).toContain("Ms. Kawena");
    expect(firstLine).toContain("Keoni");
    expect(firstLine).not.toContain("automated");
    expect(text).toContain("Keoni did great today.");
    expect(text).toContain(portalUrl);
  });

  test("includes direct attachment links for WhatsApp delivery", () => {
    const text = renderOffPortalText({
      authorType: "teacher",
      authorName: "Ms. Kawena",
      childName: "Keoni",
      body: "Here is today's work.",
      portalUrl,
      attachmentLinks: [
        {
          fileName: "tide-pool.jpg",
          url: "https://example.com/storage/tide-pool.jpg",
        },
      ],
    });

    expect(text).toContain("tide-pool.jpg");
    expect(text).toContain("https://example.com/storage/tide-pool.jpg");
  });

  test("preserves URLs in the message body for WhatsApp previews", () => {
    const body = "Read https://example.com/field-notes?week=1.";
    const text = renderOffPortalText({
      authorType: "teacher",
      authorName: "Ms. Kawena",
      childName: "Keoni",
      body,
      portalUrl,
    });

    expect(text).toContain(body);
  });
});

describe("parentMessageChannels — opt-in welcome", () => {
  const portalUrl = "https://app.example.invalid/parent";

  test("explains it worked, identifies teacher messages, and shows how to opt out", () => {
    const text = welcomeMessage(["Keoni"], portalUrl);
    expect(text).toMatch(/connected/i);
    expect(text).toContain("Keoni");
    expect(text).toContain("👩‍🏫"); // teacher signal
    expect(text).toMatch(/STOP/);
    expect(text).toContain(portalUrl);
  });

  test("handles multiple children and an empty list gracefully", () => {
    expect(welcomeMessage(["Keoni", "Lani"], portalUrl)).toContain("Keoni and Lani");
    expect(welcomeMessage(["A", "B", "C"], portalUrl)).toContain("A, B and C");
    expect(welcomeMessage([], portalUrl)).toContain("your child");
  });
});

describe("parentMessageChannels — template parameter flattening", () => {
  test("strips newlines/tabs and collapses space runs (Cloud API 132000 guard)", () => {
    const rendered = renderOffPortalText({
      authorType: "teacher",
      authorName: "Ms. Kawena",
      childName: "Keoni",
      body: "Line one.\nLine two.",
      portalUrl: "https://app.example.invalid/parent",
    });
    expect(rendered).toContain("\n"); // the rendered message IS multi-line
    const param = flattenTemplateParam(rendered);
    expect(param).not.toMatch(/[\n\r\t]/); // …but the template param is not
    expect(param).not.toMatch(/ {5,}/); // no run of >4 spaces
    expect(param).toContain("Line one. Line two.");
  });
});
