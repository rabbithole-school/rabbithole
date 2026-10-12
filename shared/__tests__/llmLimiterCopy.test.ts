import { describe, expect, it } from "vitest";

import { busyRetryCopy } from "../llmLimiter";

describe("busyRetryCopy", () => {
  it("says the wait the server asked for", () => {
    expect(busyRetryCopy(5)).toMatch(/a few seconds/);
    expect(busyRetryCopy(45)).toMatch(/about a minute/);
    expect(busyRetryCopy(174)).toMatch(/about 3 minutes/);
    expect(busyRetryCopy(null)).toMatch(/a little while/);
  });

  it("never promises seconds for a long wait", () => {
    expect(busyRetryCopy(174)).not.toMatch(/seconds/);
  });
});
