import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { TypingController } from "./typing.js";

// Mock the workflow modules
vi.mock("../../workflows/intent-router.js", () => ({
  detectWorkflowIntent: vi.fn(),
  suggestWorkflowCommand: vi.fn(),
}));

vi.mock("../../workflows/constants.js", () => ({
  DEFAULT_INTENT_MIN_CONFIDENCE: 0.7,
  DEFAULT_INTENT_ROUTING_ENABLED: false,
  DEFAULT_INTENT_AUTO_START: false,
}));

import { detectWorkflowIntent, suggestWorkflowCommand } from "../../workflows/intent-router.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";

const mockDetectWorkflowIntent = detectWorkflowIntent as ReturnType<typeof vi.fn>;
const mockSuggestWorkflowCommand = suggestWorkflowCommand as ReturnType<typeof vi.fn>;

function createMinimalTypingController(): TypingController {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    cleanup: vi.fn(),
    isActive: () => false,
  };
}

function createMinimalContext(): {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
} {
  const ctx: MsgContext = {
    Body: "plan and implement user auth",
    BodyForAgent: "plan and implement user auth",
    Provider: "test",
    Surface: "test",
    To: "test",
    From: "user",
  } as any;
  const sessionCtx: TemplateContext = {
    Body: "plan and implement user auth",
    BodyForAgent: "plan and implement user auth",
    BodyStripped: "plan and implement user auth",
  } as any;
  return { ctx, sessionCtx };
}

