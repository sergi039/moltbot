/**
 * Reviewer Engine
 *
 * Reviews code changes using Codex.
 * Analyzes diffs against the base branch and produces:
 * - review.json: Structured review with scores and issues
 * - recommendations.json: Prioritized improvement suggestions
 */

import { execFileSync } from "node:child_process";

import type {
  WorkflowEngine,
  EngineContext,
  EngineResult,
  ReviewerOutput,
  ReviewerOptions,
} from "./types.js";
import type {
  ReviewResult,
  ReviewIssue,
  Recommendation,
  IssueSeverity,
  RecommendationPriority,
} from "../types.js";
import { saveArtifact } from "../artifacts/store.js";
import { REVIEW_FILE, RECOMMENDATIONS_FILE } from "../constants.js";
import { sanitizeBranchName } from "../state/workspace.js";

// ============================================================================
// Reviewer Engine
// ============================================================================

export class ReviewerEngine implements WorkflowEngine {
  readonly id = "reviewer" as const;
  readonly name = "Code Reviewer";

  private options: ReviewerOptions;

  constructor(options: ReviewerOptions = {}) {
    this.options = {
      baseBranch: "main",
      depth: "standard",
      minScore: 70,
      ...options,
    };
  }

  async validateInputs(context: EngineContext): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Check if workspace is a git repo
    try {
      execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: context.workspacePath,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      errors.push("Workspace is not a git repository");
    }

