# Multi-Agent Workflow Architecture

Technical specification for orchestrating Claude and Codex agents in collaborative development workflows.

---

## 1. Overview

### 1.1 Problem Statement

Current moltbot supports running individual coding agents (Claude Code, Codex) but lacks:
- Structured handoff between agents
- Iterative review loops
- Shared artifact management
- Workflow state persistence
- Success criteria validation

### 1.2 Goals

1. Enable Claude + Codex collaboration on complex tasks
2. Automate plan → develop → review → iterate cycles
3. Produce auditable artifacts at each phase
4. Support pause/resume of long workflows
5. Minimize token waste through structured handoffs

### 1.3 Non-Goals

- Real-time streaming between agents (async handoff is sufficient)
- Web UI for workflow management (CLI/chat interface only)
- Support for agents beyond Claude/Codex in v1

---

## 2. Security Considerations

### 2.1 Threat Model

| Threat | Risk | Mitigation |
|--------|------|------------|
| Agent executes malicious code | High | Sandbox by default, exec approvals for elevated |
| Secrets leaked in artifacts/logs | High | Automatic redaction, no .env copying |
| Agent modifies files outside workspace | Medium | Filesystem scope enforcement |
| Workflow state tampering | Low | Checksums on state files |
| Token/API key exposure | High | Never persist keys in artifacts |
| Unbounded resource consumption | Medium | Timeouts, disk quotas, process limits |

### 2.2 Sandbox Integration

Workflows run inside moltbot's existing sandbox by default:

```typescript
interface WorkflowSecurityPolicy {
  /** Run agents in sandbox (default: true) */
  sandboxed: boolean;

  /** Require exec approvals for tool calls */
  execApprovalsRequired: boolean;

  /** Allowed tools whitelist (empty = all allowed tools) */
  allowedTools?: string[];

  /** Blocked tools blacklist */
  blockedTools?: string[];

  /** Filesystem scope (agents can only access these paths) */
  filesystemScope: {
    /** Workspace directory (always allowed) */
    workspace: string;
    /** Additional allowed paths (globs) */
    additionalPaths?: string[];
  };

  /** Network policy */
  network: {
    /** Allow outbound network (default: true for API calls) */
    allowOutbound: boolean;
    /** Blocked domains */
    blockedDomains?: string[];
  };
}
```

**Default Policy:**
```json
{
  "sandboxed": true,
  "execApprovalsRequired": true,
  "blockedTools": [],
  "filesystemScope": {
    "workspace": "${workflowDir}/workspace",
    "additionalPaths": []
  },
  "network": {
    "allowOutbound": true,
    "blockedDomains": []
  }
}
```

**Tool ID Registry:**

Blocked tools must reference actual tool IDs from the system. Common security-sensitive tools:

| Tool ID | Description | Risk |
|---------|-------------|------|
| `Bash` | Shell command execution | High - can execute arbitrary commands |
| `Write` | File creation/overwrite | Medium - can overwrite critical files |
| `Edit` | File modification | Medium - can modify sensitive files |
| `WebFetch` | HTTP requests | Medium - data exfiltration risk |

> **Note:** Tool IDs are defined in the agent's tool registry. Verify against `src/tools/` or the agent's tool manifest before adding to blockedTools. Invalid tool IDs are silently ignored.

### 2.3 Secrets & Credential Handling

**Rules:**
1. **Never copy `.env` files** into workflow workspace
2. **Never persist API keys** in artifacts or logs
3. **Redact patterns** matching known secret formats before logging
4. **Inherit auth profiles** from moltbot config, don't pass tokens directly

**Redaction Patterns:**
```typescript
const REDACTION_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI keys
  /sk-ant-[a-zA-Z0-9-]{40,}/g,      // Anthropic keys
  /ghp_[a-zA-Z0-9]{36}/g,           // GitHub PAT
  /AKIA[0-9A-Z]{16}/g,              // AWS Access Key
  /-----BEGIN [A-Z]+ KEY-----/g,    // Private keys
  /Bearer [a-zA-Z0-9._-]+/gi,       // Bearer tokens
  /password["']?\s*[:=]\s*["'][^"']+["']/gi,  // Password assignments
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of REDACTION_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}
```

### 2.4 Elevated Mode

Some workflows may need elevated (non-sandboxed) execution:

```yaml
settings:
  security:
    elevated: true  # Requires explicit user approval
```

**Elevated mode requirements:**
1. User must explicitly approve via chat confirmation
2. Workflow definition must declare `elevated: true`
3. Audit log entry created with user approval timestamp
4. Cannot be enabled via API without interactive confirmation

---

## 3. Workspace Strategy

### 3.1 Workspace Modes

| Mode | Description | Default | Use Case |
|------|-------------|---------|----------|
| `in-place` | Work directly in target repo | Yes | Quick fixes, trusted workflows |
| `worktree` | Create git worktree | No | Parallel work, isolation |
| `copy` | Full repo copy | No | Maximum isolation, untrusted |

