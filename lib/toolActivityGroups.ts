// Moved to convex/lib so the Convex backend (Slack bot status + summaries)
// and the web UI share one source of truth. This shim keeps the `@/lib/...`
// import path working for the frontend + existing tests.
export * from "../convex/lib/toolActivityGroups";
