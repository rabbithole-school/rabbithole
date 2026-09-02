import { Dialog } from "@chakra-ui/react";

type StyledDialogContentProps = React.ComponentProps<typeof Dialog.Content>;

export function StyledDialogContent({
  children,
  maxW = "sm",
  w,
  ...contentProps
}: StyledDialogContentProps) {
  return (
    <Dialog.Content
      {...contentProps}
      maxW={maxW}
      w={w}
      mx={4}
      borderRadius="xl"
      overflow="hidden"
    >
      {children}
    </Dialog.Content>
  );
}
