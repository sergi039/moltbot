import type { ModelAuthMode } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Determines whether cost data should be visible based on auth mode and config.
 *
 * - "always" → show cost regardless
 * - "hide"   → hide cost regardless
 * - "auto"   → hide for subscription auth (oauth / token), show for api-key
 */
export function isCostVisible(
  authMode: ModelAuthMode | undefined,
  cfg: OpenClawConfig | undefined,
): boolean {
  const setting = cfg?.usage?.costDisplay ?? "auto";
  if (setting === "always") {
    return true;
  }
  if (setting === "hide") {
    return false;
  }
  // auto: hide for subscription-based auth
  return authMode !== "oauth" && authMode !== "token";
}
