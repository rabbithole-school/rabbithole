// Compatibility for the released iPad build; remove after next /ipad-release.
export {
  listSimulatorActivities as listWorldActivities,
  getSimulatorSpec as getWorldSpec,
  simulatorDesign as worldDesign,
  saveSimulatorSpec as saveWorldSpec,
  createSimulatorActivityInternal as createWorldActivityInternal,
  setSimulatorSpecInternal as setWorldSpecInternal,
  resyncSystemsAgents,
  backfillSystemsAgentsContent,
  resyncCooperationConflict,
  backfillCooperationConflictContent,
  prepareLiveSmoke,
} from "./simulator";
