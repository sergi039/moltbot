/**
 * Workflow Orchestrator
 *
 * Main entry point for the multi-agent workflow system.
 * Manages workflow lifecycle, phase transitions, and agent coordination.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

import {
  generateWorkflowId,
  PERSISTENCE_EVENTS,
  WORKSPACE_DIR,
  DEFAULT_MAX_AGENT_RUNS,
} from "./constants.js";

import {
  saveWorkflowState,
  loadWorkflowState,
  saveWorkflowInput,
  logWorkflowEvent,
  getWorkflowDir,
  getPhaseDir,
  listRunningWorkflows,
} from "./state/persistence.js";

import { validatePhaseOutput, evaluateCondition } from "./artifacts/validator.js";
import { loadArtifactJson, generateManifest, getArtifactsDir } from "./artifacts/store.js";
import { attachObservability, type ObservabilityAdapter } from "./observability/adapter.js";
import { loadConfig } from "../config/io.js";
import { DEFAULT_LOG_ROTATION_OPTIONS, type LogRotationOptions } from "./retention/types.js";
import { startCleanupScheduler, stopCleanupScheduler } from "./retention/scheduler.js";
import { startMemoryScheduler, stopMemoryScheduler } from "../memory/facts/scheduler.js";
import {
  DEFAULT_RETENTION_CONFIG,
  DEFAULT_CLEANUP_INTERVAL_MINUTES,
  DEFAULT_MAX_RETRIES,
} from "./constants.js";
import { getEngine, type EngineContext } from "./engines/index.js";
import {
  createPolicyRuntime,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type PolicyRuntime,
} from "./policy/runtime.js";
import { getWorkflowStoragePath } from "./state/persistence.js";

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

    // Allow resume from paused or failed states
    if (run.status !== "paused" && run.status !== "failed") {
      throw new Error(`Cannot resume workflow in status: ${run.status}`);
    }

    // Save previous status before changing it
    const previousStatus = run.status;

    // Check max retries for failed workflows
    const maxRetries = run.maxRetries ?? DEFAULT_MAX_RETRIES;
    const currentRetries = run.retryCount ?? 0;

    if (previousStatus === "failed") {
      if (currentRetries >= maxRetries) {
        throw new Error(
          `Maximum retries (${maxRetries}) exceeded for workflow ${runId}. ` +
            `Last error: ${run.error?.message || "unknown"}`,
        );
      }
      run.retryCount = currentRetries + 1;
    }

    run.status = "running";
    run.resumedAt = Date.now();
    await this.saveAndPersist(run);

    await this.emitEvent({
      type: "workflow:resumed",
      workflowId: run.id,
      timestamp: Date.now(),
      data: {
        previousStatus,
        retryCount: run.retryCount,
        maxRetries,
      },
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

    // Get workflow start time for timeout enforcement
    const workflowStartTime = run.startedAt ?? Date.now();
    const maxDurationMs = definition.settings.maxDurationMs;

    while (currentPhaseIndex < definition.phases.length) {
      // Check for pause
      if (run.status === "paused") {
        return;
      }

      // ========== ANTI-LOOP: Enforce maxDurationMs ==========
      const elapsedMs = Date.now() - workflowStartTime;
      if (elapsedMs > maxDurationMs) {
        throw new Error(
          `Workflow timeout: exceeded maxDurationMs (${maxDurationMs}ms). ` +
            `Elapsed: ${elapsedMs}ms. Phase: ${run.currentPhase || "unknown"}`,
        );
      }

      // ========== ANTI-LOOP: Check agent run limit ==========
      const maxAgentRuns = definition.settings.maxAgentRuns ?? DEFAULT_MAX_AGENT_RUNS;
      const currentAgentRuns = run.agentRunCount ?? 0;
      if (currentAgentRuns >= maxAgentRuns) {
        throw new Error(
          `Agent run limit exceeded: ${currentAgentRuns}/${maxAgentRuns} runs. ` +
            `This prevents excessive token consumption. ` +
            `Increase maxAgentRuns in workflow settings if needed.`,
        );
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

      // Execute phase (pass maxTasks from definition settings)
      const execution = await this.executePhase(run, phase, phaseIterations + 1, {
        maxTasks: definition.settings.maxTasks,
      });
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
    options?: { maxTasks?: number },
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

      // Validate output (pass maxTasks for task list validation)
      const validation = await validatePhaseOutput(run.id, phase, iteration, {
        maxTasks: options?.maxTasks,
      });
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
    run: WorkflowRun,
    phase: PhaseDefinition,
    iteration: number,
  ): Promise<void> {
    // Get the appropriate engine
    const engine = getEngine(phase.engine);

    // Check if live mode is enabled
    const inputContext = run.input.context as Record<string, unknown> | undefined;
    const isLive = inputContext?.live === true;
    const autoApprove = inputContext?.autoApprove === true;

    // Build workflow/phase/artifacts directories
    const workflowDir = getWorkflowDir(run.id);
    const phaseDir = getPhaseDir(run.id, phase.id, iteration);
    const artifactsDir = getArtifactsDir(run.id, phase.id, iteration);

    // Compute actual workspace path based on workspace mode
    // - "in-place": use original repo path
    // - "worktree" or "copy": workspace is under workflow directory
    const workspacePath =
      run.workspace.mode === "worktree" || run.workspace.mode === "copy"
        ? join(workflowDir, WORKSPACE_DIR)
        : run.workspace.targetRepo;

    // Build policy runtime for live mode
    let policyRuntime: PolicyRuntime | undefined;
    if (isLive) {
      const config = loadConfig();
      const approvalTimeoutMs =
        config.workflows?.policy?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

      // Get logger from observability adapter if available
      const logger = observabilityAdapterInstance?.getLogger(run.id);

      policyRuntime = createPolicyRuntime({
        runId: run.id,
        workspacePath,
        storageBasePath: getWorkflowStoragePath(),
        approvalTimeoutMs,
        logger,
        interactive: !autoApprove, // CLI runs are interactive unless auto-approve
        autoApprove,
      });
    }

    // Build engine context
    const context: EngineContext = {
      run,
      phase,
      iteration,
      workflowDir,
      phaseDir,
      artifactsDir,
      workspacePath,
      // Policy runtime options (only set in live mode)
      policyEngine: policyRuntime?.engine,
      policy: policyRuntime?.policy,
      approvalTimeoutMs: policyRuntime?.approvalTimeoutMs,
      onApprovalEvent: policyRuntime?.onApprovalEvent,
      onProgress: (update) => {
        // Log progress via observability
        const logger = observabilityAdapterInstance?.getLogger(run.id);
        if (logger) {
          // Map engine progress types to observability event types
          const typeMap: Record<
            string,
            "agent.progress" | "artifact.save" | "task.start" | "task.complete" | "task.fail"
          > = {
            status: "agent.progress",
            artifact: "artifact.save",
            task: "task.start",
            error: "task.fail",
          };
          const eventType = typeMap[update.type] ?? "agent.progress";

          logger.logEvent({
            runId: run.id,
            phaseId: phase.id,
            type: eventType,
            payload: {
              message: update.message,
              ...update.data,
            },
          });
        }
      },
    };

    // Validate inputs
    const validation = await engine.validateInputs(context);
    if (!validation.valid) {
      throw new Error(`Engine input validation failed: ${validation.errors.join(", ")}`);
    }

    // ========== ANTI-LOOP: Increment agent run counter (only in live mode) ==========
    if (isLive) {
      run.agentRunCount = (run.agentRunCount ?? 0) + 1;
      await saveWorkflowState(run);
    }

    // Execute the engine
    const result = await engine.execute(context);

    if (!result.success) {
      throw new Error(result.error || `Engine ${phase.engine} failed`);
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
let observabilityAdapterInstance: ObservabilityAdapter | null = null;

export function getOrchestrator(): WorkflowOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new WorkflowOrchestrator();

    // Attach observability adapter with config-based settings
    const config = loadConfig();
    const logRotation = config.workflows?.retention?.logRotation;
    const retention = config.workflows?.retention;

    // Convert config logRotation to LogRotationOptions | null | undefined
    let logRotationOptions: LogRotationOptions | null | undefined;
    if (logRotation === null) {
      // Explicitly disabled
      logRotationOptions = null;
    } else if (logRotation) {
      // Custom options from config, fallback to defaults
      logRotationOptions = {
        maxSizeBytes: logRotation.maxSizeBytes ?? DEFAULT_LOG_ROTATION_OPTIONS.maxSizeBytes,
        maxRotatedFiles:
          logRotation.maxRotatedFiles ?? DEFAULT_LOG_ROTATION_OPTIONS.maxRotatedFiles,
      };
    }
    // If undefined, adapter will use defaults

    observabilityAdapterInstance = attachObservability(orchestratorInstance, {
      enableRedaction: true,
      logRotation: logRotationOptions,
    });

    // Start cleanup scheduler if autoCleanup is enabled
    if (retention?.autoCleanup) {
      startCleanupScheduler({
        intervalMinutes: retention.cleanupIntervalMinutes ?? DEFAULT_CLEANUP_INTERVAL_MINUTES,
        runImmediately: true,
        retentionConfig: {
          maxCompleted: retention.maxCompleted ?? DEFAULT_RETENTION_CONFIG.maxCompleted,
          maxDiskPerWorkflowMb:
            retention.maxDiskPerWorkflowMb ?? DEFAULT_RETENTION_CONFIG.maxDiskPerWorkflowMb,
          maxTotalDiskGb: retention.maxTotalDiskGb ?? DEFAULT_RETENTION_CONFIG.maxTotalDiskGb,
          logRetentionDays: retention.logRetentionDays ?? DEFAULT_RETENTION_CONFIG.logRetentionDays,
          failedLogRetentionDays:
            retention.failedLogRetentionDays ?? DEFAULT_RETENTION_CONFIG.failedLogRetentionDays,
          artifactRetentionDays:
            retention.artifactRetentionDays ?? DEFAULT_RETENTION_CONFIG.artifactRetentionDays,
        },
      }).catch((err) => {
        console.error("[orchestrator] Failed to start cleanup scheduler:", err);
      });
    }

    // Start memory scheduler if facts memory is enabled
    const factsMemory = config.factsMemory;
    if (factsMemory?.enabled && factsMemory?.scheduler) {
      try {
        startMemoryScheduler(config, factsMemory.scheduler);
        console.log("[orchestrator] Memory scheduler started");
      } catch (err) {
        console.error("[orchestrator] Failed to start memory scheduler:", err);
      }
    }
  }
  return orchestratorInstance;
}

/**
 * Get the observability adapter instance (if attached).
 */
export function getObservabilityAdapter(): ObservabilityAdapter | null {
  return observabilityAdapterInstance;
}

export function resetOrchestrator(): void {
  // Stop cleanup scheduler
  stopCleanupScheduler();
  // Stop memory scheduler
  stopMemoryScheduler();

  orchestratorInstance = null;
  observabilityAdapterInstance = null;
}
