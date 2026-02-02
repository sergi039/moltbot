/**
 * Artifact Validator
 *
 * Validates workflow artifacts against expected schemas.
 * Used to verify phase outputs before allowing transitions.
 */

import type {
  TaskList,
  Task,
  ReviewResult,
  ReviewIssue,
  Recommendation,
  PhaseDefinition,
  ValidationResult,
} from "../types.js";
import { loadArtifactJson, artifactExists } from "./store.js";

// ============================================================================
// Validation Result Builder
// ============================================================================

function createValidationResult(): ValidationResult & { warnings: string[] } {
  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}

function addError(result: ValidationResult, message: string): void {
  result.valid = false;
  result.errors.push(message);
}

function addWarning(result: ValidationResult & { warnings?: string[] }, message: string): void {
  if (!result.warnings) result.warnings = [];
  result.warnings.push(message);
}

// ============================================================================
// Phase Output Validation
// ============================================================================

export async function validatePhaseOutput(
  runId: string,
  phase: PhaseDefinition,
  iteration: number,
): Promise<ValidationResult> {
  const result = createValidationResult();

  // 1. Check required artifacts exist
  for (const artifactName of phase.outputArtifacts) {
    const exists = await artifactExists(runId, phase.id, iteration, artifactName);
    if (!exists) {
      addError(result, `Missing required artifact: ${artifactName}`);
    }
  }

  // If missing artifacts, return early
  if (!result.valid) {
    return result;
  }

  // 2. Validate specific artifact schemas
  for (const artifactName of phase.outputArtifacts) {
    if (artifactName === "tasks.json") {
      const taskValidation = await validateTaskList(runId, phase.id, iteration);
      if (!taskValidation.valid) {
        result.valid = false;
        result.errors.push(...taskValidation.errors);
      }
      if (taskValidation.warnings) {
        result.warnings.push(...taskValidation.warnings);
      }
    }

    if (artifactName === "review.json" || artifactName === "plan-review.json") {
      const reviewValidation = await validateReviewResult(runId, phase.id, iteration, artifactName);
      if (!reviewValidation.valid) {
        result.valid = false;
        result.errors.push(...reviewValidation.errors);
      }
      if (reviewValidation.warnings) {
        result.warnings.push(...reviewValidation.warnings);
      }
    }
  }

  return result;
}

// ============================================================================
// TaskList Validation
// ============================================================================

export async function validateTaskList(
  runId: string,
  phaseId: string,
  iteration: number,
): Promise<ValidationResult> {
  const result = createValidationResult();

  const taskList = await loadArtifactJson<TaskList>(runId, phaseId, iteration, "tasks.json");

  if (!taskList) {
    addError(result, "tasks.json is not valid JSON");
    return result;
  }

  // Required fields
  if (!taskList.version) {
    addError(result, "tasks.json: missing 'version' field");
  }

  if (!taskList.projectName) {
    addError(result, "tasks.json: missing 'projectName' field");
  }

  if (!Array.isArray(taskList.tasks)) {
    addError(result, "tasks.json: 'tasks' must be an array");
    return result;
  }

  // Validate each task
  const taskIds = new Set<string>();

  for (let i = 0; i < taskList.tasks.length; i++) {
    const task = taskList.tasks[i];
    const prefix = `tasks.json: task[${i}]`;

    const taskValidation = validateTask(task, prefix, taskIds);
    if (!taskValidation.valid) {
      result.valid = false;
      result.errors.push(...taskValidation.errors);
    }

    if (task.id) {
      taskIds.add(task.id);
    }
  }

  // Validate dependencies reference existing tasks
  for (const task of taskList.tasks) {
    if (!task.dependsOn) continue;

    for (const depId of task.dependsOn) {
      if (!taskIds.has(depId)) {
        addError(result, `tasks.json: task "${task.id}" depends on unknown task "${depId}"`);
      }
    }
  }

  // Check for circular dependencies
  const circularCheck = checkCircularDependencies(taskList.tasks);
  if (circularCheck) {
    addError(result, `tasks.json: circular dependency detected: ${circularCheck}`);
  }

  // Validate stats if present
  if (taskList.stats) {
    const actualTotal = taskList.tasks.length;
    if (taskList.stats.total !== actualTotal) {
      addWarning(
        result,
        `tasks.json: stats.total (${taskList.stats.total}) doesn't match actual task count (${actualTotal})`,
      );
    }
  }

  return result;
}

