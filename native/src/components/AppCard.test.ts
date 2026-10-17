import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AppCard is the one-app-surface card in a chat-primary session's work panel
 * (TRA-519): title · "Version N" · Open over the live app. These assert the
 * contract the web twin shares — the version reads from the newest saved
 * revision and is absent before any exists, and Open switches THIS session's
 * route to the builder view rather than pushing a new screen.
 */

const { setParams, selectionAsync, fixture } = vi.hoisted(() => ({
  setParams: vi.fn(),
  selectionAsync: vi.fn(),
  fixture: {
    revisions: undefined as
      | { version: number; artifactId: string }[]
      | undefined,
  },
}));

vi.mock("expo-router", () => ({ useRouter: () => ({ setParams }) }));
vi.mock("expo-haptics", () => ({ selectionAsync }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("convex/react", () => ({ useQuery: () => fixture.revisions }));
vi.mock("@/lib/convex", () => ({
  api: { codeArtifactRevisions: { listForSession: "listForSession" } },
}));
vi.mock("@/components/CodeArtifactWebView", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    CodeArtifactWebView: ({ content }: { content: string }) =>
      react.createElement("webview", { content }),
  };
});
vi.mock("@/theme", () => ({
  fonts: { regular: "r", medium: "m", semibold: "s" },
  useColors: () => new Proxy({}, { get: () => "#000" }),
}));
vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  type Props = { children?: unknown; [key: string]: unknown };
  const host =
    (name: string) =>
    ({ children, ...props }: Props) =>
      react.createElement(name, props as never, children as never);
  return {
    Pressable: host("pressable"),
    Text: host("text"),
    View: host("view"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  };
});

import { AppCard, latestVersion } from "./AppCard";

const text = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "children" in node) {
    return text((node as { children: unknown }).children);
  }
  return "";
};

function render(artifact: { title: string; content: string }) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      createElement(AppCard, {
        sessionId: "session" as never,
        artifact: { _id: "app", ...artifact } as never,
      }),
    );
  });
  return tree;
}

describe("latestVersion", () => {
  it("is the highest version number, or null before any is saved", () => {
    expect(latestVersion(undefined)).toBeNull();
    expect(latestVersion([])).toBeNull();
    expect(latestVersion([{ version: 3 }, { version: 4 }, { version: 2 }])).toBe(4);
  });
});

describe("AppCard", () => {
  beforeEach(() => {
    setParams.mockClear();
    selectionAsync.mockClear();
    fixture.revisions = undefined;
  });

  it("shows the title and the newest version beside Open", () => {
    fixture.revisions = [
      { version: 2, artifactId: "app" },
      { version: 1, artifactId: "app" },
    ];
    const tree = render({ title: "Clicker", content: "<html></html>" });
    const rendered = text(tree.toJSON());
    expect(rendered).toContain("Clicker");
    expect(rendered).toContain("Version 2");
    expect(rendered).toContain("Open");
  });

  it("reads only this app's versions, not another app's in the session", () => {
    fixture.revisions = [
      { version: 3, artifactId: "newer-app" },
      { version: 2, artifactId: "app" },
      { version: 1, artifactId: "app" },
    ];
    const tree = render({ title: "Clicker", content: "<html></html>" });
    const rendered = text(tree.toJSON());
    expect(rendered).toContain("Version 2");
    expect(rendered).not.toContain("Version 3");
  });

  it("omits the version until one has been saved", () => {
    const tree = render({ title: "Clicker", content: "<html></html>" });
    expect(text(tree.toJSON())).not.toContain("Version");
  });

  it("opens the builder view of this same session, on this app", () => {
    const tree = render({ title: "Clicker", content: "<html></html>" });
    const open = tree.root.findAll(
      (n) => typeof n.type === "string" && n.props.accessibilityRole === "button",
    )[0];
    act(() => open.props.onPress());
    expect(setParams).toHaveBeenCalledWith({ view: "builder", app: "app" });
    expect(selectionAsync).toHaveBeenCalledOnce();
  });

  it("runs the live app, or says it is empty when nothing is built", () => {
    const live = render({ title: "Clicker", content: "<html></html>" });
    expect(live.root.findAllByType("webview" as never)).toHaveLength(1);
    const empty = render({ title: "Clicker", content: "  " });
    expect(empty.root.findAllByType("webview" as never)).toHaveLength(0);
    expect(text(empty.toJSON())).toContain("Nothing here yet");
  });
});
