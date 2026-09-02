"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function useLearnerContext(enabled: boolean) {
  const memberships = useQuery(
    api.memberships.myMemberships,
    enabled ? {} : "skip",
  );
  return {
    hasLearnerContext:
      memberships?.some((membership) => membership.role === "scholar") ?? false,
    isLearnerContextLoading: enabled && memberships === undefined,
  };
}