### 3.2 Mode: In-Place (Default)

```yaml
workspace:
  mode: in-place
  targetRepo: ~/projects/my-app
```

**Behavior:**
- Agents work directly in the target repository
- No branch switching (stays on current branch)
- Changes are local until explicitly committed/pushed
- **Requires clean working tree** (no uncommitted changes)

**Pre-flight checks:**
```typescript
interface InPlaceValidationOptions {
  /** Fail if untracked files exist in source dirs (default: false) */
  failOnUntracked?: boolean;
  /** Directories to check for untracked files (default: ["src/"]) */
  untrackedCheckPaths?: string[];
}

async function validateInPlaceWorkspace(
  repoPath: string,
  options: InPlaceValidationOptions = {}
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { failOnUntracked = false, untrackedCheckPaths = ["src/"] } = options;

  // 1. Must be a git repository
  if (!await isGitRepo(repoPath)) {
    errors.push("Target path is not a git repository");
  }

  // 2. Working tree must be clean (modified/staged = hard block)
  const status = await git.status(repoPath);
  if (status.modified.length > 0 || status.staged.length > 0) {
    errors.push(`Working tree has uncommitted changes: ${status.modified.length} modified, ${status.staged.length} staged`);
  }

  // 3. Untracked files check (configurable: warn or fail)
  const untracked = status.untracked.filter(f =>
    untrackedCheckPaths.some(p => f.startsWith(p))
  );
  if (untracked.length > 0) {
    const msg = `Untracked source files found: ${untracked.slice(0, 5).join(", ")}${untracked.length > 5 ? "..." : ""}`;
    if (failOnUntracked) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

**Configuration:**
```yaml
workspace:
  mode: in-place
  targetRepo: ~/projects/my-app
  validation:
    failOnUntracked: false  # Default: warn only, don't block
    untrackedCheckPaths: ["src/", "lib/"]
```

### 3.3 Mode: Worktree (Explicit Opt-In)

> **⚠️ AGENTS.md Compliance:** Per repo rules, agents must NOT create/remove/modify git worktrees without explicit user request. Worktree mode requires interactive user confirmation before proceeding. See `CLAUDE.md` → "Multi-agent safety" section.

```yaml
workspace:
  mode: worktree
  targetRepo: ~/projects/my-app
  branch: workflow/${runId}
  baseBranch: main
```

**User Confirmation Gate:**
```
Worktree mode requested. This will:
  - Create a new git worktree at ~/.clawdbot/workflows/{runId}/workspace
  - Create branch: workflow/{runId}

Per repo policy, worktree operations require explicit confirmation.
Proceed? [y/N]
```

**Behavior:**
- **Requires explicit user confirmation** (cannot be auto-approved)
- Creates a new git worktree at `~/.clawdbot/workflows/{runId}/workspace`
- Creates a new branch from `baseBranch`
- Fully isolated from main working tree
- Cleanup removes worktree on workflow completion (also requires confirmation)

**Creation:**
```bash
# Create worktree with new branch
git -C ${targetRepo} worktree add \
  -b workflow/${runId} \
  ~/.clawdbot/workflows/${runId}/workspace \
  ${baseBranch}
```

**Cleanup:**
```bash
# Remove worktree
git -C ${targetRepo} worktree remove ~/.clawdbot/workflows/${runId}/workspace

# Delete branch (if not merged)
git -C ${targetRepo} branch -D workflow/${runId}
```

### 3.4 Mode: Copy (Maximum Isolation)

```yaml
workspace:
  mode: copy
  targetRepo: ~/projects/my-app
  shallow: true  # Use shallow clone
```

**Behavior:**
- Full copy of repository to workflow directory
- No connection to original repo
- Changes must be manually transferred back
- Safest for untrusted/experimental workflows

### 3.5 Dirty Tree Handling

| Mode | Dirty Tree Behavior |
|------|---------------------|
| `in-place` | **Block workflow start** with error message |
| `worktree` | **Allow** (worktree is isolated) |
| `copy` | **Allow** (copy is isolated) |

**Error message for in-place:**
```
Cannot start workflow: working tree has uncommitted changes.

Options:
1. Commit or stash your changes: git stash
2. Use worktree mode: --workspace-mode worktree
3. Use copy mode: --workspace-mode copy

Modified files:
  - src/api.ts
  - src/utils.ts
