/**
 * Workflow Artifact Store
 *
 * Manages artifact storage, retrieval, and lifecycle for workflow phases.
 * Artifacts are versioned per phase and can be shared between agents.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile, copyFile, rm, readdir } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";
import {
  ARTIFACTS_DIR,
  LOGS_DIR,
  BLOCKED_FILE_PATTERNS,
  REDACTION_PATTERNS,
} from "../constants.js";
import { getWorkflowDir, getPhaseDir } from "../state/persistence.js";

// ============================================================================
// Artifact Paths
// ============================================================================

export function getArtifactsDir(runId: string, phaseId: string, iteration: number): string {
  return join(getPhaseDir(runId, phaseId, iteration), ARTIFACTS_DIR);
}

export function getLogsDir(runId: string, phaseId: string, iteration: number): string {
  return join(getPhaseDir(runId, phaseId, iteration), LOGS_DIR);
}

export function getOutputDir(runId: string): string {
  return join(getWorkflowDir(runId), "output");
}

// ============================================================================
// Artifact Operations
// ============================================================================

export interface ArtifactMetadata {
  name: string;
  path: string;
  size: number;
  createdAt: number;
  phase: string;
  iteration: number;
  contentType: string;
}

export async function saveArtifact(
  runId: string,
  phaseId: string,
  iteration: number,
  name: string,
  content: string | Buffer,
): Promise<ArtifactMetadata> {
  // Check if file is blocked
  if (isBlockedFile(name)) {
    throw new Error(`Artifact "${name}" matches blocked file pattern`);
  }

  const artifactsDir = getArtifactsDir(runId, phaseId, iteration);
  mkdirSync(artifactsDir, { recursive: true });

  const artifactPath = join(artifactsDir, name);
  mkdirSync(dirname(artifactPath), { recursive: true });

  // Redact secrets from text content
  let finalContent = content;
  if (typeof content === "string") {
    finalContent = redactSecrets(content);
  }

  await writeFile(artifactPath, finalContent);

  const stats = statSync(artifactPath);

  return {
    name,
    path: artifactPath,
    size: stats.size,
    createdAt: Date.now(),
    phase: phaseId,
    iteration,
    contentType: getContentType(name),
  };
}

export async function loadArtifact(
  runId: string,
  phaseId: string,
  iteration: number,
  name: string,
): Promise<string | null> {
  const artifactPath = join(getArtifactsDir(runId, phaseId, iteration), name);

  if (!existsSync(artifactPath)) {
    return null;
  }

  return readFile(artifactPath, "utf-8");
}

export async function loadArtifactJson<T>(
  runId: string,
  phaseId: string,
  iteration: number,
  name: string,
): Promise<T | null> {
  const content = await loadArtifact(runId, phaseId, iteration, name);
  if (!content) return null;

  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function copyArtifactToOutput(
  runId: string,
  phaseId: string,
  iteration: number,
  name: string,
): Promise<string> {
  const sourcePath = join(getArtifactsDir(runId, phaseId, iteration), name);
  const outputDir = getOutputDir(runId);
  const destPath = join(outputDir, name);

  mkdirSync(dirname(destPath), { recursive: true });
  await copyFile(sourcePath, destPath);

  return destPath;
}

// ============================================================================
// Artifact Discovery
// ============================================================================

export async function listArtifacts(
  runId: string,
  phaseId: string,
  iteration: number,
): Promise<ArtifactMetadata[]> {
  const artifactsDir = getArtifactsDir(runId, phaseId, iteration);

  if (!existsSync(artifactsDir)) {
    return [];
  }

  const artifacts: ArtifactMetadata[] = [];

  async function walkDir(dir: string, prefix = ""): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walkDir(fullPath, relativePath);
      } else {
        const stats = statSync(fullPath);
        artifacts.push({
          name: relativePath,
          path: fullPath,
          size: stats.size,
          createdAt: stats.mtimeMs,
          phase: phaseId,
          iteration,
          contentType: getContentType(relativePath),
        });
      }
    }
  }

  await walkDir(artifactsDir);
  return artifacts;
}

export async function listAllArtifacts(runId: string): Promise<ArtifactMetadata[]> {
  const workflowDir = getWorkflowDir(runId);
  const phasesDir = join(workflowDir, "phases");

  if (!existsSync(phasesDir)) {
    return [];
  }

  const allArtifacts: ArtifactMetadata[] = [];
  const phaseDirs = readdirSync(phasesDir, { withFileTypes: true });

  for (const phaseDir of phaseDirs) {
    if (!phaseDir.isDirectory()) continue;

    // Parse phase dir name: "01-planning" -> { iteration: 1, phaseId: "planning" }
    const match = phaseDir.name.match(/^(\d+)-(.+)$/);
    if (!match) continue;

    const iteration = parseInt(match[1], 10);
    const phaseId = match[2];

    const artifacts = await listArtifacts(runId, phaseId, iteration);
    allArtifacts.push(...artifacts);
  }

  return allArtifacts;
}

export async function artifactExists(
  runId: string,
  phaseId: string,
  iteration: number,
  name: string,
): Promise<boolean> {
  const artifactPath = join(getArtifactsDir(runId, phaseId, iteration), name);
  return existsSync(artifactPath);
}

// ============================================================================
// Manifest
// ============================================================================

export interface ArtifactManifest {
  workflowId: string;
  generatedAt: number;
  artifacts: ArtifactMetadata[];
  totalSize: number;
}

export async function generateManifest(runId: string): Promise<ArtifactManifest> {
  const artifacts = await listAllArtifacts(runId);
  const totalSize = artifacts.reduce((sum, a) => sum + a.size, 0);

  return {
    workflowId: runId,
    generatedAt: Date.now(),
    artifacts,
    totalSize,
  };
}

export async function saveManifest(runId: string): Promise<void> {
  const manifest = await generateManifest(runId);
  const manifestPath = join(getWorkflowDir(runId), "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

// ============================================================================
// Security: Blocked Files
// ============================================================================

function isBlockedFile(name: string): boolean {
  const baseName = basename(name);

  for (const pattern of BLOCKED_FILE_PATTERNS) {
    if (pattern.includes("*")) {
      // Simple glob matching
      const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      if (regex.test(baseName)) return true;
    } else {
      if (baseName === pattern) return true;
      if (baseName.startsWith(pattern)) return true;
    }
  }

  return false;
}

// ============================================================================
// Security: Secret Redaction
// ============================================================================

export function redactSecrets(text: string): string {
  let result = text;

  for (const pattern of REDACTION_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }

  return result;
}

// ============================================================================
// Content Type Detection
// ============================================================================

function getContentType(name: string): string {
  const ext = extname(name).toLowerCase();

  const contentTypes: Record<string, string> = {
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".ts": "text/typescript",
    ".js": "text/javascript",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".html": "text/html",
    ".css": "text/css",
    ".log": "text/plain",
  };

  return contentTypes[ext] || "application/octet-stream";
}

// ============================================================================
// Cleanup
// ============================================================================

export async function deleteArtifacts(
  runId: string,
  phaseId: string,
  iteration: number,
): Promise<void> {
  const artifactsDir = getArtifactsDir(runId, phaseId, iteration);

  if (existsSync(artifactsDir)) {
    await rm(artifactsDir, { recursive: true, force: true });
  }
}
