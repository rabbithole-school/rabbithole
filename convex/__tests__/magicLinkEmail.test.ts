import { afterEach, describe, expect, test, vi } from "vitest";
import { renderMagicLinkEmail, sendMagicLinkEmail } from "../lib/magicLinkEmail";

// The sign-in email has two variants: the default Rabbithole one, and an
// institution-branded one for people who know the institution but not the
// app. These pin which copy and which From each variant uses.

const URL = "https://rabbithole.test/api/auth/signin?code=abc";

describe("renderMagicLinkEmail", () => {
  test("without a brand it is the Rabbithole email", () => {
    const { subject, html } = renderMagicLinkEmail(URL);
    expect(subject).toBe("Your Rabbithole sign-in link");
    expect(html).toContain("Sign in to Rabbithole");
    expect(html).not.toContain("Powered by Rabbithole");
    expect(html).toContain(URL);
  });

  test("with a brand the institution leads and Rabbithole is a footer line", () => {
    const { subject, html } = renderMagicLinkEmail(URL, {
      name: "Example Academy",
    });
    expect(subject).toBe("Your Example Academy sign-in link");
    expect(html).toContain("Sign in to Example Academy");
    expect(html).not.toContain("Sign in to Rabbithole");
    expect(html).toContain("Powered by Rabbithole.");
    expect(html).toContain(URL);
  });

  test("the brand name is HTML-escaped", () => {
    const { html } = renderMagicLinkEmail(URL, { name: "A & B <School>" });
    expect(html).toContain("Sign in to A &amp; B &lt;School&gt;");
  });
});

describe("sendMagicLinkEmail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function captureSend() {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("AUTH_RESEND_KEY", "test-key");
    return () => {
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      return JSON.parse(init.body as string) as {
        from: string;
        subject: string;
      };
    };
  }

  test("default variant sends from AUTH_EMAIL_FROM", async () => {
    const body = captureSend();
    await sendMagicLinkEmail({ to: "p@example.com", url: URL });
    expect(body().from).toBe(process.env.AUTH_EMAIL_FROM);
    expect(body().subject).toBe("Your Rabbithole sign-in link");
  });

  test("a brand's From overrides AUTH_EMAIL_FROM", async () => {
    const body = captureSend();
    await sendMagicLinkEmail({
      to: "p@example.com",
      url: URL,
      brand: { name: "Example Academy", from: "Example <a@example.test>" },
    });
    expect(body().from).toBe("Example <a@example.test>");
    expect(body().subject).toBe("Your Example Academy sign-in link");
  });

  test("a brand without a From falls back to AUTH_EMAIL_FROM", async () => {
    const body = captureSend();
    await sendMagicLinkEmail({
      to: "p@example.com",
      url: URL,
      brand: { name: "Example Academy" },
    });
    expect(body().from).toBe(process.env.AUTH_EMAIL_FROM);
  });

  test("with no Resend key nothing is sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("AUTH_RESEND_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendMagicLinkEmail({
      to: "p@example.com",
      url: URL,
      brand: { name: "Example Academy" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