```

### 3.6 Branch Strategy

**Worktree mode branch naming:**
```
workflow/{runId}           # Main workflow branch
workflow/{runId}/phase-{n} # Optional: branch per phase
```

**Merge strategy:**
- Workflow never merges automatically
- On completion, user receives instructions:
  ```
  Workflow complete. To merge changes:
    cd ~/projects/my-app
    git merge workflow/wf_abc123
    # or
    git cherry-pick <commits>
  ```

---

## 4. Commit & Git Policy

### 4.1 Auto-Commit Rules

When `autoCommit: true`:

1. **Use `scripts/committer`** for all commits (follows repo conventions)
2. **Commit only workflow-related files** (tracked in task artifacts)
3. **Never commit if unrelated changes exist**
4. **Never push automatically** (user must explicitly push)

### 4.2 Commit Message Format

```
workflow({phaseId}): {summary}

Phase: {phaseName}
Workflow: {runId}
Tasks: {taskIds}

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Codex <noreply@openai.com>
```

**Example:**
```
workflow(execution): implement todo CRUD endpoints

Phase: Task Execution
Workflow: wf_abc123
Tasks: task-001, task-002, task-003

Co-Authored-By: Claude <noreply@anthropic.com>
```

### 4.3 Commit Guards

```typescript
async function safeCommit(
  workspacePath: string,
  files: string[],
  message: string
): Promise<CommitResult> {
  // 1. Check for unrelated changes
  const status = await git.status(workspacePath);
  const unrelatedChanges = status.modified.filter(f => !files.includes(f));

  if (unrelatedChanges.length > 0) {
    return {
      success: false,
      error: `Refusing to commit: ${unrelatedChanges.length} unrelated files modified`,
      unrelatedFiles: unrelatedChanges
    };
  }

  // 2. Commit via scripts/committer (per repo rules - no manual git add/commit)
  // scripts/committer handles staging and commit atomically
  const result = await exec(
    `scripts/committer "${escapeMessage(message)}" ${files.map(f => `"${f}"`).join(" ")}`,
    { cwd: workspacePath }
  );

  return { success: true, sha: result.sha };
}
```

### 4.4 Push Policy

**Automatic push: NEVER**

User must explicitly push after workflow completion:
```bash
# Workflow provides instructions
cd ~/projects/my-app
git push origin workflow/wf_abc123

# Or create PR
gh pr create --head workflow/wf_abc123 --title "..."
```

---

## 5. Data Retention Policy

### 5.1 Storage Limits

| Resource | Default Limit | Configurable |
|----------|---------------|--------------|
| Max concurrent workflows | 5 | Yes |
| Max completed workflows retained | 20 | Yes |
| Max disk usage per workflow | 500 MB | Yes |
| Max total workflow storage | 5 GB | Yes |
| Log retention (completed) | 7 days | Yes |
| Log retention (failed) | 30 days | Yes |
| Artifact retention | 30 days | Yes |

### 5.2 Configuration

```json
{
  "workflows": {
    "retention": {
      "maxConcurrent": 5,
      "maxCompleted": 20,
      "maxDiskPerWorkflowMb": 500,
      "maxTotalDiskGb": 5,
      "logRetentionDays": 7,
      "failedLogRetentionDays": 30,
      "artifactRetentionDays": 30
    }
  }
}
```

### 5.3 Automatic Cleanup

```typescript
interface CleanupPolicy {
  /** Run cleanup on workflow completion */
  onComplete: boolean;

  /** Run cleanup on startup */
  onStartup: boolean;

  /** Cleanup schedule (cron) */
  schedule?: string;

  /** What to clean */
  targets: {
    /** Remove completed workflow directories */
    completedWorkflows: boolean;
    /** Remove orphaned worktrees */
    orphanedWorktrees: boolean;
    /** Compress old logs */
    compressOldLogs: boolean;
  };
}
```

**Cleanup order (when over limit):**
1. Remove oldest completed workflows first
2. Remove failed workflows older than retention period
3. Compress logs older than 3 days
4. Alert user if still over limit

### 5.4 PII & Sensitive Data

**Log redaction:**
- All logs pass through `redactSecrets()` before persistence
- File paths are normalized (no full home directory paths)
- User identifiers are hashed in metrics

**Artifact redaction:**
- Scan artifacts for secret patterns before storage
- Block storage of known sensitive file types:
  - `.env`, `.env.*`
  - `*credentials*`, `*secrets*`
  - `*.pem`, `*.key`, `*.p12`
  - `id_rsa`, `id_ed25519`

**Redaction audit log:**
```json
{
  "timestamp": "2025-01-29T12:00:00Z",
  "workflowId": "wf_abc123",
  "phase": "execution",
  "redactions": [
    { "pattern": "API_KEY", "count": 2, "files": ["logs/agent.log"] }
  ]
}
```

### 5.5 Manual Cleanup Commands

```bash
# List workflows with disk usage
moltbot workflow list --disk-usage

# Clean specific workflow
moltbot workflow clean <runId>

# Clean all completed workflows older than N days
moltbot workflow clean --older-than 7d

