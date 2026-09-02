import { describe, expect, it, vi } from "vitest";

import { leaveAccount } from "../accountNavigation";

describe("account navigation", () => {
  it("returns to the originating screen when account was pushed", () => {
    const router = {
      canGoBack: () => true,
      back: vi.fn(),
      replace: vi.fn(),
    };

    leaveAccount(router);

    expect(router.back).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("returns to My Sessions when account is the stack root", () => {
    const router = {
      canGoBack: () => false,
      back: vi.fn(),
      replace: vi.fn(),
    };

    leaveAccount(router);

    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/");
  });
});
