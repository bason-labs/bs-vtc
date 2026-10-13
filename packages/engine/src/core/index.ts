/**
 * Engine core (AD-13; owner: engine-core team, sub-project 1): state, events, scheduler, loops,
 * budgets, triage, escalation, merge queue, tracing. Reaches the Gate Runner only through the
 * `GateRunner` interface and git only through `../git/index.ts`.
 */
export {
  acquireEngineLock,
  EngineLockedError,
  type AcquireLockOptions,
  type EngineLock,
} from "./lock.js";
export {
  openEventLog,
  type EventDraft,
  type EventLogWriter,
  type OpenEventLogOptions,
} from "./event-log.js";
export {
  engineDiscoveryPath,
  readEngineDiscovery,
  removeEngineDiscovery,
  writeEngineDiscovery,
} from "./discovery.js";
