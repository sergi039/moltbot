/**
 * Redaction Module
 *
 * Exports redaction patterns and redactor utilities.
 */

// Types
export type { RedactionPattern, RedactionCategory } from "./patterns.js";
export type { RedactionStats, RedactionResult, RedactorOptions } from "./redactor.js";

// Patterns
export {
  DEFAULT_PATTERNS,
  getEnabledPatterns,
  getPatternsByCategory,
  // Individual patterns for testing
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  GITHUB_PAT,
  JWT_TOKEN,
  BEARER_TOKEN,
} from "./patterns.js";

// Redactor
export {
  Redactor,
  createRedactor,
  getDefaultRedactor,
  redact,
  redactString,
  redactObject,
  redactWithStats,
} from "./redactor.js";
