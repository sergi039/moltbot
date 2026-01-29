/**
 * Workspace Management
 *
 * Handles workspace setup, validation, and cleanup for workflows.
 * Supports in-place, worktree, and copy modes.
 */

import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";
import * as readline from "node:readline";

import type { WorkspaceConfig, InPlaceValidationOptions, ValidationResult } from "../types.js";

import { DEFAULT_UNTRACKED_CHECK_PATHS } from "../constants.js";
import { getWorkflowDir } from "./persistence.js";

// ============================================================================
// Security: Branch Name Sanitization
// ============================================================================

const SAFE_BRANCH_PATTERN = /^[-/A-Za-z0-9_.]+$/;

/**
 * Sanitize and validate a git branch name.
 * Only allows alphanumeric, dash, slash, underscore, and dot.
 */
export function sanitizeBranchName(branch: string): string {
  if (!SAFE_BRANCH_PATTERN.test(branch)) {
    throw new Error(
      `Invalid branch name "${branch}": contains unsafe characters. ` +
        `Only alphanumeric, dash, slash, underscore, and dot are allowed.`,
    );
  }
  return branch;
}

// ============================================================================
// Workspace Setup
// ============================================================================

export interface WorkspaceSetupResult {
  workspacePath: string;
  branch?: string;
  needsCleanup: boolean;
}

export async function setupWorkspace(
  runId: string,
  config: WorkspaceConfig,
): Promise<WorkspaceSetupResult> {
  switch (config.mode) {
    case "in-place":
      return setupInPlaceWorkspace(runId, config);
    case "worktree":
      return setupWorktreeWorkspace(runId, config);
    case "copy":
      return setupCopyWorkspace(runId, config);
    default: {
      const _exhaustive: never = config.mode;
      throw new Error(`Unknown workspace mode: ${_exhaustive as string}`);
    }
  }
}

async function setupInPlaceWorkspace(
  runId: string,
  config: WorkspaceConfig,
): Promise<WorkspaceSetupResult> {
  const validation = await validateInPlaceWorkspace(config.targetRepo, config.validation);

  if (!validation.valid) {
    throw new Error(
      `Cannot use in-place workspace:\n${validation.errors.join("\n")}\n\n` +
        `Options:\n` +
        `1. Commit or stash your changes: git stash\n` +
        `2. Use worktree mode: --workspace-mode worktree\n` +
        `3. Use copy mode: --workspace-mode copy`,
    );
  }

  return {
    workspacePath: config.targetRepo,
    needsCleanup: false,
  };
}

