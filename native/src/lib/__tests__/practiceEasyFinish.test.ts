import { describe, expect, it, vi } from "vitest";
import { requestBreakerEasyFinish } from "../../../vendor/shared/practiceLoop";

describe("native breaker easy finish", () => {
  it("can retry after a transient request failure", async () => {
    const item = { itemId: "easy#1" };
    const request = vi
      .fn<() => Promise<{ available: boolean; items: typeof item[] }>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ available: true, items: [item] });

    await expect(requestBreakerEasyFinish(request)).rejects.toThrow("transient");
    await expect(requestBreakerEasyFinish(request)).resolves.toEqual({
      item,
      events: [{ type: "easyRequested" }],
    });
  });
});
