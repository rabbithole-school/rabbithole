import {
  isLibraryCardErrorData,
  type LibraryCardField,
} from "@/shared/libraryCard";

export type LibraryCardMode = "view" | "edit" | "remove";

export type LibraryCardUiState = {
  scholarId: string;
  mode: LibraryCardMode;
  cardNumber: string;
  pin: string;
  showPin: boolean;
  busy: boolean;
  notice: string | null;
  error: string | null;
  errorField: LibraryCardField | null;
};

export type LibraryCardUiAction =
  | { type: "selectChild"; scholarId: string }
  | { type: "startEdit" }
  | { type: "startRemove" }
  | { type: "setCardNumber"; value: string }
  | { type: "setPin"; value: string }
  | { type: "togglePin" }
  | { type: "submit" }
  | { type: "cancel" }
  | { type: "success"; message: string }
  | {
      type: "failure";
      message: string;
      field?: LibraryCardField;
    };

export function createLibraryCardUiState(
  scholarId: string,
): LibraryCardUiState {
  return {
    scholarId,
    mode: "view",
    cardNumber: "",
    pin: "",
    showPin: false,
    busy: false,
    notice: null,
    error: null,
    errorField: null,
  };
}

export function libraryCardUiReducer(
  state: LibraryCardUiState,
  action: LibraryCardUiAction,
): LibraryCardUiState {
  switch (action.type) {
    case "selectChild":
      return createLibraryCardUiState(action.scholarId);
    case "startEdit":
      return {
        ...state,
        mode: "edit",
        cardNumber: "",
        pin: "",
        showPin: false,
        notice: null,
        error: null,
        errorField: null,
      };
    case "startRemove":
      return {
        ...state,
        mode: "remove",
        notice: null,
        error: null,
        errorField: null,
      };
    case "setCardNumber":
      return {
        ...state,
        cardNumber: action.value,
        error: state.errorField === "cardNumber" ? null : state.error,
        errorField:
          state.errorField === "cardNumber" ? null : state.errorField,
      };
    case "setPin":
      return {
        ...state,
        pin: action.value,
        error: state.errorField === "pin" ? null : state.error,
        errorField: state.errorField === "pin" ? null : state.errorField,
      };
    case "togglePin":
      return { ...state, showPin: !state.showPin };
    case "submit":
      return {
        ...state,
        busy: true,
        notice: null,
        error: null,
        errorField: null,
      };
    case "cancel":
      return {
        ...state,
        mode: "view",
        cardNumber: "",
        pin: "",
        showPin: false,
        busy: false,
        error: null,
        errorField: null,
      };
    case "success":
      return {
        ...createLibraryCardUiState(state.scholarId),
        notice: action.message,
      };
    case "failure":
      return {
        ...state,
        busy: false,
        error: action.message,
        errorField: action.field ?? null,
      };
  }
}

function errorData(error: unknown): unknown {
  return error && typeof error === "object" && "data" in error
    ? (error as { data?: unknown }).data
    : undefined;
}

export function publicLibraryCardError(error: unknown): {
  message: string;
  field?: LibraryCardField;
} {
  const data = errorData(error);
  if (isLibraryCardErrorData(data)) {
    return data.kind === "library_card_validation"
      ? { message: data.message, field: data.field }
      : { message: data.message };
  }
  return {
    message:
      "We couldn’t update the library card. Try again. If this keeps happening, contact the school office for help.",
  };
}
