import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSecureTokenStorage,
  type SecureStoreLike,
} from "../secureTokenStorageCore";

function memorySecureStore(): SecureStoreLike & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => {
      values.set(key, value);
    },
    deleteItemAsync: async (key) => {
      values.delete(key);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secure token storage", () => {
  it("surfaces a Keychain read error instead of returning signed-out state", async () => {
    const store = memorySecureStore();
    const failure = new Error("Keychain unavailable");
    store.getItemAsync = vi.fn(async () => {
      throw failure;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const storage = createSecureTokenStorage(store);

    await expect(storage.getItem("auth-token")).rejects.toBe(failure);
    expect(console.error).toHaveBeenCalledWith(
      '[secureTokenStorage] read failed for "auth-token"',
      failure,
    );
  });

  it("surfaces a Keychain write failure", async () => {
    const store = memorySecureStore();
    const failure = new Error("Keychain write failed");
    store.setItemAsync = vi.fn(async () => {
      throw failure;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const storage = createSecureTokenStorage(store);

    await expect(storage.setItem("auth-token", "jwt")).rejects.toBe(failure);
    expect(console.error).toHaveBeenCalledWith(
      '[secureTokenStorage] write failed for "auth-token"',
      failure,
    );
  });

  it("keeps the previous token readable when a chunked refresh is interrupted", async () => {
    const store = memorySecureStore();
    const generations = ["old", "new"];
    const storage = createSecureTokenStorage(
      store,
      () => generations.shift() ?? "unexpected",
    );
    const oldToken = "a".repeat(4000);
    const newToken = "b".repeat(4000);

    await storage.setItem("auth-token", oldToken);
    const realSet = store.setItemAsync;
    store.setItemAsync = vi.fn(async (key, value) => {
      if (key === "auth-token") {
        throw new Error("Process terminated before commit");
      }
      await realSet(key, value);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(storage.setItem("auth-token", newToken)).rejects.toThrow(
      "Process terminated before commit",
    );
    expect(await storage.getItem("auth-token")).toBe(oldToken);
  });

  it("reads tokens written by the legacy chunk format", async () => {
    const store = memorySecureStore();
    store.values.set("auth-token", "__rh_chunked__:2");
    store.values.set("auth-token.0", "legacy-");
    store.values.set("auth-token.1", "token");

    const storage = createSecureTokenStorage(store);

    await expect(storage.getItem("auth-token")).resolves.toBe("legacy-token");
  });
});