    // Sanitize and check if base branch exists
    try {
      const baseBranch = sanitizeBranchName(this.options.baseBranch || "main");
      execFileSync("git", ["rev-parse", "--verify", baseBranch], {
        cwd: context.workspacePath,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("unsafe characters")) {
        errors.push(err.message);
      } else {
        errors.push(`Base branch "${this.options.baseBranch}" does not exist`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(context: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();

    try {
      context.onProgress?.({
        type: "status",
        message: "Analyzing code changes...",
      });

      // Get diff stats
      const diffInfo = await this.getDiffInfo(context.workspacePath);

      context.onProgress?.({
        type: "status",
        message: `Found ${diffInfo.filesChanged} changed files, +${diffInfo.insertions}/-${diffInfo.deletions}`,
      });

      // Run code review (stub for now - will integrate with Codex)
      context.onProgress?.({
        type: "status",
        message: "Running code review...",
      });

      const output = await this.runReview(context, diffInfo);

      // Save artifacts
      await saveArtifact(
        context.run.id,
        context.phase.id,
        context.iteration,
        REVIEW_FILE,
        JSON.stringify(output.review, null, 2),
      );

      context.onProgress?.({
        type: "artifact",
        message: `Saved ${REVIEW_FILE} (score: ${output.review.overallScore}, approved: ${output.review.approved})`,
        data: { artifact: REVIEW_FILE, score: output.review.overallScore },
      });

      await saveArtifact(
        context.run.id,
        context.phase.id,
        context.iteration,
        RECOMMENDATIONS_FILE,
        JSON.stringify(output.recommendations, null, 2),
      );

      context.onProgress?.({
        type: "artifact",
        message: `Saved ${RECOMMENDATIONS_FILE} (${output.recommendations.length} recommendations)`,
        data: { artifact: RECOMMENDATIONS_FILE, count: output.recommendations.length },
      });

      return {
        success: true,
        artifacts: [REVIEW_FILE, RECOMMENDATIONS_FILE],
        output,
        metrics: {
          durationMs: Date.now() - startTime,
        },
      };
    } catch (err) {
      return {
        success: false,
        artifacts: [],
        error: err instanceof Error ? err.message : String(err),
        metrics: {
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  // ==========================================================================
  // Git Diff Analysis
  // ==========================================================================

  private async getDiffInfo(workspacePath: string): Promise<DiffInfo> {
    const baseBranch = sanitizeBranchName(this.options.baseBranch || "main");
    const diffRange = `${baseBranch}...HEAD`;

    try {
      // Get diff stats (using execFileSync to prevent shell injection)
      const statOutput = execFileSync("git", ["diff", "--stat", diffRange], {
        cwd: workspacePath,
        encoding: "utf-8",
        stdio: "pipe",
      });

      // Parse stats from last line: "X files changed, Y insertions(+), Z deletions(-)"
      const statsLine = statOutput.trim().split("\n").pop() || "";
      const filesMatch = statsLine.match(/(\d+) files? changed/);
      const insertMatch = statsLine.match(/(\d+) insertions?\(\+\)/);
      const deleteMatch = statsLine.match(/(\d+) deletions?\(-\)/);

      // Get changed files
      const filesOutput = execFileSync("git", ["diff", "--name-only", diffRange], {
        cwd: workspacePath,
        encoding: "utf-8",
        stdio: "pipe",
      });

      const changedFiles = filesOutput.trim().split("\n").filter(Boolean);

      return {
        filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : changedFiles.length,
        insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
        deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
        changedFiles,
      };
    } catch {
      // No changes or error
      return {
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        changedFiles: [],
      };
    }
  }

  // ==========================================================================
  // Code Review
  // ==========================================================================

  private async runReview(_context: EngineContext, diffInfo: DiffInfo): Promise<ReviewerOutput> {
    // TODO: Integrate with runCliAgent() for Codex
    // For now, generate a stub review based on diff stats

    const issues = this.generateStubIssues(diffInfo);
    const recommendations = this.generateStubRecommendations(diffInfo);

    // Calculate scores
    const scores = this.calculateScores(diffInfo, issues);
    const overallScore = Math.round(
      (scores.architecture +
        scores.codeQuality +
        scores.testCoverage +
        scores.security +
        scores.documentation) /
        5,
    );

    // Determine approval
    const hasCriticalIssues = issues.some((i) => i.severity === "critical");
    const approved = !hasCriticalIssues && overallScore >= (this.options.minScore || 70);

    const review: ReviewResult = {
      version: "1.0",
      reviewedAt: Date.now(),
      reviewer: "codex",
      overallScore,
      approved,
      summary: this.generateSummary(diffInfo, overallScore, approved),
      scores,
      issues,
      recommendations,
    };

    return { review, recommendations };
  }

  private generateStubIssues(diffInfo: DiffInfo): ReviewIssue[] {
    const issues: ReviewIssue[] = [];

    // Generate placeholder issues based on file types
    const hasTests = diffInfo.changedFiles.some(
      (f) => f.includes(".test.") || f.includes(".spec."),
    );
    const hasTypes = diffInfo.changedFiles.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

    if (!hasTests && diffInfo.filesChanged > 0) {
      issues.push({
        id: "issue-1",
        severity: "medium" as IssueSeverity,
        category: "testing",
        description:
          "No test files found in the changeset. Consider adding tests for new functionality.",
        file: undefined,
        line: undefined,
        suggestion: "Add unit tests for the changed code",
      });
    }

    if (diffInfo.insertions > 500) {
      issues.push({
        id: "issue-2",
        severity: "low" as IssueSeverity,
        category: "maintainability",
        description: "Large changeset detected. Consider breaking into smaller, focused commits.",
        suggestion: "Split changes into logical units",
      });
    }

    return issues;
  }

  private generateStubRecommendations(diffInfo: DiffInfo): Recommendation[] {
    const recommendations: Recommendation[] = [];

    if (diffInfo.filesChanged > 0) {
      recommendations.push({
        id: "rec-1",
        priority: "should" as RecommendationPriority,
        description: "Add comprehensive test coverage for new code paths",
        rationale: "Tests ensure reliability and catch regressions early",
      });

      recommendations.push({
        id: "rec-2",
        priority: "could" as RecommendationPriority,
        description: "Consider adding JSDoc comments to exported functions",
        rationale: "Documentation improves maintainability",
      });
    }

    return recommendations;
  }

  private calculateScores(diffInfo: DiffInfo, issues: ReviewIssue[]): ReviewResult["scores"] {
    // Base scores - adjusted by issues
    let architecture = 80;
    let codeQuality = 85;
    let testCoverage = 70;
    let security = 90;
    let documentation = 75;

    // Deduct for issues
    for (const issue of issues) {
      const deduction =
        issue.severity === "critical"
          ? 20
          : issue.severity === "high"
            ? 10
            : issue.severity === "medium"
              ? 5
              : 2;

      switch (issue.category) {
        case "architecture":
          architecture = Math.max(0, architecture - deduction);
          break;
        case "security":
          security = Math.max(0, security - deduction);
          break;
        case "testing":
          testCoverage = Math.max(0, testCoverage - deduction);
          break;
        case "documentation":
          documentation = Math.max(0, documentation - deduction);
          break;
        default:
          codeQuality = Math.max(0, codeQuality - deduction);
      }
    }

    // Boost for small, focused changes
    if (diffInfo.filesChanged <= 5) {
      architecture = Math.min(100, architecture + 5);
    }

    return { architecture, codeQuality, testCoverage, security, documentation };
  }

  private generateSummary(diffInfo: DiffInfo, score: number, approved: boolean): string {
    const status = approved ? "Approved" : "Changes requested";
    const changeDesc = `${diffInfo.filesChanged} files changed (+${diffInfo.insertions}/-${diffInfo.deletions})`;

    return `${status}. Overall score: ${score}/100. ${changeDesc}`;
  }
}

// ============================================================================
// Types
// ============================================================================

interface DiffInfo {
  filesChanged: number;
  insertions: number;
  deletions: number;
  changedFiles: string[];
}

// ============================================================================
// Factory
// ============================================================================

export function createReviewerEngine(options?: ReviewerOptions): ReviewerEngine {
  return new ReviewerEngine(options);
}
