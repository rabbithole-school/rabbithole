import { describe, expect, test, afterEach, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyMetaSignature,
  whatsAppWindowOpen,
  isStopKeyword,
  renderOffPortalText,
  welcomeMessage,
  flattenTemplateParam,
  deliverOffPortal,
  verifyTwilioSignature,
  truncateSms,
  toE164,
  SMS_MAX_CHARS,
  canonicalPhoneIdentity,
  smsKeyword,
  smsHelpText,
  smsIntroText,
  twimlResponseBody,
  isE164Sender,
  rowCarriesTeacherMessages,
} from "../parentMessageChannels";
import {
  buildParentAideSystemPrompt,
  PARENT_HOMEWORK_PROMPT,
  PARENT_HOMEWORK_PROMPT_SMS,
} from "../parentAidePrompt";

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

describe("renderOffPortalText — links", () => {
  test("spells out a labelled link's URL", () => {
    const text = renderOffPortalText({
      authorType: "teacher",
      authorName: "Ms. Kawena",
      childName: null,
      body: "Book here: [Conference sign-up](https://calendar.app.google/abc)",
      portalUrl: "https://example.com/parent",
    });
    expect(text).toContain(
      "Book here: Conference sign-up (https://calendar.app.google/abc)",
    );
  });
});

// ── SMS via Twilio ─────────────────────────────────────────────────────────
// fetch is ALWAYS stubbed in these tests, and the Twilio env vars are fake:
// a worktree deployment may carry live keys, so no test may send a real text.

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: "ACtest00000000000000000000000000",
  TWILIO_API_KEY_SID: "SKtest00000000000000000000000000",
  TWILIO_API_KEY_SECRET: "key-secret",
  TWILIO_FROM_NUMBER: "+18005550100",
};

describe("parentMessageChannels — SMS send via Twilio", () => {
  const saved: Record<string, string | undefined> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of [...Object.keys(TWILIO_ENV), "TWILIO_AUTH_TOKEN"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("posts a form-encoded message with API-key basic auth and returns the SID", async () => {
    Object.assign(process.env, TWILIO_ENV);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ sid: "SM123", status: "queued" }), {
        status: 201,
      }),
    );
    const id = await deliverOffPortal({
      channel: "sms",
      to: "16505551234", // stored identities are digits-only
      body: "Hello from school",
    });
    expect(id).toBe("SM123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ENV.TWILIO_ACCOUNT_SID}/Messages.json`,
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      "Basic " +
        Buffer.from(
          `${TWILIO_ENV.TWILIO_API_KEY_SID}:${TWILIO_ENV.TWILIO_API_KEY_SECRET}`,
        ).toString("base64"),
    );
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body as string);
    expect(form.get("To")).toBe("+16505551234");
    expect(form.get("From")).toBe(TWILIO_ENV.TWILIO_FROM_NUMBER);
    expect(form.get("Body")).toBe("Hello from school");
  });

  test("cuts a body over Twilio's 1,600-character cap instead of failing", async () => {
    Object.assign(process.env, TWILIO_ENV);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: "SM1" })));
    await deliverOffPortal({ channel: "sms", to: "16505551234", body: "word ".repeat(500) });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = new URLSearchParams(init.body as string).get("Body")!;
    expect(sent.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(sent.endsWith("word…")).toBe(true);
  });

  test("returns null (skipped) without touching the network when any credential is missing", async () => {
    for (const missing of Object.keys(TWILIO_ENV)) {
      Object.assign(process.env, TWILIO_ENV);
      delete process.env[missing];
      expect(
        await deliverOffPortal({ channel: "sms", to: "16505551234", body: "hi" }),
      ).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws on a Twilio API error so the delivery is marked failed", async () => {
    Object.assign(process.env, TWILIO_ENV);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number", status: 400 }),
        { status: 400 },
      ),
    );
    await expect(
      deliverOffPortal({ channel: "sms", to: "123", body: "hi" }),
    ).rejects.toThrow(/Twilio Messages API send failed \(400\).*21211/);
  });

  test("normalizes stored identities to E.164", () => {
    expect(toE164("16505551234")).toBe("+16505551234");
    expect(toE164("(650) 555-1234")).toBe("+16505551234");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });
});