# Force clean to meet disk quota
moltbot workflow clean --enforce-quota
```

---

## 6. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         MOLTBOT GATEWAY                                  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    WORKFLOW ORCHESTRATOR                           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │  │
│  │  │   Planner   │  │  Executor   │  │  Reviewer   │               │  │
│  │  │   Engine    │──│   Engine    │──│   Engine    │               │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘               │  │
│  │         │                │                │                       │  │
│  │         ▼                ▼                ▼                       │  │
│  │  ┌─────────────────────────────────────────────────────────────┐ │  │
│  │  │                    ARTIFACT STORE                            │ │  │
│  │  │  plan.json │ tasks.json │ code/ │ tests/ │ reviews/ │ logs/ │ │  │
│  │  └─────────────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                    │                                     │
│         ┌──────────────────────────┼──────────────────────────┐         │
│         ▼                          ▼                          ▼         │
│  ┌─────────────┐           ┌─────────────┐           ┌─────────────┐   │
│  │   CLAUDE    │           │   CODEX     │           │   PROCESS   │   │
│  │   RUNNER    │           │   RUNNER    │           │   MANAGER   │   │
│  │  (API/CLI)  │           │   (CLI)     │           │  (PTY/bg)   │   │
│  └─────────────┘           └─────────────┘           └─────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1 Workflow Orchestrator

**Location:** `src/workflows/orchestrator.ts`

**Responsibilities:**
- Parse workflow definitions
- Manage phase transitions
- Track workflow state
- Coordinate agent handoffs
- Enforce timeouts and retries

**Interface:**
```typescript
interface WorkflowOrchestrator {
  // Lifecycle
  start(definition: WorkflowDefinition, input: WorkflowInput): Promise<WorkflowRun>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<WorkflowRun>;
  cancel(runId: string): Promise<void>;

  // Monitoring
  getStatus(runId: string): Promise<WorkflowStatus>;
  getArtifacts(runId: string): Promise<ArtifactManifest>;
  getLogs(runId: string, options?: LogOptions): Promise<LogEntry[]>;

  // Events
  on(event: WorkflowEvent, handler: EventHandler): void;
}
```

### 3.2 Planner Engine

**Location:** `src/workflows/engines/planner.ts`

**Responsibilities:**
- Generate project plan from high-level task
- Decompose into atomic tasks
- Estimate complexity and dependencies
- Produce `plan.json` and `tasks.json`

**Agents Used:** Claude (primary), Codex (review)

**Output Artifacts:**
```
artifacts/
├── plan.json           # High-level project plan
├── tasks.json          # Atomic task list with dependencies
└── planning-log.md     # Decision rationale
```

### 3.3 Executor Engine

**Location:** `src/workflows/engines/executor.ts`

**Responsibilities:**
- Execute tasks from `tasks.json` in dependency order
- Run tests after each task
- Update task status
- Produce code and documentation

**Agents Used:** Claude Code (primary)

**Output Artifacts:**
```
artifacts/
├── tasks.json          # Updated with status
├── code/               # Source code changes
├── tests/              # Test files
├── docs/               # Documentation
└── execution-log.md    # Per-task logs
```

### 3.4 Reviewer Engine

**Location:** `src/workflows/engines/reviewer.ts`

**Responsibilities:**
- Architectural review
- Code quality review
- Test coverage analysis
- Security review
- Generate recommendations

**Agents Used:** Codex (primary)

**Output Artifacts:**
```
artifacts/
├── review.json         # Structured review results
├── recommendations.md  # Human-readable recommendations
└── review-log.md       # Review process log
```

### 3.5 Artifact Store

**Location:** `src/workflows/artifacts/`

**Responsibilities:**
- Persist workflow artifacts to filesystem
- Version artifacts per phase
- Enable artifact sharing between agents
- Support artifact retrieval for handoffs

**Directory Structure:**
```
~/.clawdbot/workflows/
└── {runId}/
    ├── workflow.json       # Workflow definition + state
    ├── input.json          # Original input
    ├── phases/
    │   ├── 01-planning/
    │   │   ├── artifacts/
    │   │   ├── logs/
    │   │   └── state.json
    │   ├── 02-execution/
    │   │   ├── artifacts/
    │   │   ├── logs/
    │   │   └── state.json
    │   └── 03-review/
    │       ├── artifacts/
    │       ├── logs/
    │       └── state.json
    ├── workspace/          # Git worktree for code
    └── output/             # Final deliverables
```

---

## 4. Data Structures

### 4.1 Workflow Definition

```typescript
interface WorkflowDefinition {
  /** Unique workflow type identifier */
  type: "dev-cycle" | "review-only" | "custom";

  /** Workflow metadata */
  name: string;
  description?: string;
  version: string;

  /** Phase configuration */
  phases: PhaseDefinition[];

