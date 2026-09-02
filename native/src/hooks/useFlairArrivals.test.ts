import { createElement, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

// The vendored copy is what the iPad actually runs, and CI fails if it drifts
// from shared/useFlairArrivals.ts — so testing it covers both frontends.
import { useFlairArrivals } from "../../vendor/shared/useFlairArrivals";

type ProbeProps = { ids?: readonly string[]; resetKey?: string };

/** Records what the hook returned on each committed render. */
function renderProbe(strict = false) {
  const seen: (readonly string[])[] = [];
  function Probe({ ids, resetKey }: ProbeProps) {
    seen.push(useFlairArrivals(ids, resetKey));
    return null;
  }
  const wrap = (props: ProbeProps) =>
    strict
      ? createElement(StrictMode, null, createElement(Probe, props))
      : createElement(Probe, props);

  let renderer!: ReactTestRenderer;
  const render = (props: ProbeProps) => {
    seen.length = 0;
    act(() => {
      if (renderer) renderer.update(wrap(props));
      else renderer = create(wrap(props));
    });
    return seen[seen.length - 1];
  };
  return { render, unmount: () => act(() => renderer.unmount()) };
}

describe("useFlairArrivals", () => {
  it("animates nothing while the query behind the ids is unresolved", () => {
    const { render } = renderProbe();
    expect(render({ ids: undefined })).toEqual([]);
  });

  it("animates nothing on a first resolved snapshot that already has flair", () => {
    const { render } = renderProbe();
    expect(render({ ids: ["a", "b"] })).toEqual([]);
    // A re-render with the same content (a stream tick) changes nothing.
    expect(render({ ids: ["a", "b"] })).toEqual([]);
  });

  it("animates the FIRST award on a deliverable that resolved empty", () => {
    const { render } = renderProbe();
    expect(render({ ids: [] })).toEqual([]);
    expect(render({ ids: ["a"] })).toEqual(["a"]);
  });

  it("still animates the first award under StrictMode's double invoke", () => {
    const { render } = renderProbe(true);
    expect(render({ ids: [] })).toEqual([]);
    expect(render({ ids: ["a"] })).toEqual(["a"]);
  });

  it("holds the arriving id steady across re-renders so the entrance finishes", () => {
    const { render } = renderProbe();
    render({ ids: [] });
    expect(render({ ids: ["a"] })).toEqual(["a"]);
    // Fresh array instance, same content — a live stream re-renders constantly.
    expect(render({ ids: ["a"] })).toEqual(["a"]);
  });

  it("animates nothing when a reconnect replays the same ids", () => {
    const { render } = renderProbe();
    render({ ids: ["a"] });
    render({ ids: undefined });
    expect(render({ ids: ["a"] })).toEqual([]);
  });

  it("animates only the delta of a successive award", () => {
    const { render } = renderProbe();
    render({ ids: [] });
    expect(render({ ids: ["a"] })).toEqual(["a"]);
    expect(render({ ids: ["a", "b"] })).toEqual(["b"]);
    expect(render({ ids: ["a", "b", "c"] })).toEqual(["c"]);
  });

  it("keeps a batch in display order so the stagger follows the verdict order", () => {
    const { render } = renderProbe();
    render({ ids: [] });
    expect(render({ ids: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
  });

  it("re-baselines on a reset key so switching subjects animates nothing", () => {
    const { render } = renderProbe();
    render({ ids: ["a"], resetKey: "session-1" });
    // The other session's existing flair must not read as arriving.
    expect(render({ ids: ["x", "y"], resetKey: "session-2" })).toEqual([]);
    expect(render({ ids: ["x", "y", "z"], resetKey: "session-2" })).toEqual(["z"]);
  });

  it("baselines everything a fresh instance finds (remount, orientation, drawer)", () => {
    const first = renderProbe();
    first.render({ ids: [] });
    expect(first.render({ ids: ["a"] })).toEqual(["a"]);
    first.unmount();

    const remounted = renderProbe();
    expect(remounted.render({ ids: ["a"] })).toEqual([]);
  });
});
