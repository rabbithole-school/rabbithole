"use client";

import type { ReactNode, Ref } from "react";
import { CloseButton, Dialog } from "@chakra-ui/react";

export function SlidesDialogCloseButton({
  ref,
}: {
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Dialog.CloseTrigger asChild>
      <CloseButton ref={ref} size="sm" color="charcoal.400" />
    </Dialog.CloseTrigger>
  );
}

export function SlidesEditorDialogFrame({
  title,
  integratedHeader = false,
  closeButtonRef,
  children,
}: {
  title: string;
  /**
   * The teacher deck editor owns an editable title bar. Other hosts use this
   * frame's standard title and close row.
   */
  integratedHeader?: boolean;
  closeButtonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <Dialog.Content
      display="flex"
      flexDirection="column"
      w="100dvw"
      h="100dvh"
      maxW="none"
      maxH="none"
      borderRadius="0"
      overflow="hidden"
    >
      {integratedHeader ? (
        <Dialog.Title srOnly>{title}</Dialog.Title>
      ) : (
        <Dialog.Header
          px={6}
          py={3}
          display="flex"
          alignItems="center"
          gap={3}
          borderBottomWidth="1px"
          borderColor="gray.200"
          flexShrink={0}
        >
          <Dialog.Title
            color="navy.500"
            fontFamily="heading"
            fontSize="md"
            fontWeight="700"
            flex={1}
            truncate
          >
            {title}
          </Dialog.Title>
          <SlidesDialogCloseButton ref={closeButtonRef} />
        </Dialog.Header>
      )}
      <Dialog.Body p={0} flex={1} minH={0} display="flex">
        {children}
      </Dialog.Body>
    </Dialog.Content>
  );
}