function validateTask(task: unknown, prefix: string, existingIds: Set<string>): ValidationResult {
  const result = createValidationResult();
  const t = task as Partial<Task>;

  if (!t.id || typeof t.id !== "string") {
    addError(result, `${prefix}: missing or invalid 'id'`);
  } else if (existingIds.has(t.id)) {
    addError(result, `${prefix}: duplicate task id "${t.id}"`);
  }

  if (!t.title || typeof t.title !== "string") {
    addError(result, `${prefix}: missing or invalid 'title'`);
  }

  if (!t.description || typeof t.description !== "string") {
    addError(result, `${prefix}: missing or invalid 'description'`);
  }

  const validTypes = ["feature", "bugfix", "refactor", "test", "docs"];
  if (!t.type || !validTypes.includes(t.type)) {
    addError(result, `${prefix}: invalid 'type' (must be one of: ${validTypes.join(", ")})`);
  }

  if (typeof t.priority !== "number" || t.priority < 1) {
    addError(result, `${prefix}: 'priority' must be a positive number`);
  }

  if (typeof t.complexity !== "number" || t.complexity < 1 || t.complexity > 5) {
    addError(result, `${prefix}: 'complexity' must be between 1 and 5`);
  }

  const validStatuses = ["pending", "in_progress", "completed", "failed", "blocked"];
  if (!t.status || !validStatuses.includes(t.status)) {
    addError(result, `${prefix}: invalid 'status' (must be one of: ${validStatuses.join(", ")})`);
  }

  if (!Array.isArray(t.dependsOn)) {
    addError(result, `${prefix}: 'dependsOn' must be an array`);
  }

  if (!Array.isArray(t.acceptanceCriteria)) {
    addError(result, `${prefix}: 'acceptanceCriteria' must be an array`);
  }

  return result;
}

function checkCircularDependencies(tasks: Task[]): string | null {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(taskId: string, path: string[]): string | null {
    if (recursionStack.has(taskId)) {
      return [...path, taskId].join(" -> ");
    }

    if (visited.has(taskId)) {
      return null;
    }

    visited.add(taskId);
    recursionStack.add(taskId);

    const task = taskMap.get(taskId);
    if (task?.dependsOn) {
      for (const depId of task.dependsOn) {
        const cycle = dfs(depId, [...path, taskId]);
        if (cycle) return cycle;
      }
    }

    recursionStack.delete(taskId);
    return null;
  }

  for (const task of tasks) {
    const cycle = dfs(task.id, []);
    if (cycle) return cycle;
  }

  return null;
}

// ============================================================================
// ReviewResult Validation
// ============================================================================

export async function validateReviewResult(
  runId: string,
  phaseId: string,
  iteration: number,
  filename = "review.json",
): Promise<ValidationResult> {
  const result = createValidationResult();

  const review = await loadArtifactJson<ReviewResult>(runId, phaseId, iteration, filename);

  if (!review) {
    addError(result, `${filename} is not valid JSON`);
    return result;
  }

  // Required fields
  if (!review.version) {
    addError(result, `${filename}: missing 'version' field`);
  }

  if (typeof review.reviewedAt !== "number") {
    addError(result, `${filename}: missing or invalid 'reviewedAt' timestamp`);
  }

  if (
    typeof review.overallScore !== "number" ||
    review.overallScore < 0 ||
    review.overallScore > 100
  ) {
    addError(result, `${filename}: 'overallScore' must be a number between 0 and 100`);
  }

  if (typeof review.approved !== "boolean") {
    addError(result, `${filename}: 'approved' must be a boolean`);
  }

  if (!review.summary || typeof review.summary !== "string") {
    addError(result, `${filename}: missing or invalid 'summary'`);
  }

  // Validate scores
  if (review.scores) {
    const scoreFields = [
      "architecture",
      "codeQuality",
      "testCoverage",
      "security",
      "documentation",
    ] as const;
    for (const field of scoreFields) {
      const score = review.scores[field];
      if (typeof score !== "number" || score < 0 || score > 100) {
        addError(result, `${filename}: scores.${field} must be a number between 0 and 100`);
      }
    }
  } else {
    addError(result, `${filename}: missing 'scores' object`);
  }

  // Validate issues
  if (!Array.isArray(review.issues)) {
    addError(result, `${filename}: 'issues' must be an array`);
  } else {
    for (let i = 0; i < review.issues.length; i++) {
      const issueValidation = validateReviewIssue(review.issues[i], `${filename}: issues[${i}]`);
      if (!issueValidation.valid) {
        result.valid = false;
        result.errors.push(...issueValidation.errors);
      }
    }
  }

  // Validate recommendations
  if (!Array.isArray(review.recommendations)) {
    addError(result, `${filename}: 'recommendations' must be an array`);
  } else {
    for (let i = 0; i < review.recommendations.length; i++) {
      const recValidation = validateRecommendation(
        review.recommendations[i],
        `${filename}: recommendations[${i}]`,
      );
      if (!recValidation.valid) {
        result.valid = false;
        result.errors.push(...recValidation.errors);
      }
    }
  }

  return result;
}

