import { describe, expect, it, vi } from "vitest";

const state: unknown[] = [];
let stateIndex = 0;
const signIn = vi.fn();

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: vi.fn(),
    useRef: <T,>(initialValue: T) => ({ current: initialValue }),
    useState: <T,>(initialValue: T) => {
      const index = stateIndex++;
      state[index] ??= initialValue;
      return [state[index] as T, (value: T) => { state[index] = value; }] as const;
    },
  };
});

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn }) }));
vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isAuthenticated: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null, isLoading: false }) }));
vi.mock("@/convex/_generated/api", () => ({ api: { passkeys: { startAuthentication: "startAuthentication" } } }));
vi.mock("@/lib/passkeyClient", () => ({
  browserSupportsWebAuthn: () => true,
  isPasskeyCancellation: () => false,
  relatedOriginPasskeyFallbackUrl: () => null,
  runPasskeySignIn: vi.fn(),
}));
vi.mock("@/lib/native", () => ({ useDarkShellChrome: vi.fn(), useIsIPad: () => false }));
vi.mock("@/components/PasskeyRelatedOriginFallback", () => ({
  PasskeyRelatedOriginFallback: () => null,
}));

import { AuthCard } from "./AuthForm";

function render() {
  stateIndex = 0;
  return AuthCard({ mode: "signUp" });
}

function findByPlaceholder(node: unknown, placeholder: string): { props: Record<string, unknown> } {
  if (!node || typeof node !== "object") throw new Error(`No input with ${placeholder}`);
  const element = node as { props?: Record<string, unknown> };
  if (element.props?.placeholder === placeholder) return element as { props: Record<string, unknown> };
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    try {
      return findByPlaceholder(child, placeholder);
    } catch {
      // Keep searching sibling branches.
    }
  }
  throw new Error(`No input with ${placeholder}`);
}

function findButton(node: unknown): { props: Record<string, unknown> } {
  if (!node || typeof node !== "object") throw new Error("No button");
  const element = node as { props?: Record<string, unknown> };
  if (element.props?.onClick) return element as { props: Record<string, unknown> };
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    try {
      return findButton(child);
    } catch {
      // Keep searching sibling branches.
    }
  }
  throw new Error("No button");
}

function textContent(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const children = (node as { props?: { children?: unknown } }).props?.children;
  return (Array.isArray(children) ? children : [children]).map(textContent).join("");
}

describe("AuthCard sign-up", () => {
  it("shows the invite-only message without making an auth backend call", async () => {
    state.length = 0;
    signIn.mockReset();

    let tree = render();
    (findByPlaceholder(tree, "Choose a username").props.onChange as (event: unknown) => void)({
      target: { value: "new-scholar" },
    });
    tree = render();
    (findByPlaceholder(tree, "Choose a password").props.onChange as (event: unknown) => void)({
      target: { value: "password" },
    });
    tree = render();

    await (findButton(tree).props.onClick as () => Promise<void>)();
    tree = render();

    expect(signIn).not.toHaveBeenCalled();
    expect(textContent(tree)).toContain(
      "Rabbithole is invite-only — open the invite link you were sent to join.",
    );
  });
});