describe("Workflow Intent Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectWorkflowIntent.mockReturnValue({
      type: null,
      confidence: 0,
    });
    mockSuggestWorkflowCommand.mockReturnValue(null);
  });

  describe("when routing is disabled", () => {
    it("does not detect workflow intent", async () => {
      const cfg: OpenClawConfig = {
        workflows: {
          routing: {
            enabled: false,
          },
        },
      };

      const { ctx, sessionCtx } = createMinimalContext();

      const result = await handleInlineActions({
        ctx,
        sessionCtx,
        cfg,
        agentId: "main",
        sessionKey: "test-session",
        sessionScope: "global",
        workspaceDir: "/tmp/test",
        isGroup: false,
        typing: createMinimalTypingController(),
        allowTextCommands: true,
        inlineStatusRequested: false,
        command: {
          commandBodyNormalized: "plan and implement user auth",
          rawBodyNormalized: "plan and implement user auth",
          isAuthorizedSender: true,
          senderId: "user",
        } as any,
        directives: { cleaned: "plan and implement user auth" } as any,
        cleanedBody: "plan and implement user auth",
        elevatedEnabled: false,
        elevatedAllowed: false,
        elevatedFailures: [],
        defaultActivation: undefined,
        resolvedThinkLevel: undefined,
        resolvedVerboseLevel: undefined,
        resolvedReasoningLevel: "off" as const,
        resolvedElevatedLevel: "off" as const,
        resolveDefaultThinkingLevel: async () => "off" as const,
        provider: "anthropic",
        model: "claude-3-sonnet",
        contextTokens: 0,
        abortedLastRun: false,
      });

      expect(mockDetectWorkflowIntent).not.toHaveBeenCalled();
      expect(result.kind).toBe("continue");
    });
  });

  describe("when routing is enabled", () => {
    const enabledConfig: OpenClawConfig = {
      workflows: {
        routing: {
          enabled: true,
          minConfidence: 0.7,
          autoStart: false,
        },
      },
    };

    it("detects workflow intent from message", async () => {
      mockDetectWorkflowIntent.mockReturnValue({
        type: "dev-cycle",
        confidence: 0.9,
        task: "user authentication",
      });
      mockSuggestWorkflowCommand.mockReturnValue(
        'moltbot workflow start --type dev-cycle --task "user authentication" --repo .',
      );

      const { ctx, sessionCtx } = createMinimalContext();

      const result = await handleInlineActions({
        ctx,
        sessionCtx,
        cfg: enabledConfig,
        agentId: "main",
        sessionKey: "test-session",
        sessionScope: "global",
        workspaceDir: "/tmp/test",
        isGroup: false,
        typing: createMinimalTypingController(),
        allowTextCommands: true,
        inlineStatusRequested: false,
        command: {
          commandBodyNormalized: "plan and implement user auth",
          rawBodyNormalized: "plan and implement user auth",
          isAuthorizedSender: true,
          senderId: "user",
        } as any,
        directives: { cleaned: "plan and implement user auth" } as any,
        cleanedBody: "plan and implement user auth",
        elevatedEnabled: false,
        elevatedAllowed: false,
        elevatedFailures: [],
        defaultActivation: undefined,
        resolvedThinkLevel: undefined,
        resolvedVerboseLevel: undefined,
        resolvedReasoningLevel: "off" as const,
        resolvedElevatedLevel: "off" as const,
        resolveDefaultThinkingLevel: async () => "off" as const,
        provider: "anthropic",
        model: "claude-3-sonnet",
        contextTokens: 0,
        abortedLastRun: false,
      });

      expect(mockDetectWorkflowIntent).toHaveBeenCalledWith("plan and implement user auth");
      expect(result.kind).toBe("reply");
      if (result.kind === "reply") {
        expect((result.reply as any).text).toContain("Detected workflow intent");
        expect((result.reply as any).text).toContain("dev-cycle");
      }
    });

    it("ignores low confidence intent", async () => {
      mockDetectWorkflowIntent.mockReturnValue({
        type: "dev-cycle",
        confidence: 0.3, // Below threshold
        task: "something",
      });

      const { ctx, sessionCtx } = createMinimalContext();

      const result = await handleInlineActions({
        ctx,
        sessionCtx,
        cfg: enabledConfig,
        agentId: "main",
        sessionKey: "test-session",
        sessionScope: "global",
        workspaceDir: "/tmp/test",
        isGroup: false,
        typing: createMinimalTypingController(),
        allowTextCommands: true,
        inlineStatusRequested: false,
        command: {
          commandBodyNormalized: "hello there",
          rawBodyNormalized: "hello there",
          isAuthorizedSender: true,
          senderId: "user",
        } as any,
        directives: { cleaned: "hello there" } as any,
        cleanedBody: "hello there",
        elevatedEnabled: false,
        elevatedAllowed: false,
        elevatedFailures: [],
        defaultActivation: undefined,
        resolvedThinkLevel: undefined,
        resolvedVerboseLevel: undefined,
        resolvedReasoningLevel: "off" as const,
        resolvedElevatedLevel: "off" as const,
        resolveDefaultThinkingLevel: async () => "off" as const,
        provider: "anthropic",
        model: "claude-3-sonnet",
        contextTokens: 0,
        abortedLastRun: false,
      });

      expect(result.kind).toBe("continue");
    });

    it("does not trigger for unauthorized senders", async () => {
      const { ctx, sessionCtx } = createMinimalContext();

      const result = await handleInlineActions({
        ctx,
        sessionCtx,
        cfg: enabledConfig,
        agentId: "main",
        sessionKey: "test-session",
        sessionScope: "global",
        workspaceDir: "/tmp/test",
        isGroup: false,
        typing: createMinimalTypingController(),
        allowTextCommands: true,
        inlineStatusRequested: false,
        command: {
          commandBodyNormalized: "plan and implement user auth",
          rawBodyNormalized: "plan and implement user auth",
          isAuthorizedSender: false, // Not authorized
          senderId: "unknown",
        } as any,
        directives: { cleaned: "plan and implement user auth" } as any,
        cleanedBody: "plan and implement user auth",
        elevatedEnabled: false,
        elevatedAllowed: false,
        elevatedFailures: [],
        defaultActivation: undefined,
        resolvedThinkLevel: undefined,
        resolvedVerboseLevel: undefined,
        resolvedReasoningLevel: "off" as const,
        resolvedElevatedLevel: "off" as const,
        resolveDefaultThinkingLevel: async () => "off" as const,
        provider: "anthropic",
        model: "claude-3-sonnet",
        contextTokens: 0,
        abortedLastRun: false,
      });

      expect(mockDetectWorkflowIntent).not.toHaveBeenCalled();
      expect(result.kind).toBe("continue");
    });
  });

  describe("with autoStart enabled", () => {
    it("rewrites body to invoke workflow skill", async () => {
      const autoStartConfig: OpenClawConfig = {
        workflows: {
          routing: {
            enabled: true,
            minConfidence: 0.7,
            autoStart: true,
          },
        },
      };

      mockDetectWorkflowIntent.mockReturnValue({
        type: "dev-cycle",
        confidence: 0.9,
        task: "user authentication",
      });

      const { ctx, sessionCtx } = createMinimalContext();

      const result = await handleInlineActions({
        ctx,
        sessionCtx,
        cfg: autoStartConfig,
        agentId: "main",
        sessionKey: "test-session",
        sessionScope: "global",
        workspaceDir: "/tmp/test",
        isGroup: false,
        typing: createMinimalTypingController(),
        allowTextCommands: true,
        inlineStatusRequested: false,
        command: {
          commandBodyNormalized: "plan and implement user auth",
          rawBodyNormalized: "plan and implement user auth",
          isAuthorizedSender: true,
          senderId: "user",
        } as any,
        directives: { cleaned: "plan and implement user auth" } as any,
        cleanedBody: "plan and implement user auth",
        elevatedEnabled: false,
        elevatedAllowed: false,
        elevatedFailures: [],
        defaultActivation: undefined,
        resolvedThinkLevel: undefined,
        resolvedVerboseLevel: undefined,
        resolvedReasoningLevel: "off" as const,
        resolvedElevatedLevel: "off" as const,
        resolveDefaultThinkingLevel: async () => "off" as const,
        provider: "anthropic",
        model: "claude-3-sonnet",
        contextTokens: 0,
        abortedLastRun: false,
      });

      // Should continue with rewritten body, not return reply
      expect(result.kind).toBe("continue");
      // Body should be rewritten
      expect(ctx.Body).toContain("multi-agent-workflow");
      expect(ctx.Body).toContain("dev-cycle");
    });
  });
});
