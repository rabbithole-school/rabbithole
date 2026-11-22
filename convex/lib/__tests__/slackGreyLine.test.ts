import { afterEach, describe, expect, test, vi } from "vitest";
import { postMessage } from "../slackApi";
import {
  BLOCK_TEXT_FALLBACK_MAX,
  commonMarkToMrkdwn,
  greyLineMessage,
} from "../slackGreyLine";

describe("commonMarkToMrkdwn", () => {
  test("turns CommonMark bold and links into Slack mrkdwn", () => {
    expect(commonMarkToMrkdwn("**From Ms. Okada:** see [the PR](https://github.com/x/y/pull/1)")).toBe(
      "*From Ms. Okada:* see <https://github.com/x/y/pull/1|the PR>",
    );
  });

  test("leaves italics, Slack links and code spans alone", () => {
    expect(commonMarkToMrkdwn("_Answer here_ <https://a.b|Open> `**raw**`")).toBe(
      "_Answer here_ <https://a.b|Open> `**raw**`",
    );
  });
});

describe("greyLineMessage", () => {
  test("CommonMark main text becomes markdown blocks, a grey part a context line", () => {
    const msg = greyLineMessage(
      ["**Parent message in Rabbithole**\n**From:** Dana", { grey: "Reply here. [Open Messages](https://x.test/m)" }],
      { markdown: true },
    );
    expect(msg.blocks).toEqual([
      { type: "markdown", text: "**Parent message in Rabbithole**\n**From:** Dana" },
      { type: "context", block_id: "rh_grey_0", elements: [{ type: "mrkdwn", text: "Reply here. <https://x.test/m|Open Messages>" }] },
    ]);
    expect(msg.text).toBe("*Parent message in Rabbithole*\n*From:* Dana\n\nReply here. <https://x.test/m|Open Messages>");
  });

  test("mrkdwn main text becomes sections, and the grey line stays as written", () => {
    const msg = greyLineMessage(["*SEL write-ups*\n*Watch:* Theo", { grey: "_Each write-up is in the thread_" }], {
      markdown: false,
    });
    expect(msg.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "*SEL write-ups*\n*Watch:* Theo" } },
      { type: "context", block_id: "rh_grey_0", elements: [{ type: "mrkdwn", text: "_Each write-up is in the thread_" }] },
    ]);
    expect(msg.text).toBe("*SEL write-ups*\n*Watch:* Theo\n_Each write-up is in the thread_");
  });

  test("keeps the order given, so a grey line can sit between main text", () => {
    const msg = greyLineMessage(["Takes", { grey: "_Rabbithole wrote this._" }, "<@U1>: reply here"], {
      markdown: false,
      text: "Takes\n_Rabbithole wrote this._\n\n<@U1>: reply here",
    });
    expect((msg.blocks ?? []).map((b) => (b as { type: string }).type)).toEqual(["section", "context", "section"]);
    expect(msg.text).toBe("Takes\n_Rabbithole wrote this._\n\n<@U1>: reply here");
  });

  test("grey lines in a row share one context block", () => {
    const msg = greyLineMessage(["Brief", { grey: "From a thread" }, { grey: "Reply here" }, "Tail", { grey: "Last" }], {
      markdown: false,
    });
    expect(msg.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Brief" } },
      { type: "context", block_id: "rh_grey_0", elements: [{ type: "mrkdwn", text: "From a thread\nReply here" }] },
      { type: "section", text: { type: "mrkdwn", text: "Tail" } },
      { type: "context", block_id: "rh_grey_1", elements: [{ type: "mrkdwn", text: "Last" }] },
    ]);
  });

  test("a message with nothing grey posts its text as before, line breaks and all", () => {
    expect(greyLineMessage(["**Hi**\n> quoted", { grey: "  " }, ""], { markdown: true })).toEqual({
      text: "**Hi**\n> quoted",
      markdown: true,
    });
    expect(greyLineMessage(["*Hi*", "there"], { markdown: false, text: "*Hi*\nthere" })).toEqual({
      text: "*Hi*\nthere",
    });
  });

  test("splits long mrkdwn into sections Slack accepts", () => {
    const line = "x".repeat(2000);
    const msg = greyLineMessage([`${line}\n${line}`, { grey: "z" }], { markdown: false });
    expect(msg.blocks).toHaveLength(3);
  });

  test("leaves the fallback empty past Slack's cap, so Slack builds it from the blocks", () => {
    const msg = greyLineMessage(["y".repeat(BLOCK_TEXT_FALLBACK_MAX), { grey: "z" }], { markdown: true });
    expect(msg.text).toBe("");
  });
});

describe("postMessage with blocks", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("sends the fallback as text, and leaves out an empty one", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true, ts: "1.0" }));
      }),
    );
    const blocks = [{ type: "markdown", text: "hi" }];
    await postMessage("xoxb-test", { channel: "C1", text: "hi", blocks, markdown: true });
    await postMessage("xoxb-test", { channel: "C1", text: "", blocks });
    expect(bodies[0]).toMatchObject({ text: "hi", blocks });
    expect(bodies[0]).not.toHaveProperty("markdown_text");
    expect(bodies[1]).not.toHaveProperty("text");
  });
});
