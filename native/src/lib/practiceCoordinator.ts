import { createKeyedMutex } from "../../vendor/shared/practicePersistenceCore";
import type { CommandId, PracticeCommand } from "../../vendor/shared/practiceMachine";

export type CommandRunner = (command: PracticeCommand) => Promise<void>;

export type PracticeCoordinator = {
  readonly scholarId: string;
  tryClaim(id: CommandId): boolean;
  release(id: CommandId): void;
  isClaimed(id: CommandId): boolean;
  waitForRelease(id: CommandId): Promise<void>;
  execute(command: PracticeCommand, run: CommandRunner): Promise<boolean>;
  executeAll(
    commands: readonly PracticeCommand[],
    run: CommandRunner,
  ): Promise<readonly CommandId[]>;
  retain(): void;
  release_(): boolean;
  readonly inFlight: number;
};

const coordinators = new Map<string, PracticeCoordinator>();

function createCoordinator(scholarId: string): PracticeCoordinator {
  const claimed = new Set<CommandId>();
  const waiters = new Map<CommandId, Set<() => void>>();
  const ordered = createKeyedMutex();
  let references = 0;
  let running = 0;
  let disposeWhenIdle = false;
  const coordinator: PracticeCoordinator = {
    scholarId,
    tryClaim(id) {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    release(id) {
      claimed.delete(id);
      const listeners = waiters.get(id);
      if (!listeners) return;
      waiters.delete(id);
      for (const resolve of listeners) resolve();
    },
    isClaimed(id) {
      return claimed.has(id);
    },
    waitForRelease(id) {
      if (!claimed.has(id)) return Promise.resolve();
      return new Promise((resolve) => {
        const listeners = waiters.get(id) ?? new Set<() => void>();
        listeners.add(resolve);
        waiters.set(id, listeners);
      });
    },
    async execute(command, run) {
      if (!coordinator.tryClaim(command.id)) return false;
      const domain = "domain" in command ? command.domain : null;
      running += 1;
      try {
        if (domain) await ordered(domain, () => run(command));
        else await run(command);
        return true;
      } finally {
        coordinator.release(command.id);
        running -= 1;
        if (running === 0 && disposeWhenIdle && references === 0) {
          coordinators.delete(scholarId);
        }
      }
    },
    async executeAll(commands, run) {
      const seen = new Set<CommandId>();
      const refused: CommandId[] = [];
      for (const command of commands) {
        if (seen.has(command.id)) continue;
        seen.add(command.id);
        if (!(await coordinator.execute(command, run))) refused.push(command.id);
      }
      return refused;
    },
    retain() {
      references += 1;
    },
    release_() {
      references = Math.max(0, references - 1);
      if (references > 0) return false;
      if (running > 0) {
        disposeWhenIdle = true;
        return false;
      }
      return true;
    },
    get inFlight() {
      return running;
    },
  };
  return coordinator;
}

export function acquirePracticeCoordinator(scholarId: string): PracticeCoordinator {
  let coordinator = coordinators.get(scholarId);
  if (!coordinator) {
    coordinator = createCoordinator(scholarId);
    coordinators.set(scholarId, coordinator);
  }
  coordinator.retain();
  return coordinator;
}

export function releasePracticeCoordinator(scholarId: string): void {
  const coordinator = coordinators.get(scholarId);
  if (coordinator?.release_()) coordinators.delete(scholarId);
}

export function __resetPracticeCoordinators(): void {
  coordinators.clear();
}
