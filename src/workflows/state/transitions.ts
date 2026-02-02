/**
 * Phase Transitions
 *
 * Handles workflow phase transition logic, including validation
 * and state machine rules.
 */

import type { WorkflowRun, WorkflowStatus, PhaseStatus, PhaseDefinition } from "../types.js";

// ============================================================================
// Workflow Status Transitions
// ============================================================================

const VALID_WORKFLOW_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["paused", "completed", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionWorkflow(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return VALID_WORKFLOW_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertWorkflowTransition(from: WorkflowStatus, to: WorkflowStatus): void {
  if (!canTransitionWorkflow(from, to)) {
    throw new Error(
      `Invalid workflow status transition: ${from} -> ${to}. ` +
        `Valid transitions from ${from}: ${VALID_WORKFLOW_TRANSITIONS[from].join(", ") || "none"}`,
    );
  }
}

// ============================================================================
// Phase Status Transitions
// ============================================================================

const VALID_PHASE_TRANSITIONS: Record<PhaseStatus, PhaseStatus[]> = {
  pending: ["running", "skipped"],
  running: ["completed", "failed"],
  completed: [],
  failed: ["running"], // Can retry
  skipped: [],
};

export function canTransitionPhase(from: PhaseStatus, to: PhaseStatus): boolean {
  return VALID_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertPhaseTransition(from: PhaseStatus, to: PhaseStatus): void {
  if (!canTransitionPhase(from, to)) {
    throw new Error(
      `Invalid phase status transition: ${from} -> ${to}. ` +
        `Valid transitions from ${from}: ${VALID_PHASE_TRANSITIONS[from].join(", ") || "none"}`,
    );
  }
}

// ============================================================================
// Phase Dependency Resolution
// ============================================================================

export interface PhaseNode {
  phase: PhaseDefinition;
  dependsOn: string[];
  blockedBy: Set<string>;
}

export function buildPhaseDependencyGraph(phases: PhaseDefinition[]): Map<string, PhaseNode> {
  const graph = new Map<string, PhaseNode>();

  // Initialize nodes
  for (const phase of phases) {
    graph.set(phase.id, {
      phase,
      dependsOn: [],
      blockedBy: new Set(),
    });
  }

  // Build dependencies based on input artifacts
  // A phase depends on another if it requires artifacts that the other produces
  const artifactProducers = new Map<string, string>();

  for (const phase of phases) {
    for (const artifact of phase.outputArtifacts) {
      artifactProducers.set(artifact, phase.id);
    }
  }

  for (const phase of phases) {
    const node = graph.get(phase.id)!;

    for (const inputArtifact of phase.inputArtifacts) {
      const producer = artifactProducers.get(inputArtifact);
      if (producer && producer !== phase.id) {
        node.dependsOn.push(producer);
        node.blockedBy.add(producer);
      }
    }
  }

  return graph;
}

export function getExecutablePhases(
  graph: Map<string, PhaseNode>,
  completedPhases: Set<string>,
): PhaseDefinition[] {
  const executable: PhaseDefinition[] = [];

  for (const [phaseId, node] of graph) {
    if (completedPhases.has(phaseId)) continue;

    // Check if all dependencies are completed
    const allDepsCompleted = node.dependsOn.every((dep) => completedPhases.has(dep));

    if (allDepsCompleted) {
      executable.push(node.phase);
    }
  }

  return executable;
}

// ============================================================================
// Phase Ordering
// ============================================================================

export function topologicalSort(phases: PhaseDefinition[]): PhaseDefinition[] {
  const graph = buildPhaseDependencyGraph(phases);
  const sorted: PhaseDefinition[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(phaseId: string): void {
    if (visited.has(phaseId)) return;

    if (visiting.has(phaseId)) {
      throw new Error(`Circular dependency detected involving phase: ${phaseId}`);
    }

    visiting.add(phaseId);

    const node = graph.get(phaseId);
    if (node) {
      for (const dep of node.dependsOn) {
        visit(dep);
      }
    }

    visiting.delete(phaseId);
    visited.add(phaseId);

    const phase = phases.find((p) => p.id === phaseId);
    if (phase) {
      sorted.push(phase);
    }
  }

  for (const phase of phases) {
    visit(phase.id);
  }

  return sorted;
}

// ============================================================================
// Transition Validation
// ============================================================================

export interface TransitionValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePhaseTransition(
  run: WorkflowRun,
  fromPhase: PhaseDefinition | null,
  toPhase: PhaseDefinition,
): TransitionValidation {
  const result: TransitionValidation = {
    valid: true,
    errors: [],
    warnings: [],
  };

  // Check workflow is in valid state
  if (run.status !== "running") {
    result.valid = false;
    result.errors.push(`Cannot transition phases when workflow is ${run.status}`);
    return result;
  }

  // Check input artifacts are available
  for (const inputArtifact of toPhase.inputArtifacts) {
    const hasArtifact = run.phaseHistory.some(
      (pe) => pe.status === "completed" && pe.artifacts.includes(inputArtifact),
    );

    if (!hasArtifact) {
      result.valid = false;
      result.errors.push(
        `Missing required input artifact "${inputArtifact}" for phase "${toPhase.id}"`,
      );
    }
  }

  // Warn if retrying a failed phase
  const previousAttempts = run.phaseHistory.filter(
    (pe) => pe.phaseId === toPhase.id && pe.status === "failed",
  ).length;

  if (previousAttempts > 0) {
    result.warnings.push(`Phase "${toPhase.id}" has failed ${previousAttempts} time(s) before`);
  }

  return result;
}

// ============================================================================
// Iteration Tracking
// ============================================================================

export function getCurrentIteration(run: WorkflowRun, phaseId: string): number {
  const phaseExecutions = run.phaseHistory.filter((pe) => pe.phaseId === phaseId);
  return phaseExecutions.length + 1;
}

export function hasExceededMaxIterations(
  run: WorkflowRun,
  phaseId: string,
  maxIterations: number,
): boolean {
  const iterations = run.phaseHistory.filter((pe) => pe.phaseId === phaseId).length;
  return iterations >= maxIterations;
}

export function getPhaseExecutionHistory(
  run: WorkflowRun,
  phaseId: string,
): WorkflowRun["phaseHistory"] {
  return run.phaseHistory.filter((pe) => pe.phaseId === phaseId);
}
