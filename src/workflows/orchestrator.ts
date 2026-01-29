/**
 * Workflow Orchestrator
 *
 * Main entry point for the multi-agent workflow system.
 * Manages workflow lifecycle, phase transitions, and agent coordination.
 */

import { mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";

import type {
  WorkflowDefinition,
  WorkflowInput,
  WorkflowRun,
  WorkflowEvent,
  WorkflowEventHandler,
  PhaseDefinition,
  PhaseExecution,
  WorkspaceConfig,
} from "./types.js";

import { generateWorkflowId, PERSISTENCE_EVENTS } from "./constants.js";

import {
  saveWorkflowState,
  loadWorkflowState,
  saveWorkflowInput,
  logWorkflowEvent,
  getWorkflowDir,
  listRunningWorkflows,
} from "./state/persistence.js";

import { validatePhaseOutput, evaluateCondition } from "./artifacts/validator.js";
import { loadArtifactJson, generateManifest } from "./artifacts/store.js";

// ============================================================================
// Orchestrator Class
// ============================================================================

export class WorkflowOrchestrator extends EventEmitter {
  private definitions: Map<string, WorkflowDefinition> = new Map();
  private runningWorkflows: Map<string, WorkflowRun> = new Map();

  constructor() {
    super();
  }

  // ==========================================================================
  // Definition Management
  // ==========================================================================

  registerDefinition(definition: WorkflowDefinition): void {
    this.definitions.set(definition.type, definition);
  }

  getDefinition(type: string): WorkflowDefinition | undefined {
    return this.definitions.get(type);
  }

  listDefinitions(): WorkflowDefinition[] {
    return Array.from(this.definitions.values());
  }

  // ==========================================================================
  // Workflow Lifecycle
  // ==========================================================================

  async start(
    definitionType: string,
    input: WorkflowInput,
    workspace: WorkspaceConfig,
  ): Promise<WorkflowRun> {
    const definition = this.definitions.get(definitionType);
    if (!definition) {
      throw new Error(`Unknown workflow type: ${definitionType}`);
    }

    // Check concurrent workflow limit
    const running = await listRunningWorkflows();
    const maxConcurrent = 5; // TODO: Get from config
    if (running.length >= maxConcurrent) {
      throw new Error(
        `Maximum concurrent workflows (${maxConcurrent}) reached. ` +
          `Please wait for existing workflows to complete or cancel one.`,
      );
    }

    // Create workflow run
    const run: WorkflowRun = {
      id: generateWorkflowId(),
      definitionType,
      status: "pending",
      input,
      workspace,
      currentPhase: null,
      phaseHistory: [],
      iterationCount: 0,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };

    // Create workflow directory
    const workflowDir = getWorkflowDir(run.id);
    mkdirSync(workflowDir, { recursive: true });

    // Save initial state
    await saveWorkflowState(run);
    await saveWorkflowInput(run.id, input);

    // Track running workflow
    this.runningWorkflows.set(run.id, run);

    // Emit event
    await this.emitEvent({
      type: "workflow:started",
      workflowId: run.id,
      timestamp: Date.now(),
      data: { definitionType, input },
    });

    return run;
  }

  async execute(runId: string): Promise<WorkflowRun> {
    const run = await this.loadRun(runId);
    if (!run) {
      throw new Error(`Workflow not found: ${runId}`);
    }

    const definition = this.definitions.get(run.definitionType);
    if (!definition) {
      throw new Error(`Unknown workflow type: ${run.definitionType}`);
    }

    // Update status
    run.status = "running";
    run.startedAt = Date.now();
    await this.saveAndPersist(run);

    try {
      // Execute phases
      await this.executePhases(run, definition);

      // Mark as completed
      run.status = "completed";
      run.completedAt = Date.now();
      await this.saveAndPersist(run);

      await this.emitEvent({
        type: "workflow:completed",
        workflowId: run.id,
        timestamp: Date.now(),
      });
    } catch (err) {
      // Mark as failed
      run.status = "failed";
      run.completedAt = Date.now();
      run.error = {
        phase: run.currentPhase || "unknown",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        recoverable: this.isRecoverableError(err),
      };
      await this.saveAndPersist(run);

      await this.emitEvent({
        type: "workflow:failed",
        workflowId: run.id,
        timestamp: Date.now(),
        data: { error: run.error },
      });

      throw err;
    } finally {
      this.runningWorkflows.delete(run.id);
    }

    return run;
  }

  async pause(runId: string): Promise<void> {
    const run = await this.loadRun(runId);
    if (!run) {
      throw new Error(`Workflow not found: ${runId}`);
    }

    if (run.status !== "running") {
      throw new Error(`Cannot pause workflow in status: ${run.status}`);
    }

    run.status = "paused";
    await this.saveAndPersist(run);

    await this.emitEvent({
      type: "workflow:paused",
      workflowId: run.id,
      timestamp: Date.now(),
    });
  }

  async resume(runId: string): Promise<WorkflowRun> {
    const run = await this.loadRun(runId);
    if (!run) {
      throw new Error(`Workflow not found: ${runId}`);
    }

    if (run.status !== "paused") {
      throw new Error(`Cannot resume workflow in status: ${run.status}`);
    }

    run.status = "running";
    await this.saveAndPersist(run);

    await this.emitEvent({
      type: "workflow:resumed",
      workflowId: run.id,
      timestamp: Date.now(),
    });

    // Continue execution
    return this.execute(runId);
  }

  async cancel(runId: string): Promise<void> {
    const run = await this.loadRun(runId);
    if (!run) {
      throw new Error(`Workflow not found: ${runId}`);
    }

    if (run.status === "completed" || run.status === "cancelled") {
      throw new Error(`Cannot cancel workflow in status: ${run.status}`);
    }

    run.status = "cancelled";
    run.completedAt = Date.now();
    await this.saveAndPersist(run);

    this.runningWorkflows.delete(run.id);

    await this.emitEvent({
      type: "workflow:cancelled",
      workflowId: run.id,
      timestamp: Date.now(),
    });
  }

  // ==========================================================================
  // Phase Execution
  // ==========================================================================

  private async executePhases(run: WorkflowRun, definition: WorkflowDefinition): Promise<void> {
    let currentPhaseIndex = 0;

    // Resume from last phase if restarting
    if (run.currentPhase) {
      currentPhaseIndex = definition.phases.findIndex((p) => p.id === run.currentPhase);
      if (currentPhaseIndex === -1) currentPhaseIndex = 0;
    }

    while (currentPhaseIndex < definition.phases.length) {
      // Check for pause
      if (run.status === "paused") {
        return;
      }

      const phase = definition.phases[currentPhaseIndex];
      run.currentPhase = phase.id;

      // Check max iterations
      const phaseIterations = run.phaseHistory.filter((p) => p.phaseId === phase.id).length;
      if (phaseIterations >= definition.settings.maxReviewIterations) {
        throw new Error(
          `Maximum iterations (${definition.settings.maxReviewIterations}) exceeded for phase: ${phase.id}`,
        );
      }

      // Execute phase
      const execution = await this.executePhase(run, phase, phaseIterations + 1);
      run.phaseHistory.push(execution);
      run.iterationCount++;

      await this.saveAndPersist(run);

      // Check for phase failure
      if (execution.status === "failed") {
        const retries = phase.settings.retries || 0;
        const attempts = run.phaseHistory.filter(
          (p) => p.phaseId === phase.id && p.status === "failed",
        ).length;

        if (attempts > retries) {
          throw new Error(`Phase "${phase.id}" failed after ${attempts} attempts`);
        }

        // Retry the same phase
        continue;
      }

      // Check transitions
      const nextPhase = await this.evaluateTransitions(run, phase, execution);

      if (nextPhase) {
        // Find the target phase index
        const targetIndex = definition.phases.findIndex((p) => p.id === nextPhase);
        if (targetIndex === -1) {
          throw new Error(`Invalid transition target: ${nextPhase}`);
        }
        currentPhaseIndex = targetIndex;

        await this.emitEvent({
          type: "iteration:started",
          workflowId: run.id,
          timestamp: Date.now(),
          data: { fromPhase: phase.id, toPhase: nextPhase, iteration: run.iterationCount },
        });
      } else {
        // Move to next phase
        currentPhaseIndex++;
      }

      // Notify on phase complete
      if (definition.settings.notifyOnPhaseComplete) {
        // TODO: Send notification
      }
    }
  }

  private async executePhase(
    run: WorkflowRun,
    phase: PhaseDefinition,
    iteration: number,
  ): Promise<PhaseExecution> {
    const execution: PhaseExecution = {
      phaseId: phase.id,
      iteration,
      status: "pending",
      artifacts: [],
      metrics: {
        durationMs: 0,
      },
      logPath: `phases/${String(iteration).padStart(2, "0")}-${phase.id}/logs`,
    };

    await this.emitEvent({
      type: "phase:started",
      workflowId: run.id,
      timestamp: Date.now(),
      data: { phaseId: phase.id, iteration },
    });

    const startTime = Date.now();

    try {
      execution.status = "running";

      // Execute agent based on phase engine
      // TODO: Implement agent execution via engines
      await this.runPhaseEngine(run, phase, iteration);

      // Validate output
      const validation = await validatePhaseOutput(run.id, phase, iteration);
      if (!validation.valid) {
        throw new Error(`Phase validation failed: ${validation.errors.join(", ")}`);
      }

      execution.status = "completed";
      execution.artifacts = phase.outputArtifacts;

      await this.emitEvent({
        type: "phase:completed",
        workflowId: run.id,
        timestamp: Date.now(),
        data: { phaseId: phase.id, iteration },
      });
    } catch (err) {
      execution.status = "failed";

      await this.emitEvent({
        type: "phase:failed",
        workflowId: run.id,
        timestamp: Date.now(),
        data: {
          phaseId: phase.id,
          iteration,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }

    execution.metrics.durationMs = Date.now() - startTime;

    return execution;
  }

  private async runPhaseEngine(
    _run: WorkflowRun,
    phase: PhaseDefinition,
    _iteration: number,
  ): Promise<void> {
    // TODO: Implement engine dispatch
    // For now, this is a placeholder that will be filled in Phase 2 & 3

    switch (phase.engine) {
      case "planner":
        // Will call planner engine
        console.log(`[workflows] Running planner engine for phase ${phase.id}`);
        break;

      case "executor":
        // Will call executor engine
        console.log(`[workflows] Running executor engine for phase ${phase.id}`);
        break;

      case "reviewer":
        // Will call reviewer engine
        console.log(`[workflows] Running reviewer engine for phase ${phase.id}`);
        break;

      default: {
        const _exhaustive: never = phase.engine;
        throw new Error(`Unknown engine type: ${_exhaustive as string}`);
      }
    }
  }

  private async evaluateTransitions(
    run: WorkflowRun,
    phase: PhaseDefinition,
    execution: PhaseExecution,
  ): Promise<string | null> {
    if (!phase.transitions || phase.transitions.length === 0) {
      return null;
    }

    // Load artifacts for condition evaluation
    const artifacts: Record<string, unknown> = {};

    for (const artifactName of phase.outputArtifacts) {
      const content = await loadArtifactJson(run.id, phase.id, execution.iteration, artifactName);
      if (content) {
        // Use filename without extension as key, normalized to camelCase
        // e.g., "plan-review.json" -> "planReview"
        const rawKey = artifactName.replace(/\.[^.]+$/, "");
        const key = kebabToCamelCase(rawKey);
        artifacts[key] = content;
      }
    }

    // Evaluate transitions in order
    for (const transition of phase.transitions) {
      const matches = evaluateCondition(transition.condition, artifacts);
      if (matches) {
        return transition.targetPhase;
      }
    }

    return null;
  }

  // ==========================================================================
  // Status & Monitoring
  // ==========================================================================

  async getStatus(runId: string): Promise<WorkflowRun | null> {
    return this.loadRun(runId);
  }

  async getArtifacts(runId: string): Promise<ReturnType<typeof generateManifest>> {
    return generateManifest(runId);
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  onWorkflowEvent(handler: WorkflowEventHandler): void {
    this.on("workflow-event", handler);
  }

  private async emitEvent(event: WorkflowEvent): Promise<void> {
    // Log to persistent storage
    await logWorkflowEvent(event);

    // Emit to listeners
    this.emit("workflow-event", event);

    // Save state for persistence events
    if (PERSISTENCE_EVENTS.includes(event.type as (typeof PERSISTENCE_EVENTS)[number])) {
      const run = this.runningWorkflows.get(event.workflowId);
      if (run) {
        await saveWorkflowState(run);
      }
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private async loadRun(runId: string): Promise<WorkflowRun | null> {
    // Check in-memory first
    const cached = this.runningWorkflows.get(runId);
    if (cached) return cached;

    // Load from disk
    return loadWorkflowState(runId);
  }

  private async saveAndPersist(run: WorkflowRun): Promise<void> {
    this.runningWorkflows.set(run.id, run);
    await saveWorkflowState(run);
  }

  private isRecoverableError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;

    // Timeout errors are potentially recoverable
    if (err.message.includes("timeout")) return true;

    // Network errors are potentially recoverable
    if (err.message.includes("ECONNREFUSED")) return true;
    if (err.message.includes("ETIMEDOUT")) return true;

    return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert kebab-case to camelCase.
 * e.g., "plan-review" -> "planReview"
 */
function kebabToCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

// ============================================================================
// Singleton Instance
// ============================================================================

let orchestratorInstance: WorkflowOrchestrator | null = null;

export function getOrchestrator(): WorkflowOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new WorkflowOrchestrator();
  }
  return orchestratorInstance;
}

export function resetOrchestrator(): void {
  orchestratorInstance = null;
}