  /** Global settings */
  settings: {
    /** Max total workflow duration (ms) */
    maxDurationMs: number;
    /** Max iterations for review loop */
    maxReviewIterations: number;
    /** Auto-commit after each phase */
    autoCommit: boolean;
    /** Notify user between phases */
    notifyOnPhaseComplete: boolean;
  };

  /** Success criteria */
  successCriteria: SuccessCriteria;
}

interface PhaseDefinition {
  id: string;
  name: string;
  engine: "planner" | "executor" | "reviewer";

  /** Agent configuration for this phase */
  agent: {
    type: "claude" | "codex";
    model?: string;
    flags?: string[];
  };

  /** Input artifacts required from previous phases */
  inputArtifacts: string[];

  /** Output artifacts this phase must produce */
  outputArtifacts: string[];

  /** Phase-specific settings */
  settings: {
    timeoutMs: number;
    retries: number;
    /** Condition to proceed to next phase */
    proceedCondition?: string; // JSONPath expression
  };

  /** Optional: next phase override based on output */
  transitions?: {
    condition: string;
    targetPhase: string;
  }[];
}

interface SuccessCriteria {
  /** All tests must pass */
  testsPass: boolean;
  /** Review score threshold (0-100) */
  minReviewScore?: number;
  /** Required artifacts */
  requiredArtifacts: string[];
  /** Custom validation function */
  customValidator?: string;
}
```

### 4.2 Workflow State

```typescript
interface WorkflowRun {
  id: string;
  definitionId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

  /** Original input */
  input: WorkflowInput;

  /** Current phase */
  currentPhase: string | null;

  /** Phase execution history */
  phaseHistory: PhaseExecution[];

  /** Iteration count (for review loops) */
  iterationCount: number;

  /** Timestamps */
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;

  /** Error if failed */
  error?: {
    phase: string;
    message: string;
    stack?: string;
  };

  /** Final output location */
  outputPath?: string;
}

interface PhaseExecution {
  phaseId: string;
  iteration: number;
  status: "pending" | "running" | "completed" | "failed" | "skipped";

  /** Agent process info */
  agentProcess?: {
    sessionId: string;
    pid: number;
    startedAt: number;
    completedAt?: number;
  };

  /** Artifacts produced */
  artifacts: string[];

  /** Metrics */
  metrics: {
    durationMs: number;
    tokensUsed?: number;
    cost?: number;
  };

  /** Logs */
  logPath: string;
}
```

### 4.3 Task Structure

```typescript
interface TaskList {
  version: string;
  projectName: string;
  createdAt: number;
  updatedAt: number;

  tasks: Task[];

  /** Summary stats */
  stats: {
    total: number;
    completed: number;
    failed: number;
    pending: number;
  };
}

interface Task {
  id: string;
  title: string;
  description: string;

  /** Task type */
  type: "feature" | "bugfix" | "refactor" | "test" | "docs";

  /** Priority (1 = highest) */
  priority: number;

  /** Estimated complexity (1-5) */
  complexity: number;

  /** Dependencies (task IDs) */
  dependsOn: string[];

  /** Status */
  status: "pending" | "in_progress" | "completed" | "failed" | "blocked";

  /** Assigned agent */
  assignedAgent?: "claude" | "codex";

  /** Acceptance criteria */
  acceptanceCriteria: string[];

  /** Files to modify */
  targetFiles?: string[];

  /** Execution result */
  result?: {
    completedAt: number;
    filesModified: string[];
    testsAdded: string[];
    testsPassed: boolean;
    notes?: string;
  };
}
```

### 4.4 Review Structure

```typescript
interface ReviewResult {
  version: string;
  reviewedAt: number;
  reviewer: "codex";

  /** Overall score (0-100) */
  overallScore: number;

  /** Category scores */
  scores: {
    architecture: number;
    codeQuality: number;
    testCoverage: number;
    security: number;
    documentation: number;
  };

  /** Issues found */
  issues: ReviewIssue[];

  /** Recommendations */
  recommendations: Recommendation[];

  /** Approval status */
  approved: boolean;

  /** Summary */
  summary: string;
}

interface ReviewIssue {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  file?: string;
  line?: number;
  description: string;
  suggestion?: string;
}

interface Recommendation {
  id: string;
  priority: "must" | "should" | "could";
  description: string;
  rationale: string;
  /** Task to create if accepted */
  suggestedTask?: Partial<Task>;
}
```

---

## 5. Workflow Phases

### 5.1 Standard Dev Cycle Workflow

```yaml
type: dev-cycle
name: "Standard Development Cycle"
version: "1.0.0"

