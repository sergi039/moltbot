/**
 * Intent Router for Workflow Detection
 *
 * Detects workflow-related intents from user messages and routes to appropriate workflow types.
 */

export type WorkflowIntentType = "dev-cycle" | "review-only" | "plan-only" | null;

export interface WorkflowIntentResult {
  /** Detected workflow type, or null if no workflow intent detected */
  type: WorkflowIntentType;
  /** Confidence score 0-1 */
  confidence: number;
  /** Extracted task description */
  task?: string;
  /** Matched pattern(s) for debugging */
  matchedPatterns?: string[];
}

// Pattern definitions for intent detection
const DEV_CYCLE_PATTERNS = [
  // Explicit workflow requests
  /\b(?:start|run|execute)\s+(?:a\s+)?(?:dev[-\s]?cycle|workflow)\b/i,
  /\b(?:multi[-\s]?agent|maw)\s+(?:workflow)?\s*:/i,
  // Plan + implement patterns
  /\bplan\s+(?:and|&|\+)\s+(?:implement|build|create|develop)\b/i,
  /\bimplement\s+(?:and|&|\+)\s+(?:review|validate)\b/i,
  // Full cycle indicators
  /\b(?:full|complete)\s+(?:dev(?:elopment)?|coding)\s+cycle\b/i,
  /\bplan[-\s]?review[-\s]?(?:implement|execute)\b/i,
  // Task-based with review
  /\b(?:build|create|implement|add|develop)\s+.+\s+(?:with|and)\s+review\b/i,
];

const REVIEW_ONLY_PATTERNS = [
  /\b(?:review|check|validate|verify)\s+(?:the\s+)?(?:this\s+)?(?:code|changes|pr|pull[-\s]?request|diff)\b/i,
  /\bcode\s+review\b/i,
  /\b(?:run|do|perform)\s+(?:a\s+)?review\b/i,
  /\breview[-\s]?only\b/i,
  /\breview\s+this\b/i,
];

const PLAN_ONLY_PATTERNS = [
  /\b(?:just|only)\s+plan\b/i,
  /\bcreate\s+(?:a\s+)?plan\s+(?:for|to)\b/i,
  /\bplan[-\s]?only\b/i,
  /\bgenerate\s+(?:a\s+)?(?:implementation\s+)?plan\b/i,
];

// Negative patterns - if matched, reduce confidence
const NEGATIVE_PATTERNS = [
  /\b(?:don'?t|do\s+not|no)\s+(?:use\s+)?(?:workflow|multi[-\s]?agent)\b/i,
  /\bmanually\b/i,
  /\bsimple\s+(?:question|task)\b/i,
];

/**
 * Extract task description from message by removing workflow keywords
 */
function extractTaskDescription(message: string): string | undefined {
  // Remove common workflow prefixes
  let task = message
    .replace(
      /^(?:use\s+)?(?:skill\s+)?(?:multi[-\s]?agent[-\s]?workflow|workflow|wf|dev[-\s]?cycle)\s*:?\s*/i,
      "",
    )
    .replace(/\b(?:please|can\s+you|could\s+you)\s+/gi, "")
    .replace(/\b(?:start|run|execute)\s+(?:a\s+)?(?:dev[-\s]?cycle|workflow)\s+(?:for|to)\s+/gi, "")
    .replace(/\bplan\s+(?:and|&|\+)\s+(?:implement|build|create|develop)\s+/gi, "")
    .replace(/\s+(?:with|and)\s+review$/i, "")
    .trim();

  // If task is too short or just keywords, return undefined
  if (task.length < 10 || /^(?:this|it|that|the\s+code)$/i.test(task)) {
    return undefined;
  }

  return task;
}

/**
 * Detect workflow intent from a user message
 */
export function detectWorkflowIntent(message: string): WorkflowIntentResult {
  const normalizedMessage = message.trim().toLowerCase();
  const matchedPatterns: string[] = [];
  let confidence = 0;
  let type: WorkflowIntentType = null;

  // Check for negative patterns first
  for (const pattern of NEGATIVE_PATTERNS) {
    if (pattern.test(message)) {
      return { type: null, confidence: 0 };
    }
  }

  // Check dev-cycle patterns (highest priority for full workflows)
  for (const pattern of DEV_CYCLE_PATTERNS) {
    if (pattern.test(message)) {
      type = "dev-cycle";
      confidence = Math.max(confidence, 0.8);
      matchedPatterns.push(pattern.source);
    }
  }

  // Check review-only patterns
  if (!type) {
    for (const pattern of REVIEW_ONLY_PATTERNS) {
      if (pattern.test(message)) {
        type = "review-only";
        confidence = Math.max(confidence, 0.7);
        matchedPatterns.push(pattern.source);
      }
    }
  }

  // Check plan-only patterns
  if (!type) {
    for (const pattern of PLAN_ONLY_PATTERNS) {
      if (pattern.test(message)) {
        type = "plan-only";
        confidence = Math.max(confidence, 0.7);
        matchedPatterns.push(pattern.source);
      }
    }
  }

  // Boost confidence for explicit skill invocations
  if (
    /^(?:\/|use\s+skill\s+)?(?:multi[-\s]?agent[-\s]?workflow|workflow|wf|dev[-\s]?cycle)\s*:/i.test(
      message,
    )
  ) {
    confidence = 1.0;
    type = type || "dev-cycle";
    matchedPatterns.push("explicit-invocation");
  }

  // Also handle slash command format
  if (/^\/(?:multi[-\s]?agent[-\s]?workflow|workflow|wf|dev[-\s]?cycle)\b/i.test(message)) {
    confidence = 1.0;
    type = type || "dev-cycle";
    matchedPatterns.push("slash-command");
  }

  const task = type ? extractTaskDescription(message) : undefined;

  return {
    type,
    confidence,
    task,
    matchedPatterns: matchedPatterns.length > 0 ? matchedPatterns : undefined,
  };
}

/**
 * Check if a message is likely a workflow invocation
 */
export function isWorkflowIntent(message: string, minConfidence = 0.6): boolean {
  const result = detectWorkflowIntent(message);
  return result.type !== null && result.confidence >= minConfidence;
}

/**
 * Get suggested workflow command based on intent
 */
export function suggestWorkflowCommand(intent: WorkflowIntentResult): string | null {
  if (!intent.type || intent.confidence < 0.5) return null;

  const taskPart = intent.task ? ` --task "${intent.task.replace(/"/g, '\\"')}"` : "";

  switch (intent.type) {
    case "dev-cycle":
      return `moltbot workflow start --type dev-cycle${taskPart} --repo .`;
    case "review-only":
      return `moltbot workflow start --type review-only${taskPart} --repo .`;
    case "plan-only":
      return `moltbot workflow start --type plan-only${taskPart} --repo .`;
    default:
      return null;
  }
}
