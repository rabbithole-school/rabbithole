// @vitest-environment jsdom
// The custom-app frame must not be server-rendered: a server-rendered srcdoc
// can load and send its bridge `ready` before React hydrates and attaches the
// host's listener, so the app never receives `init` (seen live with the
// Python bench launcher tile: its editor stayed read-only).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ isLoading: false, isAuthenticated: false }));
const queryArgs = vi.hoisted(() => [] as unknown[]);
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: auth.isLoading, isAuthenticated: auth.isAuthenticated }),
  useQuery: (_fn: unknown, args: unknown) => {
    queryArgs.push(args);
    return null;
  },
  useMutation: () => vi.fn(),
}));
vi.mock("./useCustomAppActivity", () => ({ useCustomAppActivity: () => {} }));

import { CustomAppHost } from "./CustomAppHost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  token: "test-token",
  name: "Test app",
  srcDoc: "<p>app</p>",
  csp: "default-src 'none'",
  credit: null,
  trackLaunch: false,
};

test("renders no frame on the server", () => {
  expect(renderToString(createElement(CustomAppHost, props))).not.toContain("<iframe");
});

test("mounts the frame on the client once the device key is set", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(CustomAppHost, props)));
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("srcdoc")).toBe("<p>app</p>");
  await act(async () => root.unmount());
});

// State is keyed to the signed-in user server-side, so reading it (or letting
// the app restore from it) before auth settles would read the device's copy.
test("waits for auth to settle before reading state or mounting the frame", async () => {
  auth.isLoading = true;
  queryArgs.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(CustomAppHost, props)));
  expect(container.querySelector("iframe")).toBeNull();
  expect(queryArgs.every((args) => args === "skip")).toBe(true);
  auth.isLoading = false;
  await act(async () => root.render(createElement(CustomAppHost, { ...props })));
  expect(container.querySelector("iframe")).not.toBeNull();
  expect(queryArgs.at(-1)).toMatchObject({ token: "test-token", key: "default" });
  await act(async () => root.unmount());
});

// Signing in elsewhere switches the save partition; the open app must not
// carry what it loaded as the device into the scholar's own save.
test("restarts the app when the viewer signs in or out", async () => {
  auth.isLoading = false;
  auth.isAuthenticated = false;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(CustomAppHost, props)));
  const before = container.querySelector("iframe");
  expect(before).not.toBeNull();
  auth.isAuthenticated = true;
  await act(async () => root.render(createElement(CustomAppHost, { ...props })));
  const after = container.querySelector("iframe");
  expect(after).not.toBeNull();
  expect(after).not.toBe(before);
  await act(async () => root.unmount());
});
