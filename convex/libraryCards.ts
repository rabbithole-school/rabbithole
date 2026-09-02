// Guardian self-service for the scholar-owned public-library credential.
// The card and PIN stay in users.libraryCredential, shared with every
// credentialSource:"libraryCard" app. Guardian reads return only a masked
// status; plaintext remains confined to the existing owner-only app autofill.

import { ConvexError, v } from "convex/values";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { requireGuardianOf } from "./lib/auth";
import { ROLES } from "./lib/roles";
import {
  libraryCardValidationIssue,
  libraryCredentialRevision,
  maskLibraryCardNumber,
  normalizeLibraryCardInput,
  type LibraryCardConflictError,
  type LibraryCardValidationIssue,
} from "../shared/libraryCard";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isProgramGuest } from "./lib/enrollmentStanding";
import { EXTENDED_EDUCATION_LABEL } from "../shared/scholarGroupRouting";

type LibraryCardStatus = {
  onFile: boolean;
  maskedCardNumber: string | null;
  pinSaved: boolean;
  revision: number;
};

function statusForScholar(scholar: Doc<"users">): LibraryCardStatus {
  const credential = scholar.libraryCredential;
  return {
    onFile: !!credential?.id,
    maskedCardNumber: credential?.id
      ? maskLibraryCardNumber(credential.id)
      : null,
    pinSaved: !!credential?.password,
    revision: libraryCredentialRevision(
      credential,
      scholar.libraryCredentialRevision,
    ),
  };
}

async function requireGuardianScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Doc<"users">["_id"],
): Promise<Doc<"users">> {
  await requireGuardianOf(ctx, scholarId);
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) {
    throw new Error("Scholar not found");
  }
  if (isProgramGuest(scholar)) {
    throw new Error(
      `Library card access isn't available for ${EXTENDED_EDUCATION_LABEL} scholars.`,
    );
  }
  return scholar;
}

function requireExpectedRevision(
  expectedRevision: number,
  scholar: Doc<"users">,
): number {
  const currentRevision = libraryCredentialRevision(
    scholar.libraryCredential,
    scholar.libraryCredentialRevision,
  );
  if (expectedRevision !== currentRevision) {
    throw new ConvexError<LibraryCardConflictError>({
      kind: "library_card_conflict",
      code: "revision_conflict",
      message:
        "Another authorized guardian updated this card. Review the latest status before trying again.",
    });
  }
  return currentRevision;
}

export const getStatus = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const scholar = await requireGuardianScholar(ctx, args.scholarId);
    return statusForScholar(scholar);
  },
});

export const replace = authedMutation({
  args: {
    scholarId: v.id("users"),
    cardNumber: v.string(),
    pin: v.string(),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    const scholar = await requireGuardianScholar(ctx, args.scholarId);
    const issue = libraryCardValidationIssue(args.cardNumber, args.pin);
    if (issue) {
      throw new ConvexError<LibraryCardValidationIssue>(issue);
    }
    const revision = requireExpectedRevision(args.expectedRevision, scholar);
    const normalized = normalizeLibraryCardInput(args.cardNumber, args.pin);
    await ctx.db.patch(args.scholarId, {
      libraryCredential: {
        id: normalized.cardNumber,
        password: normalized.pin,
      },
      libraryCredentialRevision: revision + 1,
    });
    return statusForScholar({
      ...scholar,
      libraryCredential: {
        id: normalized.cardNumber,
        password: normalized.pin,
      },
      libraryCredentialRevision: revision + 1,
    });
  },
});

export const remove = authedMutation({
  args: {
    scholarId: v.id("users"),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    const scholar = await requireGuardianScholar(ctx, args.scholarId);
    const revision = requireExpectedRevision(args.expectedRevision, scholar);
    if (scholar.libraryCredential) {
      await ctx.db.patch(args.scholarId, {
        libraryCredential: undefined,
        libraryCredentialRevision: revision + 1,
      });
    }
    return {
      onFile: false,
      maskedCardNumber: null,
      pinSaved: false,
      revision: scholar.libraryCredential ? revision + 1 : revision,
    } satisfies LibraryCardStatus;
  },
});
