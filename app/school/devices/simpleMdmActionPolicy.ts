export type SimpleMdmActionPolicy =
  | {
      status: "loading";
      showPushActions: false;
      canAssign: false;
      assignmentBehavior: "wait";
    }
  | {
      status: "configured";
      showPushActions: true;
      canAssign: true;
      assignmentBehavior: "push";
    }
  | {
      status: "unconfigured";
      showPushActions: false;
      canAssign: true;
      assignmentBehavior: "fallback";
    };

export function getSimpleMdmActionPolicy(
  configured: boolean | undefined,
): SimpleMdmActionPolicy {
  if (configured === undefined) {
    return {
      status: "loading",
      showPushActions: false,
      canAssign: false,
      assignmentBehavior: "wait",
    };
  }
  if (configured) {
    return {
      status: "configured",
      showPushActions: true,
      canAssign: true,
      assignmentBehavior: "push",
    };
  }
  return {
    status: "unconfigured",
    showPushActions: false,
    canAssign: true,
    assignmentBehavior: "fallback",
  };
}
