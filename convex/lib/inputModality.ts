import { v, type Infer } from "convex/values";

export const inputModalityValidator = v.union(
  v.literal("typed"),
  v.literal("spoken"),
);

export type InputModality = Infer<typeof inputModalityValidator>;
