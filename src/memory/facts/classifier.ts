/**
 * Facts Memory Classifier
 *
 * Lightweight rules-based classifier for determining whether
 * messages should be processed for memory extraction.
 * Uses regex patterns and heuristics - no LLM calls.
 */

import type { ClassificationResult } from "./types.js";

// ============================================================================
// Classification Patterns
// ============================================================================

/** Patterns that indicate explicit memory request */
const EXPLICIT_PATTERNS: RegExp[] = [
  /\bremember\s+(that|this|my|the|i|me)\b/i,
  /\bdon'?t\s+forget\b/i,
  /\bkeep\s+in\s+mind\b/i,
  /\bnote\s+(that|this|down|:)\b/i,
  /\bsave\s+(this|that)\b/i,
  /\bstore\s+(this|that)\b/i,
  /\bforget\s+(what|about|that|this)\b/i, // For DELETE operations
  /\bmy\s+name\s+is\b/i,
  /\bi\s+am\s+called\b/i,
  /\bcall\s+me\b/i,
  /\bi\s+live\s+(in|at)\b/i,
  /\bi\s+work\s+(at|for|as)\b/i,
];

/** Patterns that indicate decisions or preferences */
const DECISION_PATTERNS: RegExp[] = [
  /\bi\s+(prefer|like|love|hate|dislike|want|need)\b/i,
  /\blet'?s\s+(go\s+with|use|do|choose)\b/i,
  /\bi('?ve)?\s+decided\b/i,
  /\bwe\s+decided\b/i,
  /\bmy\s+(preference|choice|decision)\s+is\b/i,
  /\balways\s+(use|prefer)\b/i,
  /\bnever\s+use\b/i,
  /\bdefault\s+to\b/i,
  /\bfrom\s+now\s+on\b/i,
  /\bgoing\s+forward\b/i,
];

/** Patterns that indicate todos or tasks */
const TODO_PATTERNS: RegExp[] = [
  /\bi\s+need\s+to\b/i,
  /\bremind\s+me\s+to\b/i,
  /\btodo:?\s/i,
  /\bdon'?t\s+let\s+me\s+forget\s+to\b/i,
  /\bi\s+should\b/i,
  /\bi\s+must\b/i,
  /\bdeadline\b/i,
  /\bdue\s+(by|date)\b/i,
];

/** Patterns that indicate important facts */
const FACT_PATTERNS: RegExp[] = [
  /\bmy\s+(email|phone|address|birthday|age)\b/i,
  /\bi\s+(was\s+born|grew\s+up)\b/i,
  /\bcontact\s+(info|information|details)\b/i,
  /\bimportant:?\s/i,
  /\bcritical:?\s/i,
  /\bkey\s+(point|info|fact)\b/i,
  /\bthe\s+(api|key|token|password|secret)\s+is\b/i,
  /\bproject\s+name\s+is\b/i,
];

/** Patterns for events */
const EVENT_PATTERNS: RegExp[] = [
  /\bmeeting\s+(on|at|tomorrow|today)\b/i,
  /\bappointment\b/i,
  /\bevent\s+(on|at)\b/i,
  /\bschedule[d]?\s+(for|on|at)\b/i,
  /\bon\s+\d{1,2}[\/\-]\d{1,2}\b/i, // Date patterns
];

/** Patterns that indicate small talk or greetings (skip these) */
const SKIP_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|yo|sup|hola|howdy|greetings?)[!.,\s]*$/i,
  /^(good\s+(morning|afternoon|evening|night))[!.,\s]*$/i,
  /^(how\s+are\s+you|how'?s\s+it\s+going|what'?s\s+up)[?!.,\s]*$/i,
  /^(thanks?|thank\s+you|ty|thx)[!.,\s]*$/i,
  /^(ok|okay|sure|yes|no|yep|nope|yeah|nah)[!.,\s]*$/i,
  /^(bye|goodbye|see\s+you|later|cya)[!.,\s]*$/i,
  /^(lol|haha|hehe|lmao|rofl)[!.,\s]*$/i,
  /^[!?.,:;\s]*$/,
  /^.{0,10}$/, // Very short messages
];

/** Patterns for technical discussions (lower priority) */
const TECHNICAL_PATTERNS: RegExp[] = [
  /\bcode\s+(review|change|fix)\b/i,
  /\bbug\s+(fix|report)\b/i,
  /\bfeature\b/i,
  /\brefactor\b/i,
  /\bdeploy\b/i,
  /\btest(ing|s)?\b/i,
];

// ============================================================================
// Classification Logic
// ============================================================================

/**
 * Classify a message to determine if it should be processed for extraction.
 */
