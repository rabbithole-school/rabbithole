import { afterEach, describe, expect, test } from "vitest";

import {
  fromHeader,
  renderParentMessage,
  sendParentEmail,
} from "../parentMessageEmail";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AUTH_RESEND_KEY;
});

describe("parent message email", () => {
  test("linkifies safe message URLs without changing punctuation or allowing XSS", () => {
    const rendered = renderParentMessage({
      teacherName: "Lehua Torres",
      threadSubjectBody: "A class update",
      body: 'See https://example.com/a_(b)?x=1&y=2#note. <img src=x> javascript:alert(1)',
      portalUrl: "https://example.com/parent",
      canReplyByEmail: true,
    });

    expect(rendered.html).toContain(
      'href="https://example.com/a_(b)?x=1&amp;y=2#note"',
    );
    expect(rendered.html).toContain("</a>.");
    expect(rendered.html).toContain("&lt;img src=x&gt;");
    expect(rendered.html).not.toContain('href="javascript:');
  });

  test("uses the truncated first message as the subject and renders like a normal email", () => {
    const rendered = renderParentMessage({
      teacherName: "Alex Rivera",
      threadSubjectBody:
        "Hi Morgan,\nHere is a test of the photos from the first day of school:",
      body: "Here is the second message.",
      portalUrl:
        "https://rabbithole.school/parent/messages?thread=thread-1",
      canReplyByEmail: true,
    });

    expect(rendered.subject).toBe(
      "Hi Morgan, Here is a test of the photos from the first day o…",
    );
    expect(rendered.html).toContain("<em>View in Rabbithole</em>");
    expect(rendered.html).toContain(
      "https://rabbithole.school/parent/messages?thread=thread-1",
    );
    expect(rendered.html).not.toContain("Rabbithole about");
    expect(rendered.html).not.toContain("WhatsApp");
    expect(rendered.html).not.toContain("background:#f7f5fa");
    expect(rendered.html).not.toContain("From <strong>");
    expect(rendered.html).not.toContain("max-width");
    expect(rendered.html).not.toContain("font-family");
    expect(rendered.html).toContain('style="color:#666;margin-top:24px;"');
    expect(rendered.html.indexOf("Here is the second message.")).toBeLessThan(
      rendered.html.indexOf("Reply to this email to respond."),
    );
    expect(rendered.text).not.toContain("From Alex Rivera");
    expect(rendered.text).toContain(
      "View in Rabbithole: https://rabbithole.school/parent/messages?thread=thread-1",
    );
  });

  test("renders attachment names in HTML and plain text", () => {
    const rendered = renderParentMessage({
      teacherName: "Lehua Torres",
      threadSubjectBody: "",
      body: "",
      portalUrl: "https://example.com/parent",
      canReplyByEmail: true,
      attachmentNames: ["tide-pool.jpg", "field-notes.pdf"],
    });

    expect(rendered.html).toContain("tide-pool.jpg");
    expect(rendered.text).toContain(
      "Attached: tide-pool.jpg, field-notes.pdf",
    );
  });

  test("passes remote attachments and an idempotency key to Resend", async () => {
    process.env.AUTH_RESEND_KEY = "test-key";
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ id: "email-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(
      sendParentEmail({
        to: ["guardian@example.com"],
        from: "Teacher via Rabbithole <messages@example.com>",
        replyTo: "reply+thread-1@messages.example.com",
        subject: "A family update",
        html: "<p>Update</p>",
        text: "Update",
        attachments: [
          {
            path: "https://example.com/storage/tide-pool.jpg",
            filename: "tide-pool.jpg",
            contentType: "image/jpeg",
            sizeBytes: 1_024,
          },
        ],
        idempotencyKey: "parent-email/delivery-1",
      }),
    ).resolves.toBe("email-1");

    expect(
      (request?.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe("parent-email/delivery-1");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      reply_to: "reply+thread-1@messages.example.com",
      attachments: [
        {
          path: "https://example.com/storage/tide-pool.jpg",
          filename: "tide-pool.jpg",
          content_type: "image/jpeg",
        },
      ],
    });
  });

  test("uses a family-facing sender when auth email uses no-reply", () => {
    expect(fromHeader("Lehua Torres")).toBe(
      "Lehua Torres via Rabbithole <families@rabbithole.test>",
    );
  });
});