phases:
  - id: planning
    name: "Project Planning"
    engine: planner
    agent:
      type: claude
      model: claude-sonnet-4
    inputArtifacts: []
    outputArtifacts:
      - plan.json
      - tasks.json
    settings:
      timeoutMs: 300000  # 5 min
      retries: 1

  - id: plan-review
    name: "Plan Review"
    engine: reviewer
    agent:
      type: codex
      flags: ["--full-auto"]
    inputArtifacts:
      - plan.json
      - tasks.json
    outputArtifacts:
      - plan-review.json
    settings:
      timeoutMs: 180000  # 3 min
      retries: 1
    transitions:
      - condition: "$.approved == false"
        targetPhase: planning

  - id: execution
    name: "Task Execution"
    engine: executor
    agent:
      type: claude
      model: claude-sonnet-4
    inputArtifacts:
      - tasks.json
    outputArtifacts:
      - tasks.json  # updated
      - execution-report.md
    settings:
      timeoutMs: 1800000  # 30 min
      retries: 2

  - id: code-review
    name: "Code Review"
    engine: reviewer
    agent:
      type: codex
      flags: ["review", "--base", "main"]
    inputArtifacts:
      - tasks.json
      - execution-report.md
    outputArtifacts:
      - review.json
      - recommendations.md
    settings:
      timeoutMs: 300000  # 5 min
      retries: 1
    transitions:
      - condition: "$.issues[?(@.severity=='critical')].length > 0"
        targetPhase: execution

  - id: finalize
    name: "Finalize"
    engine: executor
    agent:
      type: claude
    inputArtifacts:
      - review.json
    outputArtifacts:
      - final-report.md
      - changelog.md
    settings:
      timeoutMs: 120000  # 2 min
      retries: 1

settings:
  maxDurationMs: 3600000  # 1 hour
  maxReviewIterations: 3
  autoCommit: true
  notifyOnPhaseComplete: true

successCriteria:
  testsPass: true
  minReviewScore: 70
  requiredArtifacts:
    - tasks.json
    - review.json
    - final-report.md
```

### 5.2 Phase Transition Diagram

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    ▼                                          │
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
│ PLANNING │──▶│  PLAN    │──▶│EXECUTION │──▶│  CODE    │───┘
│ (Claude) │   │  REVIEW  │   │ (Claude) │   │  REVIEW  │
└──────────┘   │ (Codex)  │   └──────────┘   │ (Codex)  │
     ▲         └──────────┘        ▲         └──────────┘
     │              │              │              │
     │              │              │              │
     └──────────────┘              └──────────────┘
      (if not approved)            (if critical issues)
                                          │
                                          │ (if approved)
                                          ▼
                                   ┌──────────┐
                                   │ FINALIZE │
                                   │ (Claude) │
                                   └──────────┘
                                          │
                                          ▼
                                      COMPLETE
```

---

## 6. Agent Communication Protocol

### 6.1 Handoff Format

Agents communicate via structured files in the artifact store:

```
handoff/
├── context.json      # Shared context for receiving agent
├── instructions.md   # Natural language instructions
├── artifacts/        # Referenced artifacts
└── expectations.json # Expected outputs schema
```

**context.json:**
```json
{
  "workflowId": "wf_abc123",
  "phase": "code-review",
  "iteration": 2,
  "previousPhase": "execution",
  "projectContext": {
    "name": "todo-api",
    "language": "typescript",
    "framework": "express"
  },
  "relevantFiles": [
    "src/routes/todos.ts",
    "src/models/todo.ts",
    "tests/todos.test.ts"
  ],
  "changesInScope": {
    "added": ["src/routes/todos.ts"],
    "modified": ["src/models/todo.ts"],
    "deleted": []
  }
}
```

**instructions.md:**
```markdown
# Code Review Instructions

## Your Role
You are the code reviewer (Codex). Review the changes made by the developer (Claude).

## Changes to Review
- Added: `src/routes/todos.ts` - New REST endpoints
- Modified: `src/models/todo.ts` - Added validation

## Review Checklist
1. Architecture alignment with plan.json
2. Code quality and best practices
3. Test coverage adequacy
4. Security considerations
5. Documentation completeness

## Output Requirements
Produce `review.json` following the ReviewResult schema.
If critical issues found, set `approved: false`.
```

### 6.2 Agent Invocation

**Claude Code:**
```bash
bash pty:true \
  workdir:$WORKSPACE \
  command:"claude --context handoff/context.json \
    --instructions handoff/instructions.md \
    --output artifacts/"
```

**Codex:**
```bash
bash pty:true \
  workdir:$WORKSPACE \
  command:"codex exec --full-auto \
    'Read handoff/instructions.md and handoff/context.json. \
     Review the code changes. \
     Output review.json to artifacts/'"
```

### 6.3 Output Validation

After each agent completes:

