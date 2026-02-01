---
name: multi-agent-workflow
description: Orchestrate two LLMs (planning/dev/review) with handoffs, artifacts, approvals, and observability.
long_description: "Multi-phase development workflow with Planner → Executor → Reviewer LLM architecture. Supports automatic task breakdown, structured artifact generation (plan.md, tasks.json, review.json), policy-based approvals, and full observability. Includes anti-loop safety limits and both stub mode (for testing) and live mode (real LLM execution)."
aliases: workflow, wf, dev-cycle, plan-review, multi-agent
---

# Multi-Agent Workflow Skill

Orchestrate complex development tasks using a two-LLM architecture with automated handoffs, artifact generation, policy-based approvals, and full observability.

## Overview

This skill enables multi-phase workflows where:
1. **Planner LLM** creates implementation plans and task breakdowns
2. **Executor LLM** implements tasks based on the plan
3. **Reviewer LLM** validates changes and provides feedback

Each phase produces structured artifacts and supports automatic iteration based on review feedback.

## Usage

### Explicit Call
```
Use skill multi-agent-workflow: plan + implement + review feature X
```

### Short Form
```
multi-agent-workflow: implement X with review
```

### Aliases

You can use shorter aliases:
```
/workflow build a REST API
/wf add user authentication
/dev-cycle refactor database layer
```

### Examples

**New feature:**
```
multi-agent-workflow: add user authentication with JWT tokens
```

**Bug fix with review:**
```
multi-agent-workflow: fix memory leak in cache module and review
```

**Refactoring:**
```
multi-agent-workflow: refactor database layer to use connection pooling
```

## Natural Language Invocation (Intent Routing)

When enabled, workflows can be triggered from natural language without explicit commands.

### Enable Intent Routing

Add to `~/.openclaw/openclaw.json`:
```json
{
  "workflows": {
    "routing": {
      "enabled": true,
      "minConfidence": 0.7,
      "autoStart": false
    }
  }
}
```

### Supported Patterns

**Dev-cycle patterns** (planning + implementation + review):
- "plan and implement user authentication"
- "implement file upload and review"
- "build a login form with review"
- "start a dev-cycle for refactoring the API"

**Review-only patterns**:
- "review the code changes"
- "review this PR"
- "do a code review"

**Plan-only patterns**:
- "just plan the refactoring"
- "create a plan for the new feature"
- "generate an implementation plan"

### Behavior

- `autoStart: false` (default): Shows suggested command and asks for confirmation
- `autoStart: true`: Automatically starts the workflow

### Example Interaction

```
User: plan and implement user authentication with JWT

Bot: 🔄 Detected workflow intent: **dev-cycle**

Suggested command:
moltbot workflow start --type dev-cycle --task "user authentication with JWT" --repo .

Reply with `/workflow start` to run, or continue with your message.
```

## Modes

### Stub Mode (Default)
- No API keys required
- Tests workflow mechanics without real LLM calls
- Fast execution for validation
- Safe for CI/CD pipelines

```bash
moltbot workflow start --type dev-cycle --task "Add feature X" --repo .
```

### Live Mode
- Requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- Real LLM execution with policy enforcement
- Approval prompts for sensitive operations
- Full artifact generation

```bash
moltbot workflow start --type dev-cycle --task "Add feature X" --repo . --live
```

## Safety Limits (Anti-Loop)

Workflows enforce these limits to prevent runaway token consumption:

| Limit | Default | Description |
|-------|---------|-------------|
| `maxDurationMs` | 3600000 (1h) | Maximum total workflow duration |
| `maxReviewIterations` | 3 | Maximum plan/review cycles |
| `maxTasks` | 50 | Maximum tasks in tasks.json |
| `maxAgentRuns` | 30 | Maximum agent invocations (live mode) |

Override in `~/.openclaw/openclaw.json`:
```json
{
  "workflows": {
    "defaults": {
      "maxDurationMs": 7200000,
      "maxTasks": 100,
      "maxAgentRuns": 50
    }
  }
}
```

## Workflow Types

### dev-cycle (Default)
Full development cycle: planning → execution → review → finalize

Phases:
1. `planning` - Create plan.md and tasks.json
2. `plan-review` - Validate plan structure
3. `execution` - Implement tasks
4. `code-review` - Review changes
5. `finalize` - Generate final report

### review-only
Code review only, no implementation.

## Commands

```bash
# Start a workflow
moltbot workflow start --type dev-cycle --task "description" --repo /path

# Check status
moltbot workflow status <run-id>
moltbot workflow status <run-id> --verbose

# View logs
moltbot workflow logs <run-id>

# Resume failed/paused workflow
moltbot workflow resume <run-id>

# Cancel workflow
moltbot workflow cancel <run-id>

# List all workflows
moltbot workflow list
```

## Artifacts

Each workflow run produces:
- `plan.md` - Implementation plan
- `tasks.json` - Structured task list
- `execution-report.json` - Execution summary
- `review.json` - Review results
- `recommendations.json` - Improvement suggestions

Artifacts are stored in: `~/.clawdbot/workflows/<run-id>/`

## Policy & Approvals

Live mode enforces security policies:
- Sandboxed execution by default
- Approval prompts for destructive operations
- Configurable allowed/blocked command patterns
- Filesystem scope restrictions

## Monitoring

Real-time workflow monitoring:

```bash
# Live streaming logs
moltbot workflow logs <run-id> --follow

# Check current status
moltbot workflow status <run-id>

# Detailed status with phase info
moltbot workflow status <run-id> --verbose

# List all workflows with status
moltbot workflow list
```

Workflow artifacts location: `~/.clawdbot/workflows/<run-id>/`

## References

- [Workflow Specification](references/workflow-spec.md)
- [Artifacts Guide](references/artifacts.md)
- [Policy & Approvals](references/policy-approvals.md)
