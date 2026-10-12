import { describe, expect, test } from "vitest";
import {
  actionPrefix,
  demoAckBlocks,
  flattenViewValues,
  parseInteractivityBody,
  planBlockAction,
  type SlackBlockActionsPayload,
} from "../slackInteractivity";
import {
  computeSlackSignature,
  verifySlackSignature,
} from "../slackSignature";

const SECRET = "test-secret";

function formBody(payload: unknown): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function clickPayload(blocks: unknown[] = demoAckBlocks()): SlackBlockActionsPayload {
  return {
    type: "block_actions",
    user: { id: "U1" },
    channel: { id: "C1" },
    message: { ts: "1.2", blocks },
    actions: [{ action_id: "demo:ack" }],
  };
}

describe("parseInteractivityBody", () => {
  test("parses a form-encoded block_actions payload", () => {
    const r = parseInteractivityBody(formBody(clickPayload()));
    expect(r.ok && r.payload.type).toBe("block_actions");
  });
  test.each([
    ["", "missing payload"],
    ["payload=%7Bnot-json", "payload is not JSON"],
    [formBody({ user: { id: "U" } }), "missing type"],
    [formBody({ type: "block_actions", actions: [] }), "missing user"],
    [formBody({ type: "block_actions", user: { id: "U" } }), "missing actions"],
  ])("rejects %j", (body, error) => {
    expect(parseInteractivityBody(body)).toEqual({ ok: false, error });
  });
});

describe("signature reuse on the raw form body", () => {
  test("verifies the raw body and rejects a tampered one", async () => {
    const body = formBody(clickPayload());
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await computeSlackSignature(SECRET, ts, body);
    const args = { signingSecret: SECRET, timestampHeader: ts, signatureHeader: sig };
    expect(await verifySlackSignature({ ...args, rawBody: body })).toBe(true);
    expect(await verifySlackSignature({ ...args, rawBody: body + "x" })).toBe(false);
    expect(
      await verifySlackSignature({
        ...args,
        timestampHeader: String(Number(ts) - 3600),
        rawBody: body,
      }),
    ).toBe(false);
  });
});

describe("dispatch", () => {
  test("actionPrefix", () => {
    expect(actionPrefix("demo:ack")).toBe("demo");
    expect(actionPrefix("plain")).toBe("plain");
  });
  test("demo:ack updates the message with who and when", () => {
    const p = clickPayload();
    const plan = planBlockAction({
      payload: p,
      action: p.actions[0],
      userName: "Andy",
      nowMs: Date.UTC(2026, 9, 10),
    });
    expect(plan.kind).toBe("update");
    if (plan.kind !== "update") return;
    expect(plan.channel).toBe("C1");
    expect(plan.ts).toBe("1.2");
    expect(plan.text).toContain("Andy");
    expect(plan.text).toContain("2026-10-10");
    expect(JSON.stringify(plan.blocks)).not.toContain("demo:ack");
  });
  test("second click on an already-handled message is a noop", () => {
    const handled = clickPayload([{ type: "section", text: { type: "mrkdwn", text: "done" } }]);
    expect(
      planBlockAction({ payload: handled, action: handled.actions[0], userName: "A", nowMs: 0 }),
    ).toEqual({ kind: "noop", reason: "already handled" });
  });
  test("unknown prefix is a noop", () => {
    const p = clickPayload();
    const plan = planBlockAction({
      payload: p,
      action: { action_id: "nope:x" },
      userName: "A",
      nowMs: 0,
    });
    expect(plan.kind).toBe("noop");
  });
});

describe("flattenViewValues", () => {
  test("flattens modal state", () => {
    expect(
      flattenViewValues({
        id: "V",
        callback_id: "notes",
        state: { values: { b1: { notes_input: { type: "plain_text_input", value: "hi" } } } },
      }),
    ).toEqual({ notes_input: "hi" });
  });
});
