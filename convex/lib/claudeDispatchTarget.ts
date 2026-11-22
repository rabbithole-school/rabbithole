// Deployment configuration — see DEPLOYMENT.md (Claude Tag dispatch target).
/**
 * Foundation's neutral target for automatic Claude Tag requests
 * (convex/claudeDispatch.ts). Adopters replace it with the repository Claude
 * Tag should scope requests in and the person who reviews its draft PRs.
 */
export const CLAUDE_DISPATCH_TARGET = {
  repo: "rabbithole-school/rabbithole",
  reviewer: "A maintainer",
} as const;
