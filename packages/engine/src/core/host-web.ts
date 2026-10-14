/**
 * Where a `host_web` role runs (D-cf, spine §5 reading 200; `hostWebRoute`). Codex has no per-path
 * read deny, so a Codex `host_web` role never gets model-directed live fetching: when Claude Code
 * can run the role it runs there (its role profiles deny the credential stores); otherwise on the
 * Lead's host when that host's web search is safe (`HostCapabilities.safeHostWeb`); otherwise on
 * the Lead's host with no host web search, where the engine's own `web` fetcher still serves the
 * role, and the run shows `HOST_WEB_OFF_NOTICE`.
 */
import {
  HOST_IDS,
  hostWebRoute,
  planDispatch,
  resolveRoleMode,
  type HostId,
  type HostWebRoute,
} from "@vtc/shared";
import type { Kernel } from "./kernel.js";

/**
 * The route of a step's role when it declares `tools.host_web`, or `null` for any other role.
 * `leadHost` is the run's Lead host (`fallback` when no Lead is known); a host is a candidate when
 * its adapter is installed and `planDispatch` can run the role there now.
 */
export const hostWebRouteFor = (
  k: Kernel,
  step: { readonly role: string; readonly mode?: string },
  leadHost: HostId | undefined,
  fallback: HostId,
): HostWebRoute | null => {
  const contract = k.deps.roles.get(step.role);
  if (contract === undefined) return null;
  const effective = resolveRoleMode(contract, step.mode);
  const tools = effective.ok ? effective.contract.tools : contract.tools;
  if (tools.host_web !== true) return null;
  const hosts: Partial<Record<HostId, { dispatchable: boolean; safeHostWeb: boolean }>> = {};
  for (const host of HOST_IDS) {
    const adapter = k.deps.adapters[host];
    if (adapter === undefined) continue;
    hosts[host] = {
      dispatchable:
        planDispatch("role", k.config().hosts.dispatch, adapter.capabilities, leadHost) !==
        "unavailable",
      safeHostWeb: adapter.capabilities.safeHostWeb === true,
    };
  }
  return hostWebRoute(leadHost ?? fallback, hosts);
};
