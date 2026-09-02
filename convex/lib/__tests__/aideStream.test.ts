import { describe, expect, test, vi } from "vitest";
import { MODELS } from "../models";
import {
  refusalNotice,
  anthropicErrorMessage,
  createToolReportTracker,
} from "../aideStream";
import {
  UNREPORTED_TOOL_RESULT,
  isFailureResult,
} from "../toolActivityGroups";

// ── Refusal notice (staff-facing guardrail fallback) ─────────────────────

describe("refusalNotice", () => {
  test("Fable names the concrete fix: switch this chat to Opus via the picker", () => {
    const notice = refusalNotice(MODELS.FABLE);
    expect(notice).toMatch(/Opus/);
    expect(notice).toMatch(/model picker/i);
    // The old, backwards advice ("switch back to the default", which IS Fable)
    // must not resurface.
    expect(notice).not.toMatch(/default/i);
  });

  test("Fable uses the caller's switch hint (e.g. Slack, which has no picker)", () => {
    const notice = refusalNotice(
      MODELS.FABLE,
      'by asking me to switch (e.g. "use Opus")',
    );
    expect(notice).toMatch(/Opus/);
    expect(notice).toMatch(/asking me to switch/);
    // Must NOT tell a Slack user about a picker that isn't there.
    expect(notice).not.toMatch(/model picker/i);
  });

  test("non-Fable models just suggest a rephrase (no nonsensical 'switch to Opus')", () => {
    for (const model of [MODELS.SONNET, MODELS.OPUS, MODELS.HAIKU]) {
      // Even a stray switch hint is ignored off the Fable branch.
      const notice = refusalNotice(model, "with the model picker above");
      expect(notice).toMatch(/rephras/i);
      expect(notice).not.toMatch(/Opus/);
      expect(notice).not.toMatch(/model picker/i);
    }
  });
});

// ── Anthropic error passthrough (surface the real cause, not "try again") ──

describe("anthropicErrorMessage", () => {
  test("extracts the verbatim message from a real Anthropic APIError body", () => {
    // Shape thrown by the SDK for a depleted account (from prod logs).
    const err = {
      status: 400,
      error: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        },
      },
    };
    expect(anthropicErrorMessage(err)).toBe(
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    );
  });

  test("works for other API errors (e.g. rate limit)", () => {
    const err = {
      status: 429,
      error: {
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limit exceeded." },
      },
    };
    expect(anthropicErrorMessage(err)).toBe("Rate limit exceeded.");
  });

  test("falls back to a message directly on .error", () => {
    expect(
      anthropicErrorMessage({ error: { message: "  something upstream  " } }),
    ).toBe("something upstream");
  });

  test("returns null for non-Anthropic errors so the caller keeps its generic fallback", () => {
    expect(anthropicErrorMessage(new Error("boom"))).toBeNull();
    expect(anthropicErrorMessage(null)).toBeNull();
    expect(anthropicErrorMessage(undefined)).toBeNull();
    expect(anthropicErrorMessage("400 bad request")).toBeNull();
    expect(anthropicErrorMessage({ error: {} })).toBeNull();
    expect(anthropicErrorMessage({ error: { error: { message: "  " } } })).toBeNull();
  });
});

// ── Tool-report tracker (settle un-reported tool calls on the SSE stream) ──

describe("createToolReportTracker", () => {
  test("a started tool that never reports is settled with UNREPORTED_TOOL_RESULT", () => {
    const raw = vi.fn();
    const t = createToolReportTracker(raw);
    t.started("dispatch_implementation");
    t.settleUnreported();

    const completions = raw.mock.calls
      .map((c) => c[0].toolComplete)
      .filter(Boolean);
    expect(completions).toEqual([
      { name: "dispatch_implementation", result: UNREPORTED_TOOL_RESULT },
    ]);
    // The synthetic result must be classified as a failure so the row renders "⚠".
    expect(isFailureResult(completions[0].result)).toBe(true);
  });

  test("a started tool that DOES report is not settled, and its result is preserved", () => {
    const raw = vi.fn();
    const t = createToolReportTracker(raw);
    t.started("list_units");
    t.emit({ toolComplete: { name: "list_units", result: "Found 3 units" } });
    t.settleUnreported();

    const completions = raw.mock.calls
      .map((c) => c[0].toolComplete)
      .filter(Boolean);
    // Exactly the tool's own completion — no synthetic overwrite.
    expect(completions).toEqual([{ name: "list_units", result: "Found 3 units" }]);
  });

  test("two parallel calls of the same tool where only one reports → exactly one synthetic completion", () => {
    const raw = vi.fn();
    const t = createToolReportTracker(raw);
    t.started("create_activity");
    t.started("create_activity");
    t.emit({ toolComplete: { name: "create_activity", result: "Created A" } });
    t.settleUnreported();

    const completions = raw.mock.calls
      .map((c) => c[0].toolComplete)
      .filter(Boolean);
    expect(completions).toEqual([
      { name: "create_activity", result: "Created A" },
      { name: "create_activity", result: UNREPORTED_TOOL_RESULT },
    ]);
  });

  test("the wrapper forwards every event untouched, in order", () => {
    const raw = vi.fn();
    const t = createToolReportTracker(raw);
    const events = [
      { text: "hello" },
      { toolStart: { name: "list_units" } },
      { thinking: true },
      { toolComplete: { name: "list_units", result: "Found 3 units" } },
    ];
    for (const e of events) t.emit(e);

    expect(raw.mock.calls.map((c) => c[0])).toEqual(events);
  });

  test("settleUnreported() twice in a row → the second is a no-op", () => {
    const raw = vi.fn();
    const t = createToolReportTracker(raw);
    t.started("dispatch_implementation");
    t.settleUnreported();
    raw.mockClear();
    t.settleUnreported();
    expect(raw).not.toHaveBeenCalled();
  });

  test("mixed: tool A reports, tool B doesn't → only B is settled", () => {
    const raw = vi.fn();
    const t = createToolReportTracker(raw);
    t.started("tool_a");
    t.started("tool_b");
    t.emit({ toolComplete: { name: "tool_a", result: "A ok" } });
    raw.mockClear();
    t.settleUnreported();

    const completions = raw.mock.calls
      .map((c) => c[0].toolComplete)
      .filter(Boolean);
    expect(completions).toEqual([
      { name: "tool_b", result: UNREPORTED_TOOL_RESULT },
    ]);
  });
});

