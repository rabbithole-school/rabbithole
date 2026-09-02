"use client";

import { useEffect, useReducer } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Field,
  Heading,
  HStack,
  IconButton,
  Input,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  ArrowRight,
  CreditCard,
  Eye,
  EyeSlash,
  Trash,
} from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  LIBRARY_CARD_CARDHOLDER_COPY,
  LIBRARY_CARD_HELPER_COPY,
  libraryCardValidationIssue,
} from "@/shared/libraryCard";
import { FormCompletionBadge } from "./FormCompletionBadge";
import { ParentFormCardShell } from "./ParentFormCardShell";
import {
  createLibraryCardUiState,
  libraryCardUiReducer,
  publicLibraryCardError,
  type LibraryCardUiState,
} from "./libraryCardState";

export type ParentLibraryCardStatus = {
  onFile: boolean;
  maskedCardNumber: string | null;
  pinSaved: boolean;
  revision: number;
};

export function ParentLibraryCard({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const status = useQuery(api.libraryCards.getStatus, { scholarId });
  const replaceCard = useMutation(api.libraryCards.replace);
  const removeCard = useMutation(api.libraryCards.remove);
  const [state, dispatch] = useReducer(
    libraryCardUiReducer,
    String(scholarId),
    createLibraryCardUiState,
  );

  useEffect(() => {
    dispatch({ type: "selectChild", scholarId: String(scholarId) });
  }, [scholarId]);

  const handleSave = async () => {
    if (!status) return;
    const issue = libraryCardValidationIssue(state.cardNumber, state.pin);
    if (issue) {
      dispatch({
        type: "failure",
        message: issue.message,
        field: issue.field,
      });
      return;
    }
    dispatch({ type: "submit" });
    try {
      await replaceCard({
        scholarId,
        cardNumber: state.cardNumber,
        pin: state.pin,
        expectedRevision: status.revision,
      });
      dispatch({
        type: "success",
        message: status.onFile
          ? "Hawaii State Library card updated."
          : "Hawaii State Library card saved.",
      });
    } catch (error) {
      dispatch({ type: "failure", ...publicLibraryCardError(error) });
    }
  };

  const handleRemove = async () => {
    if (!status) return;
    dispatch({ type: "submit" });
    try {
      await removeCard({
        scholarId,
        expectedRevision: status.revision,
      });
      dispatch({
        type: "success",
        message: "Hawaii State Library card removed.",
      });
    } catch (error) {
      dispatch({ type: "failure", ...publicLibraryCardError(error) });
    }
  };

  if (status === undefined) {
    return (
      <HStack justify="center" py={6} aria-label="Loading library card">
        <Spinner size="sm" color="violet.500" />
      </HStack>
    );
  }

  return (
    <ParentLibraryCardView
      status={status}
      state={state}
      onStartEdit={() => dispatch({ type: "startEdit" })}
      onStartRemove={() => dispatch({ type: "startRemove" })}
      onCancel={() => dispatch({ type: "cancel" })}
      onCardNumberChange={(value) =>
        dispatch({ type: "setCardNumber", value })
      }
      onPinChange={(value) => dispatch({ type: "setPin", value })}
      onTogglePin={() => dispatch({ type: "togglePin" })}
      onSave={() => void handleSave()}
      onRemove={() => void handleRemove()}
    />
  );
}

export function ParentLibraryCardView({
  status,
  state,
  onStartEdit,
  onStartRemove,
  onCancel,
  onCardNumberChange,
  onPinChange,
  onTogglePin,
  onSave,
  onRemove,
}: {
  status: ParentLibraryCardStatus;
  state: LibraryCardUiState;
  onStartEdit: () => void;
  onStartRemove: () => void;
  onCancel: () => void;
  onCardNumberChange: (value: string) => void;
  onPinChange: (value: string) => void;
  onTogglePin: () => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  return (
    <ParentFormCardShell labelledBy="library-card-heading">
      <Stack
        direction={{ base: "column", md: "row" }}
        align={{ base: "stretch", md: "center" }}
        gap={4}
      >
        <Box
          flexShrink={0}
          display="inline-flex"
          alignSelf="flex-start"
          position="relative"
          p={2}
          bg={status.onFile ? "green.50" : "violet.50"}
          borderRadius="lg"
          color={status.onFile ? "green.700" : "violet.600"}
          aria-hidden="true"
        >
          <CreditCard size={24} weight="duotone" />
          {status.onFile && <FormCompletionBadge />}
        </Box>

        <VStack align="stretch" gap={3} flex={1}>
          <Box>
            <Heading
              id="library-card-heading"
              size="sm"
              fontFamily="heading"
              color="navy.500"
            >
              Hawaii State Library card
            </Heading>
            {status.onFile ? (
              <VStack align="stretch" gap={0.5} mt={1}>
                <Text
                  fontFamily="mono"
                  fontSize="sm"
                  color="charcoal.500"
                  aria-label={`Library card ending in ${status.maskedCardNumber?.slice(-4) ?? "unknown"}`}
                >
                  {status.maskedCardNumber}
                </Text>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  {status.pinSaved ? "PIN saved" : "PIN not saved"}
                </Text>
              </VStack>
            ) : (
              <Text
                mt={1}
                fontSize="sm"
                fontFamily="body"
                color="charcoal.500"
              >
                {LIBRARY_CARD_HELPER_COPY}
              </Text>
            )}
          </Box>

          {state.notice && (
            <Text
              role="status"
              fontSize="sm"
              fontFamily="body"
              color="green.700"
            >
              {state.notice}
            </Text>
          )}

          {state.mode === "edit" ? (
            <LibraryCardForm
              replacing={status.onFile}
              state={state}
              onCardNumberChange={onCardNumberChange}
              onPinChange={onPinChange}
              onTogglePin={onTogglePin}
              onCancel={onCancel}
              onSave={onSave}
              onStartRemove={onStartRemove}
            />
          ) : state.mode === "remove" ? (
            <Box
              bg="red.50"
              borderWidth="1px"
              borderColor="red.100"
              borderRadius="lg"
              p={3}
            >
              <Text fontSize="sm" fontFamily="body" color="red.800">
                Remove this saved card and PIN? Library apps will stop signing in
                automatically until a new card is added.
              </Text>
              {state.error && (
                <Text role="alert" mt={2} fontSize="sm" color="red.700">
                  {state.error}
                </Text>
              )}
              <HStack mt={3} gap={2} justify="flex-end">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.busy}
                  onClick={onCancel}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  colorPalette="red"
                  loading={state.busy}
                  onClick={onRemove}
                >
                  Remove card
                </Button>
              </HStack>
            </Box>
          ) : null}
        </VStack>

        {state.mode === "view" && (
          <Stack
            direction={{ base: "column", sm: "row" }}
            gap={2}
            align={{ base: "stretch", sm: "center" }}
            alignSelf={{ base: "stretch", md: "center" }}
            flexShrink={0}
          >
            <Button
              size="sm"
              variant={status.onFile ? "ghost" : "solid"}
              colorPalette="violet"
              onClick={onStartEdit}
            >
              {status.onFile
                ? "Update"
                : "Add Hawaii State Library card"}
              {status.onFile && <ArrowRight size={16} weight="bold" />}
            </Button>
          </Stack>
        )}
      </Stack>
    </ParentFormCardShell>
  );
}

export function LibraryCardForm({
  replacing,
  state,
  onCardNumberChange,
  onPinChange,
  onTogglePin,
  onCancel,
  onSave,
  onStartRemove,
}: {
  replacing: boolean;
  state: LibraryCardUiState;
  onCardNumberChange: (value: string) => void;
  onPinChange: (value: string) => void;
  onTogglePin: () => void;
  onCancel: () => void;
  onSave: () => void;
  onStartRemove: () => void;
}) {
  return (
    <VStack
      as="form"
      align="stretch"
      gap={4}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      {replacing && (
        <Text fontSize="sm" fontFamily="body" color="charcoal.500">
          Enter the complete card number and PIN to replace the saved
          credentials. The existing PIN is never shown or prefilled.
        </Text>
      )}
      <Field.Root invalid={state.errorField === "cardNumber"} required>
        <Field.Label>
          {replacing ? "New library card number" : "Library card number"}
        </Field.Label>
        <Input
          value={state.cardNumber}
          onChange={(event) => onCardNumberChange(event.target.value)}
          autoComplete="off"
          disabled={state.busy}
          maxLength={64}
        />
        {state.errorField === "cardNumber" && (
          <Field.ErrorText>{state.error}</Field.ErrorText>
        )}
        <Field.HelperText>{LIBRARY_CARD_CARDHOLDER_COPY}</Field.HelperText>
      </Field.Root>

      <Field.Root invalid={state.errorField === "pin"} required>
        <Field.Label>{replacing ? "New PIN" : "PIN"}</Field.Label>
        <Box position="relative">
          <Input
            type={state.showPin ? "text" : "password"}
            value={state.pin}
            onChange={(event) => onPinChange(event.target.value)}
            autoComplete="new-password"
            disabled={state.busy}
            maxLength={64}
            pe="3rem"
          />
          <IconButton
            type="button"
            aria-label={state.showPin ? "Hide PIN" : "Show PIN"}
            title={state.showPin ? "Hide PIN" : "Show PIN"}
            variant="ghost"
            size="sm"
            position="absolute"
            top="50%"
            right={1}
            transform="translateY(-50%)"
            disabled={state.busy}
            onClick={onTogglePin}
          >
            {state.showPin ? <EyeSlash /> : <Eye />}
          </IconButton>
        </Box>
        {state.errorField === "pin" && (
          <Field.ErrorText>{state.error}</Field.ErrorText>
        )}
      </Field.Root>

      {state.error && !state.errorField && (
        <Text role="alert" fontSize="sm" fontFamily="body" color="red.700">
          {state.error}
        </Text>
      )}

      <Stack
        direction={{ base: "column-reverse", sm: "row" }}
        justify={replacing ? "space-between" : "flex-end"}
        gap={2}
      >
        {replacing && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            colorPalette="red"
            disabled={state.busy}
            onClick={onStartRemove}
          >
            <Trash weight="bold" />
            Remove card
          </Button>
        )}
        <HStack gap={2} justify="flex-end">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={state.busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            colorPalette="violet"
            loading={state.busy}
          >
            {replacing ? "Replace card" : "Save card"}
          </Button>
        </HStack>
      </Stack>
    </VStack>
  );
}