```typescript
async function validatePhaseOutput(
  phase: PhaseDefinition,
  artifactPath: string
): Promise<ValidationResult> {
  const results: ValidationResult = {
    valid: true,
    errors: [],
    warnings: []
  };

  // 1. Check required artifacts exist
  for (const artifact of phase.outputArtifacts) {
    const path = join(artifactPath, artifact);
    if (!existsSync(path)) {
      results.valid = false;
      results.errors.push(`Missing required artifact: ${artifact}`);
    }
  }

  // 2. Validate JSON schemas
  if (phase.outputArtifacts.includes("tasks.json")) {
    const tasks = await readJson(join(artifactPath, "tasks.json"));
    const validation = validateTaskList(tasks);
    if (!validation.valid) {
      results.valid = false;
      results.errors.push(...validation.errors);
    }
  }

  // 3. Run custom validators
  if (phase.settings.proceedCondition) {
    const conditionMet = evaluateCondition(
      phase.settings.proceedCondition,
      await collectArtifacts(artifactPath)
    );
    if (!conditionMet) {
      results.valid = false;
      results.errors.push(`Proceed condition not met: ${phase.settings.proceedCondition}`);
    }
  }

  return results;
}
```

---

## 7. Error Handling

### 7.1 Error Categories

| Category | Handling | Retry |
|----------|----------|-------|
| Agent timeout | Kill process, retry phase | Yes (configurable) |
| Agent crash | Log output, retry phase | Yes (configurable) |
| Validation failure | Log errors, retry phase | Yes (configurable) |
| Missing artifact | Block transition, notify user | No |
| Critical review issue | Loop back to execution | Yes (max iterations) |
| Max iterations exceeded | Pause workflow, notify user | No |
| Workflow timeout | Cancel workflow, save state | No |

### 7.2 Recovery Strategies

```typescript
interface RecoveryStrategy {
  /** Retry the current phase */
  retry: {
    maxAttempts: number;
    backoffMs: number;
  };

  /** Fall back to different agent */
  fallback?: {
    agent: "claude" | "codex";
    model?: string;
  };

  /** Pause and wait for user */
  pauseOnFailure: boolean;

  /** Save partial progress */
  savePartialArtifacts: boolean;
}
```

### 7.3 State Persistence

Workflow state is persisted after every significant event:

```typescript
const persistenceEvents = [
  "phase:started",
  "phase:completed",
  "phase:failed",
  "artifact:created",
  "iteration:started",
  "workflow:paused",
  "workflow:resumed"
];
```

---

## 8. Configuration

### 8.1 Moltbot Config Integration

```json
{
  "workflows": {
    "enabled": true,
    "storagePath": "~/.clawdbot/workflows",

    "defaults": {
      "maxDurationMs": 3600000,
      "maxReviewIterations": 3,
      "autoCommit": false,
      "notifyOnPhaseComplete": true
    },

    "agents": {
      "claude": {
        "model": "claude-sonnet-4",
        "authProfileId": "main"
      },
      "codex": {
        "model": "gpt-5.2-codex",
        "flags": ["--full-auto"]
      }
    },

    "definitions": {
      "dev-cycle": "~/.clawdbot/workflows/definitions/dev-cycle.yaml",
      "review-only": "~/.clawdbot/workflows/definitions/review-only.yaml"
    }
  }
}
```

### 8.2 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MOLTBOT_WORKFLOW_STORAGE` | Workflow storage path | `~/.clawdbot/workflows` |
| `MOLTBOT_WORKFLOW_TIMEOUT` | Max workflow duration (ms) | `3600000` |
| `MOLTBOT_WORKFLOW_DEBUG` | Enable debug logging | `false` |

---

## 9. CLI Interface

### 9.1 Commands

```bash
# Start a new workflow
moltbot workflow start dev-cycle \
  --input "Build a REST API for todo management" \
  --repo ~/projects/todo-api

# List running workflows
moltbot workflow list

# Get workflow status
moltbot workflow status <runId>

# Pause/resume workflow
moltbot workflow pause <runId>
moltbot workflow resume <runId>

# Cancel workflow
moltbot workflow cancel <runId>

# View logs
moltbot workflow logs <runId> [--phase <phaseId>] [--follow]

# Get artifacts
moltbot workflow artifacts <runId> [--phase <phaseId>]
```

### 9.2 Chat Interface

```
User: @bot start dev workflow for todo API
Bot: Starting dev-cycle workflow...

📋 Workflow: wf_abc123
📁 Workspace: /tmp/wf_abc123/workspace
⏱️ Estimated: 30-60 minutes

Phase 1/5: Planning (Claude)
Status: Running...

---

Bot: ✅ Planning complete
📄 Artifacts: plan.json, tasks.json
📊 Tasks: 8 total (3 features, 2 tests, 3 docs)

Proceeding to Plan Review (Codex)...

---

Bot: ⚠️ Plan Review found issues:
- Missing error handling strategy
- No rate limiting considered

Returning to Planning phase (iteration 2)...

---
[... continues ...]
---

Bot: ✅ Workflow complete!

📊 Summary:
- Duration: 42 minutes
- Iterations: 2 (1 plan revision)
- Tasks completed: 8/8
- Tests: 24 passing
- Review score: 85/100

📁 Output: ~/.clawdbot/workflows/wf_abc123/output/
📝 Report: final-report.md
```

