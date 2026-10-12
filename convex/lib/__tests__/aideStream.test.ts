import { describe, expect, test, vi } from "vitest";
import { MODELS, MODEL_DISPLAY } from "../models";
import {
  refusalNotice,
  refusalNoticeFor,
  refusalRetryTarget,
  anthropicErrorMessage,
  createToolReportTracker,
} from "../aideStream";
import {
  UNREPORTED_TOOL_RESULT,
  isFailureResult,
} from "../toolActivityGroups";

// ── Refusal handling — retry the REQUEST, never re-pin the PERSON ─────────
//
// The 2026-09-03 incident: Fable's classifier false-positived on "show a
// picture of a fulcrum", the notice told a staff member to switch models and
// resend, and the only switch available wrote a PERMANENT all-surfaces pin.
// He never got the next fleet model. These tests pin the new contract: the
// runner retries once on a fallback, and the notice never prescribes a
// setting change.

describe("refusalRetryTarget", () => {
  const clean = { refused: true, fullContent: "", toolsUsed: false };

  test("a clean Fable refusal retries on Opus", () => {
    expect(refusalRetryTarget({ ...clean, model: MODELS.FABLE })).toBe(
      MODELS.OPUS,
    );
  });

  test("no refusal → no retry", () => {
    expect(
      refusalRetryTarget({ ...clean, refused: false, model: MODELS.FABLE }),
    ).toBeNull();
  });

  test("never retries once text has streamed (it would duplicate a half-answer)", () => {
    expect(
      refusalRetryTarget({
        ...clean,
        fullContent: "Here's the first half…",
        model: MODELS.FABLE,
      }),
    ).toBeNull();
  });

  test("never retries once a tool ran (it would re-fire its side effects)", () => {
    expect(
      refusalRetryTarget({ ...clean, toolsUsed: true, model: MODELS.FABLE }),
    ).toBeNull();
  });

  test("models without a classifier tier have no fallback to retry onto", () => {
    for (const model of [MODELS.SONNET, MODELS.OPUS, MODELS.HAIKU]) {
      expect(refusalRetryTarget({ ...clean, model })).toBeNull();
    }
  });

  /**
   * Fable thinks before it speaks, so on a staff surface a reasoning block is
   * streamed before essentially every refusal. Reasoning is live-only (see
   * lib/thinkingStreamState.ts) and never becomes part of the answer, so it is
   * NOT committed output — adding it to the gate would silently turn this
   * retry off on the surface the incident happened on. Pinned here because
   * reviewers keep proposing exactly that.
   */
  test("streamed reasoning alone does not block the retry — only answer text does", () => {
    expect(refusalRetryTarget({ ...clean, model: MODELS.FABLE })).toBe(
      MODELS.OPUS,
    );
    expect(
      refusalRetryTarget({ ...clean, fullContent: " ", model: MODELS.FABLE }),
    ).toBeNull();
  });
});

describe("refusalNoticeFor", () => {
  test("a clean run says nothing at all", () => {
    expect(
      refusalNoticeFor({
        refusedModel: MODELS.FABLE,
        retriedOnto: null,
        stillRefused: false,
      }),
    ).toBeNull();
  });

  test("a successful retry DISCLOSES which model answered and that nothing changed", () => {
    const notice = refusalNoticeFor({
      refusedModel: MODELS.FABLE,
      retriedOnto: MODELS.OPUS,
      stillRefused: false,
    });
    expect(notice).toContain(MODEL_DISPLAY[MODELS.OPUS]);
    expect(notice).toMatch(/nothing about your settings changed/i);
    // The whole point: never ask the user to go change a model themselves.
    expect(notice).not.toMatch(/switch/i);
    expect(notice).not.toMatch(/model picker/i);
  });

  test("a retry that also refused asks for a rephrase, not a model change", () => {
    const notice = refusalNoticeFor({
      refusedModel: MODELS.FABLE,
      retriedOnto: MODELS.OPUS,
      stillRefused: true,
    });
    expect(notice).toMatch(/rephras/i);
    expect(notice).toContain(MODEL_DISPLAY[MODELS.OPUS]);
    expect(notice).not.toMatch(/switch/i);
  });

  test("an unretryable refusal suggests a rephrase and names no other model", () => {
    const notice = refusalNoticeFor({
      refusedModel: MODELS.SONNET,
      retriedOnto: null,
      stillRefused: true,
    });
    expect(notice).toMatch(/rephras/i);
    expect(notice).not.toMatch(/Opus/);
    expect(notice).not.toMatch(/switch/i);
    expect(notice).not.toMatch(/model picker/i);
  });
});

describe("refusalNotice", () => {
  test("names the refusing model by its CURRENT display label, not a hand-written one", () => {
    // The stale-copy failure mode: "Claude Fable 5" outlived the 5 → 5.1 bump
    // in the set_aide_model description. Derive, never hand-sync.
    const notice = refusalNotice(MODELS.FABLE, { kind: "declined" });
    expect(notice).toContain(MODEL_DISPLAY[MODELS.FABLE]);
  });

  test("an unknown/retired model id degrades to the raw slug instead of throwing", () => {
    const notice = refusalNotice("claude-fable-5", { kind: "declined" });
    expect(notice).toContain("claude-fable-5");
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

