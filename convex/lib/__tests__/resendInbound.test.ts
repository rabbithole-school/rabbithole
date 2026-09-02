import { describe, expect, test } from "vitest";
import {
  computeResendWebhookSignature,
  emailMailboxesMatch,
  emailTaggedMailboxesMatch,
  extractEmailAddress,
  extractNewReply,
  findThreadReplyAddress,
  verifyResendWebhook,
} from "../resendInbound";
import { replyAddressForThread } from "../parentMessageEmail";

const SECRET = `whsec_${btoa("test-resend-secret")}`;
const ID = "msg_test";
const TIMESTAMP = "1786186800";
const PAYLOAD = '{"type":"email.received"}';
const NOW = Number(TIMESTAMP) * 1000;

describe("Resend inbound email", () => {
  test("verifies a current Svix signature and rejects tampering", async () => {
    const signature = await computeResendWebhookSignature({
      webhookSecret: SECRET,
      id: ID,
      timestamp: TIMESTAMP,
      payload: PAYLOAD,
    });
    expect(signature).not.toBeNull();
    expect(
      await verifyResendWebhook({
        webhookSecret: SECRET,
        id: ID,
        timestamp: TIMESTAMP,
        signature: `v1,old-signature v1,${signature}`,
        payload: PAYLOAD,
        nowMs: NOW,
      }),
    ).toBe(true);
    expect(
      await verifyResendWebhook({
        webhookSecret: SECRET,
        id: ID,
        timestamp: TIMESTAMP,
        signature: `v1,${signature}`,
        payload: `${PAYLOAD} `,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  test("rejects stale requests", async () => {
    const signature = await computeResendWebhookSignature({
      webhookSecret: SECRET,
      id: ID,
      timestamp: TIMESTAMP,
      payload: PAYLOAD,
    });
    expect(
      await verifyResendWebhook({
        webhookSecret: SECRET,
        id: ID,
        timestamp: TIMESTAMP,
        signature: `v1,${signature}`,
        payload: PAYLOAD,
        nowMs: NOW + 6 * 60 * 1000,
      }),
    ).toBe(false);
  });

  test("extracts display-name addresses and removes quoted replies", () => {
    expect(extractEmailAddress("Alex <alex@example.org>")).toBe(
      "alex@example.org",
    );
    expect(
      extractNewReply(
        "how are you?\r\n☕️☕️☕️\r\n\r\nOn Sat, Aug 8, 2026 at 4:05 PM Test Teacher via Rabbithole\r\n<no-reply@example.org> wrote:\r\n> old message",
      ),
    ).toBe("how are you?\n☕️☕️☕️");
  });

  test("matches Gmail aliases to their reply mailbox without widening other providers", () => {
    expect(
      emailMailboxesMatch(
        "fixture.user+parent@gmail.com",
        "Fixture.User@gmail.com",
      ),
    ).toBe(true);
    expect(
      emailMailboxesMatch(
        "family+avery@example.com",
        "family@example.com",
      ),
    ).toBe(false);
    expect(
      emailTaggedMailboxesMatch(
        "operator+parent@example.org",
        "operator@example.org",
      ),
    ).toBe(true);
    expect(
      emailTaggedMailboxesMatch(
        "family+avery@example.com",
        "stranger@example.com",
      ),
    ).toBe(false);
  });

  test("finds the thread mailbox when Reply All moves it to Cc", () => {
    expect(
      findThreadReplyAddress({
        receivedFor: [],
        to: ["teacher@example.com"],
        cc: [
          "reply+thread123@receiving.example.test",
          "guardian@example.com",
        ],
        bcc: [],
      }),
    ).toBe("reply+thread123@receiving.example.test");

    expect(
      findThreadReplyAddress({
        receivedFor: ["reply+thread456@receiving.example.test"],
        to: ["teacher@example.com"],
        cc: [],
        bcc: [],
      }),
    ).toBe("reply+thread456@receiving.example.test");
  });

  test("builds a per-thread reply address only when receiving is configured", () => {
    const prior = process.env.PARENT_INBOUND_DOMAIN;
    try {
      delete process.env.PARENT_INBOUND_DOMAIN;
      expect(replyAddressForThread("thread123")).toBeNull();
      process.env.PARENT_INBOUND_DOMAIN = "receiving.example.test";
      expect(replyAddressForThread("thread123")).toBe(
        "reply+thread123@receiving.example.test",
      );
    } finally {
      if (prior === undefined) delete process.env.PARENT_INBOUND_DOMAIN;
      else process.env.PARENT_INBOUND_DOMAIN = prior;
    }
  });
});