describe("parentMessageChannels — Twilio webhook signature verification", () => {
  // Twilio's published test vector (twilio-node's webhook tests): auth token
  // "12345", this URL and these params sign to RSOYDt4T1cUTdK1PDd93/VVr8B8=.
  const TOKEN = "12345";
  const URL_ = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const PARAMS = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675309",
    Digits: "1234",
    From: "+14158675309",
    To: "+18005551212",
  };
  const VECTOR = "RSOYDt4T1cUTdK1PDd93/VVr8B8=";
  const sign = (token: string, url: string, params: Record<string, string>) =>
    createHmac("sha1", token)
      .update(url + Object.keys(params).sort().map((k) => k + params[k]).join(""))
      .digest("base64");

  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  test("accepts Twilio's published test vector", async () => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    expect(await verifyTwilioSignature(URL_, PARAMS, VECTOR)).toBe(true);
  });

  test("param order in the request doesn't matter (names are sorted)", async () => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    const reversed = Object.fromEntries(Object.entries(PARAMS).reverse());
    expect(await verifyTwilioSignature(URL_, reversed, VECTOR)).toBe(true);
  });

  test("a repeated param contributes each value in sorted order", async () => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    const expected = createHmac("sha1", TOKEN)
      .update(URL_ + "Body" + "hi" + "MediaUrl" + "a" + "MediaUrl" + "b")
      .digest("base64");
    expect(
      await verifyTwilioSignature(URL_, { MediaUrl: ["b", "a"], Body: "hi" }, expected),
    ).toBe(true);
  });

  test("a repeated param's duplicate values count once, as in twilio-node", async () => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    const expected = createHmac("sha1", TOKEN)
      .update(URL_ + "MediaUrl" + "a" + "MediaUrl" + "b")
      .digest("base64");
    expect(
      await verifyTwilioSignature(URL_, { MediaUrl: ["b", "a", "a"] }, expected),
    ).toBe(true);
  });

  test("rejects a tampered param, URL, signature, or wrong token", async () => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    expect(
      await verifyTwilioSignature(URL_, { ...PARAMS, Digits: "9999" }, VECTOR),
    ).toBe(false);
    expect(
      await verifyTwilioSignature("https://mycompany.com/myapp.php", PARAMS, VECTOR),
    ).toBe(false);
    expect(await verifyTwilioSignature(URL_, PARAMS, "AAAA" + VECTOR.slice(4))).toBe(false);
    expect(await verifyTwilioSignature(URL_, PARAMS, sign("wrong", URL_, PARAMS))).toBe(false);
  });

  test("fails closed without the auth token or the header", async () => {
    expect(await verifyTwilioSignature(URL_, PARAMS, VECTOR)).toBe(false); // no env
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    expect(await verifyTwilioSignature(URL_, PARAMS, null)).toBe(false);
    expect(await verifyTwilioSignature(URL_, PARAMS, "")).toBe(false);
  });
});

describe("parentMessageChannels — truncateSms", () => {
  test("returns text within the limit unchanged", () => {
    expect(truncateSms("short message", 20)).toBe("short message");
    expect(truncateSms("exactly ten", 11)).toBe("exactly ten");
  });

  test("cuts on a word boundary and ends with an ellipsis", () => {
    const out = truncateSms("the quick brown fox jumps over", 17);
    expect(out).toBe("the quick brown…");
    expect(out.length).toBeLessThanOrEqual(17);
  });

  test("keeps a word that ends exactly at the cut", () => {
    // budget for text is 15 chars: "the quick brown" then a space follows.
    expect(truncateSms("the quick brown fox", 16)).toBe("the quick brown…");
  });

  test("drops trailing whitespace and newlines before the ellipsis", () => {
    expect(truncateSms("first line\n\nsecond line here", 14)).toBe("first line…");
  });

  test("cuts mid-word only when one word overflows the whole budget", () => {
    const out = truncateSms("https://example.invalid/a-very-long-path", 12);
    expect(out).toBe("https://exa…");
    expect(out.length).toBe(12);
  });

  test("leading whitespace before one oversized word still cuts mid-word", () => {
    const out = truncateSms("  " + "x".repeat(2000), 1600);
    expect(out).toBe("  " + "x".repeat(1597) + "…");
    expect(out.length).toBe(1600);
  });

  test("never splits an emoji's surrogate pair", () => {
    const out = truncateSms("ab😀cdefgh", 4); // budget 3 would land mid-emoji
    expect(out).toBe("ab…");
    expect(out.length).toBeLessThanOrEqual(4);
  });

  test("degenerate limits stay within budget", () => {
    expect(truncateSms("hello world", 1)).toBe("…");
    expect(truncateSms("hello world", 0)).toBe("");
  });
});

