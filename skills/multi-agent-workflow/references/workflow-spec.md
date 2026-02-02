# Workflow Specification

## Architecture

The multi-agent workflow uses a two-LLM architecture:

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Planner   │───▶│  Executor   │───▶│  Reviewer   │
│   (Claude)  │    │  (Claude)   │    │   (Codex)   │
└─────────────┘    └─────────────┘    └─────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
   plan.md           tasks.json         review.json
   tasks.json     execution-report    recommendations
```

## Phases

### 1. Planning Phase
- **Engine:** `planner`
- **Agent:** Claude (claude-sonnet-4)
- **Input:** Task description, project context
- **Output:** plan.md, tasks.json

The planner analyzes the codebase and creates:
- High-level implementation approach
- Structured task breakdown with dependencies
- Acceptance criteria for each task

### 2. Plan Review Phase
- **Engine:** `reviewer`
- **Agent:** Codex (gpt-5.1-codex)
- **Input:** plan.md, tasks.json
- **Output:** review.json

Validates plan structure and completeness. If rejected, loops back to planning.

### 3. Execution Phase
- **Engine:** `executor`
- **Agent:** Claude (claude-sonnet-4)
- **Input:** tasks.json
- **Output:** Updated tasks.json, execution-report.json

Executes tasks in dependency order:
1. Load pending tasks
2. For each task: build prompt → run agent → update status
3. Generate execution report

### 4. Code Review Phase
- **Engine:** `reviewer`
- **Agent:** Codex (gpt-5.1-codex)
- **Input:** Git diff, execution-report.json
- **Output:** review.json, recommendations.json

Reviews code changes and scores:
- Architecture (0-100)
- Code Quality (0-100)
- Test Coverage (0-100)
- Security (0-100)
- Documentation (0-100)

### 5. Finalize Phase
- Generates final summary
- Commits changes (if auto-commit enabled)
- Creates PR (if configured)

## Transitions

```
planning ──▶ plan-review ──▶ execution ──▶ code-review ──▶ finalize
    ▲              │              ▲              │
    └──────────────┘              └──────────────┘
       (if rejected)                (if rejected)
```

## Configuration

```typescript
interface WorkflowSettings {
  maxDurationMs: number;      // Total timeout (default: 30min)
  maxReviewIterations: number; // Loop limit (default: 3)
  autoCommit: boolean;         // Auto-commit after phases
  notifyOnPhaseComplete: boolean;
}
```

## Session Management

Session files: `~/.clawdbot/workflows/{runId}/phases/{iteration}-{phaseId}/session.jsonl`

Session ID format: `wf-{runId}-{phaseId}-{iteration}`