export function classifyMessage(message: string): ClassificationResult {
  const trimmed = message.trim();
  const patterns: string[] = [];
  let reason: string | undefined;
  let typeHint: ClassificationResult["typeHint"] | undefined;

  // Check skip patterns first
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        shouldExtract: false,
        confidence: 0.0,
        priority: "skip",
        patterns: ["skip"],
        reason: "Small talk or greeting",
      };
    }
  }

  // Check explicit memory patterns (highest priority)
  for (const pattern of EXPLICIT_PATTERNS) {
    if (pattern.test(trimmed)) {
      patterns.push("explicit");
      // Determine type hint from the explicit pattern
      if (/\bmy\s+name\s+is\b/i.test(trimmed) || /\bcall\s+me\b/i.test(trimmed)) {
        typeHint = "fact";
      } else if (/\bremind\s+me\b/i.test(trimmed) || /\bdon'?t\s+forget\b/i.test(trimmed)) {
        typeHint = "todo";
      }
      return {
        shouldExtract: true,
        confidence: 0.95,
        priority: "high",
        patterns,
        reason: "Explicit memory request detected",
        typeHint: typeHint ?? "fact",
      };
    }
  }

  // Check decision/preference patterns
  for (const pattern of DECISION_PATTERNS) {
    if (pattern.test(trimmed)) {
      patterns.push("decision");
      if (!typeHint) {
        // Distinguish between preference and decision
        if (/\b(prefer|like|love|hate|dislike)\b/i.test(trimmed)) {
          typeHint = "preference";
        } else {
          typeHint = "decision";
        }
      }
      break;
    }
  }

  // Check todo patterns
  for (const pattern of TODO_PATTERNS) {
    if (pattern.test(trimmed)) {
      patterns.push("todo");
      if (!typeHint) typeHint = "todo";
      break;
    }
  }

  // Check fact patterns
  for (const pattern of FACT_PATTERNS) {
    if (pattern.test(trimmed)) {
      patterns.push("fact");
      if (!typeHint) typeHint = "fact";
      break;
    }
  }

  // Check event patterns
  for (const pattern of EVENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      patterns.push("event");
      if (!typeHint) typeHint = "event";
      break;
    }
  }

  // Check technical patterns (lower priority)
  for (const pattern of TECHNICAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      patterns.push("technical");
      break;
    }
  }

  // Determine priority and confidence based on patterns found
  if (patterns.includes("decision") || patterns.includes("todo") || patterns.includes("fact")) {
    reason = `Detected: ${patterns.join(", ")}`;
    return {
      shouldExtract: true,
      confidence: 0.85,
      priority: "high",
      patterns,
      reason,
      typeHint,
    };
  }

  if (patterns.includes("event")) {
    reason = "Event detected";
    return {
      shouldExtract: true,
      confidence: 0.75,
      priority: "medium",
      patterns,
      reason,
      typeHint: "event",
    };
  }

  if (patterns.includes("technical")) {
    reason = "Technical discussion";
    return {
      shouldExtract: true,
      confidence: 0.5,
      priority: "low",
      patterns,
      reason,
    };
  }

  // Heuristic: longer messages might contain useful info
  if (trimmed.length > 200) {
    return {
      shouldExtract: true,
      confidence: 0.4,
      priority: "low",
      patterns: ["length"],
      reason: "Long message may contain useful information",
    };
  }

  // Default: skip
  return {
    shouldExtract: false,
    confidence: 0.0,
    priority: "skip",
    patterns: [],
    reason: "No significant patterns detected",
  };
}

/**
 * Filter a batch of messages for extraction.
 * Returns only messages that should be processed.
 */
export function filterMessagesForExtraction(messages: string[]): {
  filtered: string[];
  classifications: ClassificationResult[];
} {
  const filtered: string[] = [];
  const classifications: ClassificationResult[] = [];

  for (const message of messages) {
    const result = classifyMessage(message);
    classifications.push(result);
    if (result.shouldExtract) {
      filtered.push(message);
    }
  }

  return { filtered, classifications };
}

/**
 * Check if any message in a batch should trigger extraction.
 * Useful for early-exit optimization.
 */
export function shouldExtractFromBatch(messages: string[]): boolean {
  for (const message of messages) {
    const result = classifyMessage(message);
    if (result.shouldExtract && result.priority !== "low") {
      return true;
    }
  }
  return false;
}

/**
 * Get the highest priority classification from a batch.
 */
export function getBatchPriority(messages: string[]): ClassificationResult["priority"] {
  let highestPriority: ClassificationResult["priority"] = "skip";
  const priorityOrder: ClassificationResult["priority"][] = ["skip", "low", "medium", "high"];

  for (const message of messages) {
    const result = classifyMessage(message);
    const currentIndex = priorityOrder.indexOf(result.priority);
    const highestIndex = priorityOrder.indexOf(highestPriority);
    if (currentIndex > highestIndex) {
      highestPriority = result.priority;
    }
    if (highestPriority === "high") break; // Can't get higher
  }

  return highestPriority;
}