describe("inbound SMS helpers", () => {
  test("canonicalPhoneIdentity: one form for every way a number is written", () => {
    for (const raw of ["+18085550142", "(808) 555-0142", "808.555.0142", "1 808 555 0142"]) {
      expect(canonicalPhoneIdentity(raw)).toBe("18085550142");
    }
    // A number already carrying its country code keeps the old digits-only form.
    expect(canonicalPhoneIdentity("+447700900123")).toBe("447700900123");
  });

  test("smsKeyword: whole-body, single-word, case-insensitive", () => {
    for (const word of ["STOP", "stopall", "Unsubscribe", " cancel ", "end", "QUIT", "revoke", "optout", "halt"]) {
      expect(smsKeyword(word)).toBe("stop");
    }
    expect(smsKeyword("start")).toBe("start");
    expect(smsKeyword("UNSTOP")).toBe("start");
    for (const word of ["help", "INFO", "Support"]) expect(smsKeyword(word)).toBe("help");
    // A sentence is a question for the aide; YES is a real answer.
    expect(smsKeyword("stop the BunnyPad please")).toBeNull();
    expect(smsKeyword("can you help with Kai's reading?")).toBeNull();
    expect(smsKeyword("yes")).toBeNull();
    // Surrounding punctuation and emoji don't hide a keyword.
    for (const word of ["STOP.", "stop!", "\"Stop\"", "STOP 🛑", "...help?"]) {
      expect(smsKeyword(word)).not.toBeNull();
    }
    expect(smsKeyword("stop. please")).toBeNull();
  });

  test("isE164Sender: one + number, 11 to 15 digits, nothing else", () => {
    expect(isE164Sender("+18085550142")).toBe(true);
    expect(isE164Sender("+447700900123")).toBe(true);
    for (const from of ["whatsapp:+18085550142", "18085550142", "+1808555014", "+1 808 555 0142", "+08085550142", ""]) {
      expect(isE164Sender(from)).toBe(false);
    }
  });

  test("rowCarriesTeacherMessages: an aide-only consent never carries teacher messages", () => {
    expect(rowCarriesTeacherMessages({ optInAt: 1 })).toBe(true);
    expect(rowCarriesTeacherMessages({ optInAt: 1, scope: "aide" })).toBe(false);
    expect(rowCarriesTeacherMessages({ optInAt: 1, stopState: true })).toBe(false);
    expect(rowCarriesTeacherMessages({})).toBe(false);
  });

  test("the SMS prompt doesn't put the parent in the portal or reply-to-reach a teacher", () => {
    const base = { parentName: "Hoku", childList: "a child", childCount: 1 };
    const web = buildParentAideSystemPrompt(base);
    const sms = buildParentAideSystemPrompt({ ...base, channel: "sms" });
    expect(web).toContain(PARENT_HOMEWORK_PROMPT);
    expect(sms).not.toContain(PARENT_HOMEWORK_PROMPT);
    expect(sms).toContain(PARENT_HOMEWORK_PROMPT_SMS);
    expect(sms).not.toContain("standing in it");
    expect(sms).toContain("texting this number reaches only you");
  });

  test("smsHelpText fits a 320-character Advanced Opt-Out HELP response", () => {
    const text = smsHelpText("Moli School", "https://moli.example/parent");
    expect(text.length).toBeLessThanOrEqual(320);
    expect(text).toContain("Reply STOP to opt out.");
    expect(smsHelpText("Moli School", null)).toContain("ask the school office");
  });

  test("twimlResponseBody escapes the reply", () => {
    expect(twimlResponseBody(null)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
    expect(twimlResponseBody("A & <B>")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>A &amp; &lt;B&gt;</Message></Response>',
    );
  });
});

describe("parentMessageChannels — SMS intro text", () => {
  test("one kid fills both examples; two kids get one example each", () => {
    const one = smsIntroText("Moli School", ["Kai"]);
    expect(one).toContain("Ask what Kai is learning");
    expect(one).toContain(`"freeze Kai's BunnyPad"`);
    const two = smsIntroText("Moli School", ["Kai", "Noe", "Lani"]);
    expect(two).toContain("Ask what Kai is learning");
    expect(two).toContain(`"freeze Noe's BunnyPad"`);
    expect(two.startsWith("Moli School: ")).toBe(true);
  });

  test("is plain GSM text (one curly quote would make every segment UCS-2)", () => {
    const text = smsIntroText("Example School", ["Christopher", "Alexandria"]);
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
  });
});
