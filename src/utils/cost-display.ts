import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ModelAuthMode, resolveModelAuthMode } from "../agents/model-auth.js";

export type CostDisplayPolicy = "auto" | "always" | "hide";

export function resolveCostDisplayPolicy(cfg?: OpenClawConfig): CostDisplayPolicy {
  const raw = cfg?.usage?.costDisplay;
  if (raw === "always" || raw === "hide") {
    return raw;
  }
  return "auto";
}

export function isCostVisible(authMode: ModelAuthMode | undefined, cfg?: OpenClawConfig): boolean {
  const policy = resolveCostDisplayPolicy(cfg);
  if (policy === "hide") {
    return false;
  }
  if (policy === "always") {
    return true;
  }
  // "auto": show only for api-key or mixed
  return authMode === "api-key" || authMode === "mixed";
}

/**
 * Resolve the effective auth mode across ALL configured providers.
 * Returns "api-key" if any provider uses api-key (cost is relevant),
 * "mixed" if providers span both api-key and subscription modes,
 * or the unanimous subscription mode when all providers agree.
 */
export function resolveEffectiveAuthMode(cfg?: OpenClawConfig): ModelAuthMode | undefined {
  const providers = cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const keys = Object.keys(providers);
  if (keys.length === 0) {
    return undefined;
  }
  const modes = new Set<ModelAuthMode>();
  for (const key of keys) {
    const mode = resolveModelAuthMode(key, cfg);
    if (mode && mode !== "unknown") {
      modes.add(mode);
    }
  }
  if (modes.size === 0) {
    return undefined;
  }
  if (modes.size === 1) {
    return [...modes][0];
  }
  // Multiple distinct modes: if any is api-key, treat as mixed (cost visible)
  if (modes.has("api-key")) {
    return "mixed";
  }
  // All subscription-style but different (e.g. oauth + token)
  return [...modes][0];
}
