import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSession, routerPush, toasterError } = vi.hoisted(() => ({
  createSession: vi.fn(),
  routerPush: vi.fn(),
  toasterError: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T) => [initial, vi.fn()] as const,
  };
});
vi.mock("next/link", () => ({ default: ({ children }: { children?: unknown }) => children }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ unitId: "unit" }),
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));
vi.mock("convex/react", () => ({
  useMutation: () => createSession,
  useQuery: () => null,
}));
vi.mock("@chakra-ui/react", () => ({
  Box: ({ children }: { children?: unknown }) => children,
  Button: ({ children, ...props }: { children?: unknown; [key: string]: unknown }) => ({
    props: { children, ...props },
  }),
  Flex: ({ children }: { children?: unknown }) => children,
  Heading: ({ children }: { children?: unknown }) => children,
  Spinner: () => null,
  Stack: ({ children }: { children?: unknown }) => children,
  Text: ({ children }: { children?: unknown }) => children,
}));
vi.mock("@/convex/_generated/api", () => ({
  api: { sessions: { create: "sessions.create" }, units: { get: "units.get" } },
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ isLoading: false, user: null }),
}));
vi.mock("@/convex/lib/roles", () => ({ isTeacherRole: () => false }));
vi.mock("@/components/ProgressPageShell", () => ({ ProgressPageShell: () => null }));
vi.mock("@/lib/toaster", () => ({ toaster: { error: toasterError } }));

import { IsPlanningEmptyState } from "./page";

function findStartHandler(node: unknown): () => Promise<void> {
  if (!node || typeof node !== "object") throw new Error("No start button");
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props?.onClick && props.children === "✨ Plan this with the AI") {
    return props.onClick as () => Promise<void>;
  }
  const children = props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    try {
      return findStartHandler(child);
    } catch {
      // Continue through sibling branches.
    }
  }
  throw new Error("No start button");
}

describe("IsPlanningEmptyState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows one error toast and does not navigate when planning session creation fails", async () => {
    createSession.mockRejectedValueOnce(new Error("Unit is unavailable"));

    const tree = IsPlanningEmptyState({
      unitId: "unit" as never,
      unitTitle: "Independent study",
      unitEmoji: null,
      isRemoteMode: false,
    });
    await findStartHandler(tree)();

    expect(toasterError).toHaveBeenCalledTimes(1);
    expect(toasterError).toHaveBeenCalledWith({
      title: "Couldn't start that activity",
      description: "Please try again.",
    });
    expect(routerPush).not.toHaveBeenCalled();
  });
});
