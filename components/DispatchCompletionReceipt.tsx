import { HStack, Text, VStack } from "@chakra-ui/react";
import { Check } from "@phosphor-icons/react";
import {
  dispatchCompletionReceiptCopy,
  type DispatchCompletionReceipt as DispatchCompletionReceiptData,
  type DispatchCompletionReceiptKind,
} from "@/shared/dispatchCompletionReceipt";

export function DispatchCompletionReceipt({
  receipts,
  kind,
}: {
  receipts: readonly DispatchCompletionReceiptData[];
  kind: DispatchCompletionReceiptKind;
}) {
  if (receipts.length === 0) return null;

  return (
    <VStack
      w="full"
      align="stretch"
      gap={1.5}
      borderTopWidth="1px"
      borderColor="border.subtle"
      pt={2.5}
      mt={2}
    >
      {receipts.map((receipt) => (
        <HStack key={receipt.assignmentId} gap={2} align="flex-start">
          <Check
            aria-hidden
            size={15}
            weight="bold"
            color="var(--chakra-colors-green-600)"
            style={{ flex: "0 0 auto", marginTop: 2 }}
          />
          <Text
            fontFamily="body"
            fontSize="sm"
            lineHeight="1.45"
            color="fg.muted"
            textAlign="left"
          >
            {dispatchCompletionReceiptCopy(receipt.teacherName, kind)}
          </Text>
        </HStack>
      ))}
    </VStack>
  );
}
