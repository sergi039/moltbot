/**
 * Facts Memory Redaction
 *
 * Redact sensitive information from memory entries for safe export.
 */

import type { MemoryEntry, MemoryType } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Supported redaction pattern types */
export type RedactionPatternType =
  | "EMAIL"
  | "PHONE"
  | "API_KEY"
  | "JWT"
  | "BEARER"
  | "URL_CREDS"
  | "IP_ADDRESS"
  | "CREDIT_CARD"
  | "SSN"
  | "CUSTOM";

/** Redaction pattern definition */
export interface RedactionPattern {
  /** Pattern type identifier */
  type: RedactionPatternType;
  /** Regular expression for matching */
  regex: RegExp;
  /** Replacement string (default: [REDACTED]) */
  replacement?: string;
}

/** Redaction configuration */
export interface RedactionConfig {
  /** Whether redaction is enabled */
  enabled?: boolean;
  /** Pattern types to apply */
  patterns?: RedactionPatternType[];
  /** Custom patterns */
  customPatterns?: Array<{
    name: string;
    regex: string;
    flags?: string;
    replacement?: string;
  }>;
}

/** Redaction result */
export interface RedactionResult {
  /** Original content */
  original: string;
  /** Redacted content */
  redacted: string;
  /** Whether any redactions were made */
  wasRedacted: boolean;
  /** Count of redactions by type */
  redactionCounts: Record<string, number>;
}

/** Export redaction options */
export interface ExportRedactionOptions {
  /** Enable redaction */
  redact?: boolean;
  /** Pattern types to apply (default: all standard patterns) */
  patterns?: RedactionPatternType[];
  /** Memory types to exclude entirely */
  excludeTypes?: MemoryType[];
  /** Custom replacement string */
  replacement?: string;
}

// ============================================================================
// Standard Patterns
// ============================================================================

const STANDARD_PATTERNS: Record<RedactionPatternType, RedactionPattern> = {
  EMAIL: {
    type: "EMAIL",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    replacement: "[EMAIL]",
  },
  PHONE: {
    type: "PHONE",
    // International and US phone formats
    regex: /(\+?1?[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+\d{1,3}[-.\s]?\d{4,14}/g,
    replacement: "[PHONE]",
  },
  API_KEY: {
    type: "API_KEY",
    // Common API key patterns: sk-*, api_*, key_*, etc.
    regex:
      /\b(sk-[a-zA-Z0-9_-]{20,}|api[_-]?[a-zA-Z0-9_-]{16,}|key[_-]?[a-zA-Z0-9_-]{16,}|token[_-]?[a-zA-Z0-9_-]{16,})\b/gi,
    replacement: "[API_KEY]",
  },
  JWT: {
    type: "JWT",
    // JWT format: header.payload.signature (base64url encoded)
    regex: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    replacement: "[JWT]",
  },
  BEARER: {
    type: "BEARER",
    // Bearer token in headers
    regex: /Bearer\s+[a-zA-Z0-9_.-]+/gi,
    replacement: "Bearer [TOKEN]",
  },
  URL_CREDS: {
    type: "URL_CREDS",
    // Credentials in URLs: https://user:pass@host
    regex: /(:\/\/)([^:]+):([^@]+)@/g,
    replacement: "://$2:[PASSWORD]@",
  },
  IP_ADDRESS: {
    type: "IP_ADDRESS",
    // IPv4 addresses (not localhost/private ranges in replacement)
    regex:
      /\b(?!127\.0\.0\.1|192\.168\.|10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replacement: "[IP]",
  },
  CREDIT_CARD: {
    type: "CREDIT_CARD",
    // Credit card numbers (basic pattern)
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    replacement: "[CARD]",
  },
  SSN: {
    type: "SSN",
    // US Social Security Number
    regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    replacement: "[SSN]",
  },
  CUSTOM: {
    type: "CUSTOM",
    regex: /(?:)/g, // Placeholder, overridden by custom patterns
    replacement: "[REDACTED]",
  },
};

/** Default patterns to apply */
export const DEFAULT_REDACTION_PATTERNS: RedactionPatternType[] = [
  "EMAIL",
  "PHONE",
  "API_KEY",
  "JWT",
  "BEARER",
  "URL_CREDS",
];

// ============================================================================
// Redaction Functions
// ============================================================================

/**
 * Redact sensitive information from a string.
 */
export function redactString(
  content: string,
  patterns: RedactionPatternType[] = DEFAULT_REDACTION_PATTERNS,
  customReplacement?: string,
): RedactionResult {
  let redacted = content;
  let wasRedacted = false;
  const redactionCounts: Record<string, number> = {};

  for (const patternType of patterns) {
    const pattern = STANDARD_PATTERNS[patternType];
    if (!pattern) continue;

    const replacement = customReplacement ?? pattern.replacement ?? "[REDACTED]";

    // Count matches before replacing
    const matches = content.match(pattern.regex);
    if (matches && matches.length > 0) {
      redactionCounts[patternType] = matches.length;
      wasRedacted = true;
    }

    // Apply redaction
    redacted = redacted.replace(pattern.regex, replacement);
  }

  return {
    original: content,
    redacted,
    wasRedacted,
    redactionCounts,
  };
}

/**
 * Redact sensitive information from a memory entry.
 * Returns a new entry with redacted content (original is not modified).
 */
export function redactMemoryEntry(
  entry: MemoryEntry,
  patterns: RedactionPatternType[] = DEFAULT_REDACTION_PATTERNS,
  customReplacement?: string,
): MemoryEntry {
  const result = redactString(entry.content, patterns, customReplacement);

  return {
    ...entry,
    content: result.redacted,
  };
}

/**
 * Check if a memory entry should be excluded based on type.
 */
export function shouldExcludeEntry(entry: MemoryEntry, excludeTypes?: MemoryType[]): boolean {
  if (!excludeTypes || excludeTypes.length === 0) {
    return false;
  }
  return excludeTypes.includes(entry.type);
}

/**
 * Process memory entries for export with redaction and exclusion.
 */
export function processEntriesForExport(
  entries: MemoryEntry[],
  options: ExportRedactionOptions = {},
): MemoryEntry[] {
  const {
    redact = false,
    patterns = DEFAULT_REDACTION_PATTERNS,
    excludeTypes,
    replacement,
  } = options;

  return entries
    .filter((entry) => !shouldExcludeEntry(entry, excludeTypes))
    .map((entry) => {
      if (redact) {
        return redactMemoryEntry(entry, patterns, replacement);
      }
      return entry;
    });
}

/**
 * Validate redaction pattern types.
 */
export function validatePatternTypes(patterns: string[]): {
  valid: RedactionPatternType[];
  invalid: string[];
} {
  const validTypes = Object.keys(STANDARD_PATTERNS) as RedactionPatternType[];
  const valid: RedactionPatternType[] = [];
  const invalid: string[] = [];

  for (const p of patterns) {
    const upper = p.toUpperCase() as RedactionPatternType;
    if (validTypes.includes(upper)) {
      valid.push(upper);
    } else {
      invalid.push(p);
    }
  }

  return { valid, invalid };
}

/**
 * Get all available redaction pattern types.
 */
export function getAvailablePatterns(): RedactionPatternType[] {
  return Object.keys(STANDARD_PATTERNS) as RedactionPatternType[];
}