async function setupWorktreeWorkspace(
  runId: string,
  config: WorkspaceConfig,
): Promise<WorkspaceSetupResult> {
  // AGENTS.md Compliance: Require explicit user confirmation
  const confirmed = await requestWorktreeConfirmation(runId, config);
  if (!confirmed) {
    throw new Error("Worktree creation cancelled by user");
  }

  const workspacePath = join(getWorkflowDir(runId), "workspace");
  const branch = sanitizeBranchName(config.branch || `workflow/${runId}`);
  const baseBranch = sanitizeBranchName(config.baseBranch || "main");

  // Create worktree with new branch (using execFileSync to prevent shell injection)
  try {
    execFileSync("git", ["worktree", "add", "-b", branch, workspacePath, baseBranch], {
      cwd: config.targetRepo,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err) {
    throw new Error(
      `Failed to create git worktree: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    workspacePath,
    branch,
    needsCleanup: true,
  };
}

async function setupCopyWorkspace(
  runId: string,
  config: WorkspaceConfig,
): Promise<WorkspaceSetupResult> {
  const workspacePath = join(getWorkflowDir(runId), "workspace");

  mkdirSync(workspacePath, { recursive: true });

  if (config.shallow && isGitRepo(config.targetRepo)) {
    // Use shallow clone for git repos (using execFileSync to prevent shell injection)
    const remote = getGitRemote(config.targetRepo);
    if (remote) {
      try {
        execFileSync("git", ["clone", "--depth", "1", remote, workspacePath], {
          encoding: "utf-8",
          stdio: "pipe",
        });
        return {
          workspacePath,
          needsCleanup: true,
        };
      } catch {
        // Fall back to full copy
      }
    }
  }

  // Full directory copy
  cpSync(config.targetRepo, workspacePath, {
    recursive: true,
    filter: (src) => {
      // Skip .git internals for non-git copies, node_modules, etc.
      const relativePath = src.replace(config.targetRepo, "");
      if (relativePath.includes("node_modules")) return false;
      if (relativePath.includes(".git/objects")) return false;
      return true;
    },
  });

  return {
    workspacePath,
    needsCleanup: true,
  };
}

// ============================================================================
// Workspace Validation
// ============================================================================

export async function validateInPlaceWorkspace(
  repoPath: string,
  options: InPlaceValidationOptions = {},
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { failOnUntracked = false, untrackedCheckPaths = DEFAULT_UNTRACKED_CHECK_PATHS } = options;

  // 1. Must be a git repository
  if (!isGitRepo(repoPath)) {
    errors.push("Target path is not a git repository");
    return { valid: false, errors, warnings };
  }

  // 2. Working tree must be clean (modified/staged = hard block)
  const status = getGitStatus(repoPath);

  if (status.modified.length > 0 || status.staged.length > 0) {
    errors.push(
      `Working tree has uncommitted changes: ${status.modified.length} modified, ${status.staged.length} staged`,
    );

    // List the files
    const files = [...status.modified.slice(0, 5), ...status.staged.slice(0, 5)];
    errors.push(`Modified files:\n  - ${files.join("\n  - ")}`);
  }

  // 3. Untracked files check (configurable: warn or fail)
  const untracked = status.untracked.filter((f) =>
    untrackedCheckPaths.some((p) => f.startsWith(p)),
  );

  if (untracked.length > 0) {
    const msg = `Untracked source files found: ${untracked.slice(0, 5).join(", ")}${
      untracked.length > 5 ? "..." : ""
    }`;
    if (failOnUntracked) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export async function validateWorktreeWorkspace(repoPath: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Must be a git repository
  if (!isGitRepo(repoPath)) {
    errors.push("Target path is not a git repository");
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================================
// Workspace Cleanup
// ============================================================================

export async function cleanupWorkspace(runId: string, config: WorkspaceConfig): Promise<void> {
  if (config.mode === "in-place") {
    // Nothing to clean up for in-place
    return;
  }

  const workspacePath = join(getWorkflowDir(runId), "workspace");

  if (config.mode === "worktree") {
    // AGENTS.md Compliance: Require confirmation for worktree removal
    const confirmed = await requestWorktreeRemovalConfirmation(runId, config, workspacePath);
    if (!confirmed) {
      console.log(`[workflows] Worktree cleanup skipped for ${runId}`);
      return;
    }

    try {
      // Remove worktree (using execFileSync to prevent shell injection)
      execFileSync("git", ["worktree", "remove", workspacePath], {
        cwd: config.targetRepo,
        encoding: "utf-8",
        stdio: "pipe",
      });

      // Delete branch (if exists and not merged)
      const branch = sanitizeBranchName(config.branch || `workflow/${runId}`);
      try {
        execFileSync("git", ["branch", "-D", branch], {
          cwd: config.targetRepo,
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch {
        // Branch may not exist or already deleted
      }
    } catch (err) {
      console.error(`[workflows] Failed to cleanup worktree: ${String(err)}`);
    }
  } else if (config.mode === "copy") {
    // Simply remove the copied directory
    if (existsSync(workspacePath)) {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// Git Helpers
// ============================================================================

export function isGitRepo(path: string): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: path,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

interface GitStatus {
  modified: string[];
  staged: string[];
  untracked: string[];
}

function getGitStatus(repoPath: string): GitStatus {
  const status: GitStatus = {
    modified: [],
    staged: [],
    untracked: [],
  };

  try {
    const output = execSync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    });

    for (const line of output.split("\n")) {
      if (!line.trim()) continue;

      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.slice(3);

      if (indexStatus !== " " && indexStatus !== "?") {
        status.staged.push(filePath);
      }

      if (workTreeStatus === "M" || workTreeStatus === "D") {
        status.modified.push(filePath);
      }

      if (indexStatus === "?" && workTreeStatus === "?") {
        status.untracked.push(filePath);
      }
    }
  } catch {
    // Git command failed
  }

  return status;
}

function getGitRemote(repoPath: string): string | null {
  try {
    const output = execSync("git remote get-url origin", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return output.trim();
  } catch {
    return null;
  }
}

export function getCurrentBranch(repoPath: string): string | null {
  try {
    const output = execSync("git branch --show-current", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

// ============================================================================
// User Confirmation (AGENTS.md Compliance)
// ============================================================================

async function requestWorktreeConfirmation(
  runId: string,
  config: WorkspaceConfig,
): Promise<boolean> {
  // In non-interactive mode, always reject
  if (!process.stdin.isTTY) {
    console.error(
      "[workflows] Worktree mode requires interactive confirmation but stdin is not a TTY",
    );
    return false;
  }

  const workspacePath = join(getWorkflowDir(runId), "workspace");
  const branch = config.branch || `workflow/${runId}`;

  console.log(`
Worktree mode requested. This will:
  - Create a new git worktree at ${workspacePath}
  - Create branch: ${branch}

Per repo policy, worktree operations require explicit confirmation.
`);

  return askYesNo("Proceed? [y/N]");
}

async function requestWorktreeRemovalConfirmation(
  runId: string,
  config: WorkspaceConfig,
  workspacePath: string,
): Promise<boolean> {
  // In non-interactive mode, skip cleanup
  if (!process.stdin.isTTY) {
    return false;
  }

  const branch = config.branch || `workflow/${runId}`;

  console.log(`
Workflow cleanup requested. This will:
  - Remove git worktree at ${workspacePath}
  - Delete branch: ${branch}

Per repo policy, worktree operations require explicit confirmation.
`);

  return askYesNo("Proceed with cleanup? [y/N]");
}

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(prompt + " ", (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}
