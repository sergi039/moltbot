/**
 * Agent Handoff Protocol
 *
 * Manages communication between agents during workflow execution.
 * Creates structured handoff packages for seamless agent transitions.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkflowRun,
  PhaseDefinition,
  HandoffContext,
  ProjectContext,
  ChangesInScope,
} from "../types.js";
import { loadArtifact } from "../artifacts/store.js";
import {
  HANDOFF_DIR,
  HANDOFF_CONTEXT_FILE,
  HANDOFF_INSTRUCTIONS_FILE,
  HANDOFF_EXPECTATIONS_FILE,
} from "../constants.js";
import { getPhaseDir } from "../state/persistence.js";

// ============================================================================
// Handoff Package Creation
// ============================================================================

export interface HandoffPackage {
  contextPath: string;
  instructionsPath: string;
  expectationsPath: string;
  artifactsDir: string;
}

export async function createHandoffPackage(
  run: WorkflowRun,
  phase: PhaseDefinition,
  iteration: number,
  previousPhase: PhaseDefinition | null,
): Promise<HandoffPackage> {
  const phaseDir = getPhaseDir(run.id, phase.id, iteration);
  const handoffDir = join(phaseDir, HANDOFF_DIR);

  mkdirSync(handoffDir, { recursive: true });

  // Create context
  const context = await buildHandoffContext(run, phase, iteration, previousPhase);
  const contextPath = join(handoffDir, HANDOFF_CONTEXT_FILE);
  await writeFile(contextPath, JSON.stringify(context, null, 2));

  // Create instructions
  const instructions = buildInstructions(run, phase, context);
  const instructionsPath = join(handoffDir, HANDOFF_INSTRUCTIONS_FILE);
  await writeFile(instructionsPath, instructions);

  // Create expectations
  const expectations = buildExpectations(phase);
  const expectationsPath = join(handoffDir, HANDOFF_EXPECTATIONS_FILE);
  await writeFile(expectationsPath, JSON.stringify(expectations, null, 2));

  // Copy relevant artifacts from previous phase
  const artifactsDir = join(handoffDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  if (previousPhase) {
    const prevIteration = run.phaseHistory.filter(
      (pe) => pe.phaseId === previousPhase.id && pe.status === "completed",
    ).length;

    for (const artifact of phase.inputArtifacts) {
      const content = await loadArtifact(run.id, previousPhase.id, prevIteration, artifact);
      if (content) {
        await writeFile(join(artifactsDir, artifact), content);
      }
    }
  }

  return {
    contextPath,
    instructionsPath,
    expectationsPath,
    artifactsDir,
  };
}

// ============================================================================
// Context Building
// ============================================================================

async function buildHandoffContext(
  run: WorkflowRun,
  phase: PhaseDefinition,
  iteration: number,
  previousPhase: PhaseDefinition | null,
): Promise<HandoffContext> {
  const projectContext = await detectProjectContext(run.workspace.targetRepo);
  const changesInScope = previousPhase
    ? await detectChangesInScope(run.workspace.targetRepo)
    : { added: [], modified: [], deleted: [] };

  const relevantFiles = await findRelevantFiles(
    run.workspace.targetRepo,
    projectContext,
    changesInScope,
  );

  return {
    workflowId: run.id,
    phase: phase.id,
    iteration,
    previousPhase: previousPhase?.id ?? null,
    projectContext,
    relevantFiles,
    changesInScope,
  };
}

async function detectProjectContext(repoPath: string): Promise<ProjectContext> {
  const context: ProjectContext = {
    name: "unknown",
    language: "unknown",
  };

  // Try to get project name from package.json
  const packageJsonPath = join(repoPath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const content = await readFile(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      context.name = pkg.name || "unknown";
      context.language = "typescript"; // Assume TS for npm projects

      // Detect framework
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.react) context.framework = "react";
      else if (deps.vue) context.framework = "vue";
      else if (deps.express) context.framework = "express";
      else if (deps.fastify) context.framework = "fastify";
      else if (deps.next) context.framework = "next";
    } catch {
      // Ignore parse errors
    }
  }

  // Check for other languages
  if (existsSync(join(repoPath, "Cargo.toml"))) {
    context.language = "rust";
  } else if (existsSync(join(repoPath, "go.mod"))) {
    context.language = "go";
  } else if (
    existsSync(join(repoPath, "requirements.txt")) ||
    existsSync(join(repoPath, "pyproject.toml"))
  ) {
    context.language = "python";
  }

  return context;
}

async function detectChangesInScope(repoPath: string): Promise<ChangesInScope> {
  const changes: ChangesInScope = {
    added: [],
    modified: [],
    deleted: [],
  };

  try {
    // Get staged and unstaged changes
    const status = execSync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf-8",
    });

    for (const line of status.split("\n")) {
      if (!line.trim()) continue;

      const statusCode = line.slice(0, 2);
      const filePath = line.slice(3);

      if (statusCode.includes("A") || statusCode === "??") {
        changes.added.push(filePath);
      } else if (statusCode.includes("M")) {
        changes.modified.push(filePath);
      } else if (statusCode.includes("D")) {
        changes.deleted.push(filePath);
      }
    }
  } catch {
    // Not a git repo or git error
  }

  return changes;
}

async function findRelevantFiles(
  repoPath: string,
  projectContext: ProjectContext,
  changesInScope: ChangesInScope,
): Promise<string[]> {
  const relevantFiles = new Set<string>();

  // Add all changed files
  for (const file of [...changesInScope.added, ...changesInScope.modified]) {
    relevantFiles.add(file);
  }

  // Add entry points based on language
  const entryPoints: Record<string, string[]> = {
    typescript: ["src/index.ts", "src/main.ts", "index.ts"],
    javascript: ["src/index.js", "src/main.js", "index.js"],
    python: ["main.py", "app.py", "src/main.py"],
    rust: ["src/main.rs", "src/lib.rs"],
    go: ["main.go", "cmd/main.go"],
  };

  const languageEntryPoints = entryPoints[projectContext.language] || [];
  for (const entry of languageEntryPoints) {
    if (existsSync(join(repoPath, entry))) {
      relevantFiles.add(entry);
    }
  }

  return Array.from(relevantFiles);
}

// ============================================================================
// Instructions Generation
// ============================================================================

function buildInstructions(
  run: WorkflowRun,
  phase: PhaseDefinition,
  context: HandoffContext,
): string {
  const sections: string[] = [];

  // Header
  sections.push(`# ${phase.name} Instructions`);
  sections.push("");

  // Role description
  sections.push("## Your Role");
  sections.push(getRoleDescription(phase));
  sections.push("");

  // Context
  sections.push("## Project Context");
  sections.push(`- **Project:** ${context.projectContext.name}`);
  sections.push(`- **Language:** ${context.projectContext.language}`);
  if (context.projectContext.framework) {
    sections.push(`- **Framework:** ${context.projectContext.framework}`);
  }
  sections.push("");

  // Task description
  sections.push("## Task");
  sections.push(run.input.task);
  sections.push("");

  // Changes in scope (if any)
  if (context.changesInScope.added.length > 0 || context.changesInScope.modified.length > 0) {
    sections.push("## Changes in Scope");
    if (context.changesInScope.added.length > 0) {
      sections.push("**Added:**");
      for (const file of context.changesInScope.added.slice(0, 10)) {
        sections.push(`- \`${file}\``);
      }
    }
    if (context.changesInScope.modified.length > 0) {
      sections.push("**Modified:**");
      for (const file of context.changesInScope.modified.slice(0, 10)) {
        sections.push(`- \`${file}\``);
      }
    }
    sections.push("");
  }

  // Engine-specific instructions
  sections.push("## Instructions");
  sections.push(getEngineInstructions(phase));
  sections.push("");

  // Output requirements
  sections.push("## Output Requirements");
  sections.push("You must produce the following artifacts:");
  for (const artifact of phase.outputArtifacts) {
    sections.push(`- \`${artifact}\``);
  }
  sections.push("");
  sections.push("Place all artifacts in the `artifacts/` directory.");

  return sections.join("\n");
}

function getRoleDescription(phase: PhaseDefinition): string {
  const roles: Record<string, string> = {
    planner:
      "You are the project planner. Your job is to analyze the task, " +
      "break it down into atomic tasks, and create a comprehensive plan.",
    executor:
      "You are the developer. Your job is to implement the tasks defined " +
      "in the plan, write tests, and ensure code quality.",
    reviewer:
      "You are the code reviewer. Your job is to review the implementation, " +
      "identify issues, and provide recommendations for improvement.",
  };

  return roles[phase.engine] || "You are an AI assistant helping with this workflow.";
}

function getEngineInstructions(phase: PhaseDefinition): string {
  switch (phase.engine) {
    case "planner":
      return `
1. Analyze the project structure and understand the existing codebase
2. Break down the task into atomic, implementable subtasks
3. Identify dependencies between tasks
4. Estimate complexity for each task (1-5 scale)
5. Create plan.json with the project plan
6. Create tasks.json with the detailed task list

Follow the TaskList schema for tasks.json structure.
      `.trim();

    case "executor":
      return `
1. Read the tasks.json to understand what needs to be implemented
2. Execute tasks in dependency order
3. Write tests for each implemented feature
4. Run tests to verify correctness
5. Update tasks.json with completion status
6. Create execution-report.md summarizing what was done

Use scripts/committer for any commits (per repo policy).
      `.trim();

    case "reviewer":
      return `
1. Review all code changes against the original plan
2. Check for:
   - Architectural alignment
   - Code quality and best practices
   - Test coverage
   - Security issues
   - Documentation completeness
3. Score each category (0-100)
4. Identify specific issues with severity levels
5. Provide actionable recommendations
6. Create review.json with your findings

Set approved: true only if there are no critical issues.
      `.trim();

    default:
      return "Follow the phase requirements and produce the expected artifacts.";
  }
}

// ============================================================================
// Expectations Generation
// ============================================================================

interface ExpectationsSchema {
  artifacts: ArtifactExpectation[];
  validationRules: string[];
}

interface ArtifactExpectation {
  name: string;
  required: boolean;
  schema?: string;
  description: string;
}

function buildExpectations(phase: PhaseDefinition): ExpectationsSchema {
  const artifacts: ArtifactExpectation[] = [];

  for (const artifactName of phase.outputArtifacts) {
    artifacts.push({
      name: artifactName,
      required: true,
      schema: getSchemaReference(artifactName),
      description: getArtifactDescription(artifactName),
    });
  }

  return {
    artifacts,
    validationRules: [
      "All required artifacts must be valid JSON (for .json files)",
      "All artifacts must pass schema validation",
      "No secrets or sensitive data in artifacts",
    ],
  };
}

function getSchemaReference(artifactName: string): string | undefined {
  const schemas: Record<string, string> = {
    "tasks.json": "TaskList",
    "review.json": "ReviewResult",
    "plan-review.json": "ReviewResult",
    "plan.json": "PlanDocument",
  };

  return schemas[artifactName];
}

function getArtifactDescription(artifactName: string): string {
  const descriptions: Record<string, string> = {
    "plan.json": "High-level project plan with goals and approach",
    "tasks.json": "Detailed task list with dependencies and acceptance criteria",
    "review.json": "Code review results with scores and issues",
    "plan-review.json": "Plan review results with approval status",
    "execution-report.md": "Summary of executed tasks and results",
    "recommendations.md": "Human-readable recommendations from review",
    "final-report.md": "Final workflow summary and deliverables",
    "changelog.md": "Changes made during the workflow",
  };

  return descriptions[artifactName] || `Artifact: ${artifactName}`;
}

// ============================================================================
// Handoff Loading
// ============================================================================

export async function loadHandoffContext(
  run: WorkflowRun,
  phaseId: string,
  iteration: number,
): Promise<HandoffContext | null> {
  const handoffDir = join(getPhaseDir(run.id, phaseId, iteration), HANDOFF_DIR);
  const contextPath = join(handoffDir, HANDOFF_CONTEXT_FILE);

  if (!existsSync(contextPath)) {
    return null;
  }

  try {
    const content = await readFile(contextPath, "utf-8");
    return JSON.parse(content) as HandoffContext;
  } catch {
    return null;
  }
}
