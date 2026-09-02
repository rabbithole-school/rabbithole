export type DispatchCompletionReceipt = {
  assignmentId: string;
  teacherName: string;
};

export type DispatchCompletionReceiptKind = "math" | "work";

export function dedupeDispatchCompletionReceipts<
  T extends DispatchCompletionReceipt,
>(receipts: readonly T[]): T[] {
  const seen = new Set<string>();
  return receipts.filter((receipt) => {
    if (seen.has(receipt.assignmentId)) return false;
    seen.add(receipt.assignmentId);
    return true;
  });
}

export function dispatchCompletionReceiptCopy(
  teacherName: string,
  kind: DispatchCompletionReceiptKind,
): string {
  return `That was the ${kind} from ${teacherName} — done.`;
}