---

## 10. File Structure

```
src/workflows/
├── index.ts                    # Public API exports
├── orchestrator.ts             # Main orchestrator
├── types.ts                    # TypeScript interfaces
├── constants.ts                # Default values
│
├── engines/
│   ├── planner.ts              # Planning engine
│   ├── executor.ts             # Execution engine
│   └── reviewer.ts             # Review engine
│
├── artifacts/
│   ├── store.ts                # Artifact storage
│   ├── validator.ts            # Schema validation
│   └── schemas/
│       ├── task-list.json
│       ├── review-result.json
│       └── plan.json
│
├── agents/
│   ├── claude-runner.ts        # Claude Code integration
│   ├── codex-runner.ts         # Codex integration
│   └── handoff.ts              # Agent handoff protocol
│
├── state/
│   ├── persistence.ts          # State persistence
│   ├── recovery.ts             # Error recovery
│   └── transitions.ts          # Phase transitions
│
└── cli/
    ├── workflow-commands.ts    # CLI commands
    └── chat-interface.ts       # Chat command handlers

skills/multi-agent-workflow/
├── SKILL.md                    # Skill documentation
├── definitions/
│   ├── dev-cycle.yaml          # Standard dev cycle
│   ├── review-only.yaml        # Review-only workflow
│   └── custom-template.yaml    # Template for custom
└── scripts/
    └── validate-definition.ts  # Definition validator
```

---

## 11. Acceptance Criteria

### 11.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Start workflow from chat command | Must |
| F2 | Execute planning phase with Claude | Must |
| F3 | Execute review phase with Codex | Must |
| F4 | Automatic phase transitions | Must |
| F5 | Review loop iteration | Must |
| F6 | Artifact persistence | Must |
| F7 | Workflow pause/resume | Should |
| F8 | Progress notifications | Should |
| F9 | Custom workflow definitions | Could |
| F10 | Parallel task execution | Could |

### 11.2 Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NF1 | Phase transition overhead | < 500ms (orchestration only; excludes agent startup/execution) |
| NF2 | State persistence reliability | 99.9% |
| NF3 | Workflow recovery after crash | Full state recovery |
| NF4 | Max concurrent workflows | 5 |
| NF5 | Artifact storage efficiency | Dedup shared files |

### 11.3 Test Cases

```typescript
describe("Multi-Agent Workflow", () => {
  describe("Orchestrator", () => {
    it("should start workflow and create run record");
    it("should transition through phases in order");
    it("should loop back on review failure");
    it("should respect max iterations");
    it("should persist state after each phase");
    it("should recover from interrupted state");
  });

  describe("Planner Engine", () => {
    it("should generate valid plan.json");
    it("should decompose into atomic tasks");
    it("should set task dependencies correctly");
  });

  describe("Executor Engine", () => {
    it("should execute tasks in dependency order");
    it("should run tests after each task");
    it("should update task status");
  });

  describe("Reviewer Engine", () => {
    it("should produce valid review.json");
    it("should identify critical issues");
    it("should generate actionable recommendations");
  });

  describe("Agent Handoff", () => {
    it("should create valid handoff context");
    it("should pass artifacts between agents");
    it("should validate agent output");
  });
});
```

---

## 12. Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)
- [ ] Workflow orchestrator skeleton
- [ ] State persistence
- [ ] Artifact store
- [ ] Basic CLI commands

### Phase 2: Agent Integration (Week 2-3)
- [ ] Claude runner (PTY + background)
- [ ] Codex runner (PTY + background)
- [ ] Handoff protocol
- [ ] Output validation

### Phase 3: Engines (Week 3-4)
- [ ] Planner engine
- [ ] Executor engine
- [ ] Reviewer engine
- [ ] Phase transitions

### Phase 4: Polish (Week 4-5)
- [ ] Chat interface
- [ ] Progress notifications
- [ ] Error recovery
- [ ] Documentation

### Phase 5: Testing & Iteration (Week 5-6)
- [ ] Integration tests
- [ ] Real-world workflow testing
- [ ] Performance optimization
- [ ] Bug fixes

---

## 13. Open Questions

1. **Token budget management**: How to track/limit token usage across agents?
2. **Workspace isolation**: One workspace per workflow or shared?
3. **Git strategy**: Commit per task, per phase, or only on success?
4. **Conflict resolution**: What if Codex recommendations contradict Claude's approach?
5. **Human-in-the-loop**: When should workflow pause for user input?

---

## 14. References

- [coding-agent skill](/skills/coding-agent/SKILL.md)
- [tmux skill](/skills/tmux/SKILL.md)
- [llm-task plugin](/extensions/llm-task/README.md)
- [process tool documentation](/docs/tools/exec.md)
