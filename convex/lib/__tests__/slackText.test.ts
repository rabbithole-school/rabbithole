import { describe, expect, test } from "vitest";
import { SlackMentionRewriter, slackTextToMessageBody } from "../slackText";

describe("slackTextToMessageBody", () => {
  test("turns Slack's link markup into the message body's link forms", () => {
    expect(
      slackTextToMessageBody(
        "Book here: <https://calendar.app.google/abc?a=1&amp;b=2|Conference sign-up> or <https://example.com/x>",
      ),
    ).toBe(
      "Book here: [Conference sign-up](https://calendar.app.google/abc?a=1&b=2) or https://example.com/x",
    );
  });

  test("decodes Slack's escaped control characters", () => {
    expect(slackTextToMessageBody("5 &lt; 6 &amp;&amp; 7 &gt; 2")).toBe(
      "5 < 6 && 7 > 2",
    );
  });

  test("spells out a link whose label the [label](url) form cannot carry", () => {
    expect(slackTextToMessageBody("<https://a.example|[draft] plan>")).toBe(
      "[draft] plan (https://a.example)",
    );
  });
});

describe("SlackMentionRewriter", () => {
  const people = [
    { slackUserId: "U_AVERY", name: "Avery Stone" },
    { slackUserId: "U_LEHUA", name: "Lehua Torres" },
  ];
  const rewrite = (...deltas: string[]) => {
    const r = new SlackMentionRewriter(people);
    return deltas.map((d) => r.push(d)).join("") + r.flush();
  };

  test("turns @Full Name into a real mention, in any case", () => {
    expect(rewrite("Here's the list, @Avery Stone: one more for @lehua torres.")).toBe(
      "Here's the list, <@U_AVERY>: one more for <@U_LEHUA>.",
    );
    expect(rewrite("**@Avery Stone's** call")).toBe("**<@U_AVERY>'s** call");
  });

  test("finds a name split across streamed deltas", () => {
    expect(rewrite("Thanks @Av", "ery St", "one, that helps")).toBe(
      "Thanks <@U_AVERY>, that helps",
    );
  });

  test("holds back only a tail that could still become a name", () => {
    const r = new SlackMentionRewriter(people);
    expect(r.push("ask @Avery St")).toBe("ask ");
    expect(r.push("one")).toBe("");
    expect(r.push("?")).toBe("<@U_AVERY>?");
    // Not the start of anyone's name: nothing is held.
    expect(r.push(" Ping @Hoku now")).toBe(" Ping @Hoku now");
    // A name at the very end waits for the next character, then flushes.
    expect(r.push(" @Lehua Torres")).toBe(" ");
    expect(r.flush()).toBe("<@U_LEHUA>");
  });

  test("a half-written name that never finishes stays text", () => {
    expect(rewrite("over to @Avery St")).toBe("over to @Avery St");
    expect(rewrite("@Avery said so")).toBe("@Avery said so");
    expect(rewrite("@Avery Stonewall")).toBe("@Avery Stonewall");
  });

  test("leaves email addresses and code alone", () => {
    expect(rewrite("write to lehua@Lehua Torres.example")).toBe(
      "write to lehua@Lehua Torres.example",
    );
    expect(rewrite("type `@Avery Stone` then @Avery Stone")).toBe(
      "type `@Avery Stone` then <@U_AVERY>",
    );
  });

  test("never guesses between two people with the same name", () => {
    const r = new SlackMentionRewriter([
      { slackUserId: "U_ONE", name: "Avery Stone" },
      { slackUserId: "U_TWO", name: "Avery Stone" },
      { slackUserId: "U_LEHUA", name: "Lehua Torres" },
    ]);
    expect(r.push("@Avery Stone and @Lehua Torres.") + r.flush()).toBe(
      "@Avery Stone and <@U_LEHUA>.",
    );
  });

  test("leaves an @ inside a link or address alone", () => {
    const r = (text: string) => {
      const w = new SlackMentionRewriter([{ slackUserId: "U_AVERY", name: "Avery" }]);
      return w.push(text) + w.flush();
    };
    expect(r("see https://example.com/@Avery/profile")).toBe(
      "see https://example.com/@Avery/profile",
    );
    expect(r("mail a+@Avery.example")).toBe("mail a+@Avery.example");
    expect(r("(@Avery) and _@Avery_")).toBe("(<@U_AVERY>) and _<@U_AVERY>_");
  });

  test("follows code spans and fences by the length of their backtick run", () => {
    expect(rewrite("``@Avery Stone`` then @Avery Stone")).toBe(
      "``@Avery Stone`` then <@U_AVERY>",
    );
    expect(
      rewrite("```js\nconst s = `@${x}`;\n@Avery Stone\n```\nthanks @Avery Stone"),
    ).toBe("```js\nconst s = `@${x}`;\n@Avery Stone\n```\nthanks <@U_AVERY>");
    // A run split across deltas is read whole.
    expect(rewrite("`", "`@Avery Stone`", "` @Avery Stone")).toBe(
      "``@Avery Stone`` <@U_AVERY>",
    );
  });

  test("a shared name blocks a shorter name inside it", () => {
    const r = new SlackMentionRewriter([
      { slackUserId: "U_SHORT", name: "Avery" },
      { slackUserId: "U_ONE", name: "Avery Stone" },
      { slackUserId: "U_TWO", name: "Avery Stone" },
    ]);
    expect(r.push("@Avery Stone, please review") + r.flush()).toBe(
      "@Avery Stone, please review",
    );
  });

  test("matches names whose case changes their length or ending", () => {
    const one = (name: string, ...deltas: string[]) => {
      const r = new SlackMentionRewriter([{ slackUserId: "U1", name }]);
      return deltas.map((d) => r.push(d)).join("") + r.flush();
    };
    expect(one("İpek", "@İpek!")).toBe("<@U1>!");
    expect(one("ΚΩΣΤΑΣ", "@ΚΩΣ", "ΤΑΣ!")).toBe("<@U1>!");
  });

  test("a combining mark continues a name; a one-letter name can be mentioned", () => {
    const one = (name: string, text: string) => {
      const r = new SlackMentionRewriter([{ slackUserId: "U1", name }]);
      return r.push(text) + r.flush();
    };
    expect(one("Jo", "@Jo\u0308rg")).toBe("@Jo\u0308rg");
    expect(one("李", "@李, please review")).toBe("<@U1>, please review");
  });

  test("an @ inside an address or link stays text even after emphasis characters", () => {
    const r = (text: string) => {
      const w = new SlackMentionRewriter([{ slackUserId: "U_AVERY", name: "Avery" }]);
      return w.push(text) + w.flush();
    };
    expect(r("mail a_@Avery.example")).toBe("mail a_@Avery.example");
    expect(r("see https://example.com/~@Avery/profile")).toBe(
      "see https://example.com/~@Avery/profile",
    );
    expect(r("Reviewers: [@Avery]")).toBe("Reviewers: [<@U_AVERY>]");
    expect(r("see https://example.com/(@Avery)")).toBe("see https://example.com/(@Avery)");
    expect(r("mail a'@Avery.example")).toBe("mail a'@Avery.example");
    expect(r("ask (@Avery) or \"@Avery\"")).toBe('ask (<@U_AVERY>) or "<@U_AVERY>"');
  });

  test("an underscore ends a name only when it closes italics", () => {
    const r = (text: string) => {
      const w = new SlackMentionRewriter([{ slackUserId: "U_AVERY", name: "Avery" }]);
      return w.push(text) + w.flush();
    };
    expect(r("@Avery_Stone is a handle")).toBe("@Avery_Stone is a handle");
    expect(r("ask _@Avery_ first")).toBe("ask _<@U_AVERY>_ first");
    expect(r("_@Avery_Stone_ is a handle")).toBe("_@Avery_Stone_ is a handle");
    expect(rewrite("_Please ask @Avery Stone_ first")).toBe(
      "_Please ask <@U_AVERY>_ first",
    );
    // An underscore at the end of a delta waits to see what follows it.
    expect(rewrite("ask @Avery Stone_", "_ now")).toBe("ask <@U_AVERY>__ now");
  });

  test("a fence closes only on its own line, with at least as many backticks", () => {
    expect(
      rewrite('```js\nconst fence = "```";\n@Avery Stone\n```\nthen @Avery Stone'),
    ).toBe('```js\nconst fence = "```";\n@Avery Stone\n```\nthen <@U_AVERY>');
    expect(rewrite("```\ncode\n````\nthen @Avery Stone")).toBe(
      "```\ncode\n````\nthen <@U_AVERY>",
    );
  });

  test("a Greek name typed in lowercase still matches across deltas", () => {
    const r = new SlackMentionRewriter([{ slackUserId: "U1", name: "ΚΩΣΤΑΣ" }]);
    expect(r.push("@κωσ") + r.push("τας!") + r.flush()).toBe("<@U1>!");
  });

  test("take() hands back a half-read name unsent, to finish elsewhere", () => {
    const people = [
      { slackUserId: "U_SHORT", name: "Avery" },
      { slackUserId: "U_LONG", name: "Avery Stone" },
    ];
    const first = new SlackMentionRewriter(people);
    expect(first.push("ask @Avery St")).toBe("ask ");
    const carried = first.take();
    expect(carried).toBe("@Avery St");
    expect(first.flush()).toBe("");
    // Flushed in place it would have pinged the shorter name.
    const next = new SlackMentionRewriter(people);
    expect(next.push(carried + "one, please.") + next.flush()).toBe("<@U_LONG>, please.");
    // Held backticks are this message's code, not a name: they stay.
    const fenced = new SlackMentionRewriter(people);
    expect(fenced.push("```\ncode\n```")).toBe("```\ncode\n");
    expect(fenced.take()).toBe("");
    expect(fenced.flush()).toBe("```");
  });

  test("prefers the longest name that matches", () => {
    const r = new SlackMentionRewriter([
      { slackUserId: "U_SHORT", name: "Avery" },
      { slackUserId: "U_LONG", name: "Avery Stone" },
    ]);
    expect(r.push("@Avery St") + r.push("one, and @Avery.") + r.flush()).toBe(
      "<@U_LONG>, and <@U_SHORT>.",
    );
  });
});
