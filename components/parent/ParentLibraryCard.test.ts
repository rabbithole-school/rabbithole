import { describe, expect, test } from "vitest";

import {
  createLibraryCardUiState,
  libraryCardUiReducer,
  publicLibraryCardError,
} from "./libraryCardState";
import { LibraryCardForm, ParentLibraryCardView } from "./ParentLibraryCard";

const noop = () => undefined;

describe("ParentLibraryCard component states", () => {
  test("empty state offers the Hawaii State Library card add action", () => {
    const element = ParentLibraryCardView({
      status: {
        onFile: false,
        maskedCardNumber: null,
        pinSaved: false,
        revision: 0,
      },
      state: createLibraryCardUiState("child-a"),
      onStartEdit: noop,
      onStartRemove: noop,
      onCancel: noop,
      onCardNumberChange: noop,
      onPinChange: noop,
      onTogglePin: noop,
      onSave: noop,
      onRemove: noop,
    });
    expect(JSON.stringify(element)).toContain("Hawaii State Library card");
    expect(JSON.stringify(element)).toContain(
      "Don’t have one yet? No worries—we’ll sign your child up when our class visits the library.",
    );
    expect(JSON.stringify(element)).toContain(
      "Add Hawaii State Library card",
    );
  });

  test("on-file state shows only the masked number and PIN status", () => {
    const rendered = JSON.stringify(
      ParentLibraryCardView({
        status: {
          onFile: true,
          maskedCardNumber: "•••• 7890",
          pinSaved: true,
          revision: 2,
        },
        state: createLibraryCardUiState("child-a"),
        onStartEdit: noop,
        onStartRemove: noop,
        onCancel: noop,
        onCardNumberChange: noop,
        onPinChange: noop,
        onTogglePin: noop,
        onSave: noop,
        onRemove: noop,
      }),
    );
    expect(rendered).toContain("•••• 7890");
    expect(rendered).toContain("PIN saved");
    expect(rendered).toContain("Update");
    expect(rendered).not.toContain("Remove card");
    expect(rendered).not.toContain("1234567890");
  });

  test("replacement form never prefills the card number or PIN", () => {
    const state = libraryCardUiReducer(
      createLibraryCardUiState("child-a"),
      { type: "startEdit" },
    );
    const rendered = JSON.stringify(
      LibraryCardForm({
        replacing: true,
        state,
        onCardNumberChange: noop,
        onPinChange: noop,
        onTogglePin: noop,
        onCancel: noop,
        onSave: noop,
        onStartRemove: noop,
      }),
    );
    expect(state.cardNumber).toBe("");
    expect(state.pin).toBe("");
    expect(rendered).toContain('"type":"password"');
    expect(rendered).toContain("Show PIN");
    expect(rendered).toContain("The existing PIN is never shown or prefilled.");
    expect(rendered).toContain("Remove card");
    expect(rendered).toContain(
      "The card can be in your child’s name or a parent or guardian’s name.",
    );
  });

  test("switching children clears sensitive drafts and notices", () => {
    let state = createLibraryCardUiState("child-a");
    state = libraryCardUiReducer(state, { type: "startEdit" });
    state = libraryCardUiReducer(state, {
      type: "setCardNumber",
      value: "draft-card",
    });
    state = libraryCardUiReducer(state, {
      type: "setPin",
      value: "draft-pin",
    });
    state = libraryCardUiReducer(state, {
      type: "selectChild",
      scholarId: "child-b",
    });
    expect(state).toEqual(createLibraryCardUiState("child-b"));
  });

  test("redacts unexpected errors while preserving safe validation copy", () => {
    expect(
      publicLibraryCardError({
        data: {
          kind: "library_card_validation",
          code: "pin_required",
          field: "pin",
          message: "Enter the library card PIN.",
        },
      }),
    ).toEqual({
      field: "pin",
      message: "Enter the library card PIN.",
    });
    expect(
      publicLibraryCardError(
        new Error("secret request internals and credential payload"),
      ).message,
    ).toBe(
      "We couldn’t update the library card. Try again. If this keeps happening, contact the school office for help.",
    );
  });
});