function validateReviewIssue(issue: unknown, prefix: string): ValidationResult {
  const result = createValidationResult();
  const i = issue as Partial<ReviewIssue>;

  if (!i.id || typeof i.id !== "string") {
    addError(result, `${prefix}: missing or invalid 'id'`);
  }

  const validSeverities = ["critical", "high", "medium", "low"];
  if (!i.severity || !validSeverities.includes(i.severity)) {
    addError(
      result,
      `${prefix}: invalid 'severity' (must be one of: ${validSeverities.join(", ")})`,
    );
  }

  if (!i.category || typeof i.category !== "string") {
    addError(result, `${prefix}: missing or invalid 'category'`);
  }

  if (!i.description || typeof i.description !== "string") {
    addError(result, `${prefix}: missing or invalid 'description'`);
  }

  return result;
}

function validateRecommendation(rec: unknown, prefix: string): ValidationResult {
  const result = createValidationResult();
  const r = rec as Partial<Recommendation>;

  if (!r.id || typeof r.id !== "string") {
    addError(result, `${prefix}: missing or invalid 'id'`);
  }

  const validPriorities = ["must", "should", "could"];
  if (!r.priority || !validPriorities.includes(r.priority)) {
    addError(
      result,
      `${prefix}: invalid 'priority' (must be one of: ${validPriorities.join(", ")})`,
    );
  }

  if (!r.description || typeof r.description !== "string") {
    addError(result, `${prefix}: missing or invalid 'description'`);
  }

  if (!r.rationale || typeof r.rationale !== "string") {
    addError(result, `${prefix}: missing or invalid 'rationale'`);
  }

  return result;
}

// ============================================================================
// Condition Evaluation (JSONPath-like)
// ============================================================================

export function evaluateCondition(condition: string, artifacts: Record<string, unknown>): boolean {
  // Simple JSONPath-like evaluation for common patterns
  // Supports:
  //   - $.planReview.approved == false (nested property access)
  //   - $.review.issues[?(@.severity=='critical')].length > 0 (nested array filter)

  try {
    // Handle simple/nested property access: $.planReview.approved == false
    // Matches: $.<path> <op> <value> where path can be nested (e.g., "a.b.c")
    // Note: Longer operators (>=, <=, ==, !=) must come before shorter ones (>, <) in alternation
    const simpleMatch = condition.match(/^\$\.([\w.]+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
    if (simpleMatch) {
      const [, path, op, valueStr] = simpleMatch;
      const value = parseValue(valueStr);
      const actual = getNestedProperty(artifacts, path);
      return compareValues(actual, op, value);
    }

    // Handle array filter with length: $.review.issues[?(@.severity=='critical')].length > 0
    // Matches: $.<path>.<arrayProp>[?(@.<filterProp> <op> '<value>')].length <op> <num>
    const arrayMatch = condition.match(
      /^\$\.([\w.]+)\.(\w+)\[\?\(@\.(\w+)\s*(==|!=)\s*['"]([^'"]+)['"]\)\]\.length\s*(>|>=|<|<=|==|!=)\s*(\d+)$/,
    );
    if (arrayMatch) {
      const [, basePath, arrayProp, filterProp, filterOp, filterValue, lengthOp, lengthValue] =
        arrayMatch;
      const fullPath = basePath ? `${basePath}.${arrayProp}` : arrayProp;
      const array = getNestedProperty(artifacts, fullPath) as unknown[];

      if (!Array.isArray(array)) return false;

      const filtered = array.filter((item) => {
        const itemValue = (item as Record<string, unknown>)[filterProp];
        return filterOp === "==" ? itemValue === filterValue : itemValue !== filterValue;
      });

      return compareValues(filtered.length, lengthOp, parseInt(lengthValue, 10));
    }

    // Fallback: try direct array filter without base path
    // $.issues[?(@.severity=='critical')].length > 0
    const directArrayMatch = condition.match(
      /^\$\.(\w+)\[\?\(@\.(\w+)\s*(==|!=)\s*['"]([^'"]+)['"]\)\]\.length\s*(>|>=|<|<=|==|!=)\s*(\d+)$/,
    );
    if (directArrayMatch) {
      const [, arrayProp, filterProp, filterOp, filterValue, lengthOp, lengthValue] =
        directArrayMatch;
      const array = getNestedProperty(artifacts, arrayProp) as unknown[];

      if (!Array.isArray(array)) return false;

      const filtered = array.filter((item) => {
        const itemValue = (item as Record<string, unknown>)[filterProp];
        return filterOp === "==" ? itemValue === filterValue : itemValue !== filterValue;
      });

      return compareValues(filtered.length, lengthOp, parseInt(lengthValue, 10));
    }

    console.warn(`[workflows] Unable to evaluate condition: ${condition}`);
    return false;
  } catch (err) {
    console.error(`[workflows] Error evaluating condition "${condition}":`, err);
    return false;
  }
}

function parseValue(str: string): unknown {
  const trimmed = str.trim();

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;

  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

  // Remove quotes for string values
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function getNestedProperty(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj;

  for (const part of parts) {
    if (current == null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function compareValues(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return (actual as number) > (expected as number);
    case "<":
      return (actual as number) < (expected as number);
    case ">=":
      return (actual as number) >= (expected as number);
    case "<=":
      return (actual as number) <= (expected as number);
    default:
      return false;
  }
}
