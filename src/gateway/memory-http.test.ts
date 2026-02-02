import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the dependencies
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../memory/facts/index.js", () => ({
  createFactsMemoryManager: vi.fn(),
  getHealthSummary: vi.fn(),
  getTopFacts: vi.fn(),
  getRelevantContextWithTrace: vi.fn(),
}));

vi.mock("../infra/device-pairing.js", () => ({
  resolveDeviceTokenByValue: vi.fn(),
}));

vi.mock("./auth.js", () => ({
  authorizeGatewayConnect: vi.fn(),
}));

import { loadConfig } from "../config/config.js";
import { resolveDeviceTokenByValue } from "../infra/device-pairing.js";
import {
  createFactsMemoryManager,
  getHealthSummary,
  getTopFacts,
  getRelevantContextWithTrace,
} from "../memory/facts/index.js";
import { authorizeGatewayConnect } from "./auth.js";
import { handleMemoryHttpRequest } from "./memory-http.js";

function createMockRequest(url: string, method = "GET"): IncomingMessage {
  return {
    url,
    method,
    headers: { host: "localhost:18789" },
  } as unknown as IncomingMessage;
}

function createMockRequestWithBody(url: string, body: unknown, method = "POST"): IncomingMessage {
  const bodyStr = JSON.stringify(body);
  const listeners: { [event: string]: ((data: unknown) => void)[] } = {};

  const readable = {
    url,
    method,
    headers: {
      host: "localhost:18789",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(bodyStr)),
    },
    on(event: string, cb: (data: unknown) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      // Emit data and end immediately after registration
      if (event === "data") {
        setImmediate(() => {
          for (const handler of listeners.data || []) {
            handler(Buffer.from(bodyStr));
          }
          for (const handler of listeners.end || []) {
            handler(undefined);
          }
        });
      }
      return this;
    },
    removeListener() {
      return this;
    },
  };
  return readable as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse & { body: string; statusCode: number } {
  const chunks: string[] = [];
  const res = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      this.body = chunks.join("");
    },
  } as unknown as ServerResponse & { body: string; statusCode: number };
  return res;
}

// Mock auth options for tests (no auth check when opts not provided)
const mockAuth = { mode: "token" as const, token: "test-token" };

describe("handleMemoryHttpRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: auth succeeds
    vi.mocked(authorizeGatewayConnect).mockResolvedValue({ ok: true, method: "token" });
  });

  describe("routing", () => {
    it("returns false for non-memory routes", async () => {
      const req = createMockRequest("/api/other");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(false);
    });

    it("returns false for partial memory path", async () => {
      const req = createMockRequest("/api/memory/other");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(false);
    });
  });

  describe("auth", () => {
    it("returns 401 when auth fails", async () => {
      vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>);
      vi.mocked(authorizeGatewayConnect).mockResolvedValue({ ok: false });

      const req = createMockRequest("/api/memory/facts/status");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res, { auth: mockAuth });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    });

    it("allows request when auth succeeds", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: false },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/status");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res, { auth: mockAuth });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it("allows request when device token is valid", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: false },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(authorizeGatewayConnect).mockResolvedValue({ ok: false });
      vi.mocked(resolveDeviceTokenByValue).mockResolvedValue({
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.admin"],
      } as any);

      const req = createMockRequest("/api/memory/facts/status");
      (req as unknown as { headers: Record<string, string> }).headers.authorization =
        "Bearer device-token";
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res, { auth: mockAuth });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(resolveDeviceTokenByValue).toHaveBeenCalledWith("device-token");
    });
  });

  describe("GET /api/memory/facts/status", () => {
    it("returns disabled status when memory is disabled", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: false },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/status");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(false);
      expect(body.status).toBe("disabled");
    });

    it("returns health summary when memory is enabled", async () => {
      const mockStore = {};
      const mockManager = {
        getStore: () => mockStore,
        getMarkdownPath: () => "/path/to/memory.md",
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);
      vi.mocked(getHealthSummary).mockReturnValue({
        status: "ok",
        snapshot: {
          dbSizeMb: 1.5,
          totalMemories: 100,
          lastExtractionAt: "2024-01-01T00:00:00.000Z",
          lastCleanupAt: "2024-01-02T00:00:00.000Z",
        },
        activeAlerts: [],
      } as any);

      const req = createMockRequest("/api/memory/facts/status");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(true);
      expect(body.status).toBe("ok");
      expect(body.dbSizeMb).toBe(1.5);
      expect(body.totalFacts).toBe(100);
      expect(body.alertCount).toBe(0);
    });

    it("returns 405 for non-GET requests", async () => {
      const req = createMockRequest("/api/memory/facts/status", "POST");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });
  });

  describe("GET /api/memory/facts/top", () => {
    it("returns empty items when memory is disabled", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: false },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/top");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toEqual([]);
    });

    it("returns top facts with default limit", async () => {
      const mockStore = {};
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);
      vi.mocked(getTopFacts).mockReturnValue([
        {
          id: "fact-1",
          type: "preference",
          content: "User prefers dark mode",
          importance: 0.8,
          lastAccessedAt: 1704067200,
          accessCount: 5,
        },
      ] as any);

      const req = createMockRequest("/api/memory/facts/top");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe("fact-1");
      expect(body.items[0].lastAccessedAt).toBe(1704067200000); // Converted to ms
    });

    it("respects limit parameter", async () => {
      const mockStore = {};
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);
      vi.mocked(getTopFacts).mockReturnValue([]);

      const req = createMockRequest("/api/memory/facts/top?limit=50");
      const res = createMockResponse();

      await handleMemoryHttpRequest(req, res);

      expect(getTopFacts).toHaveBeenCalledWith(mockStore, 100); // 50 * 2 for filtering buffer
    });

    it("validates limit parameter", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/top?limit=500");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("limit must be a number between 1 and 100");
    });

    it("validates type parameter", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/top?type=invalid");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("invalid type");
    });

    it("filters by type when specified", async () => {
      const mockStore = {};
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);
      vi.mocked(getTopFacts).mockReturnValue([
        {
          id: "1",
          type: "preference",
          content: "a",
          importance: 0.8,
          lastAccessedAt: 1000,
          accessCount: 1,
        },
        {
          id: "2",
          type: "fact",
          content: "b",
          importance: 0.7,
          lastAccessedAt: 1000,
          accessCount: 1,
        },
      ] as any);

      const req = createMockRequest("/api/memory/facts/top?type=preference");
      const res = createMockResponse();

      await handleMemoryHttpRequest(req, res);

      const body = JSON.parse(res.body);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].type).toBe("preference");
    });

    it("returns 405 for non-GET requests", async () => {
      const req = createMockRequest("/api/memory/facts/top", "POST");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });
  });

  describe("POST /api/memory/facts/delete", () => {
    it("returns 405 for non-POST requests", async () => {
      const req = createMockRequest("/api/memory/facts/delete", "GET");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });

    it("returns error when memory is disabled", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: false },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequestWithBody("/api/memory/facts/delete", { id: "test-id" });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
    });

    it("validates id is required", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequestWithBody("/api/memory/facts/delete", {});
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("id is required");
    });

    it("returns 404 when fact not found", async () => {
      const mockStore = {
        delete: vi.fn().mockReturnValue(false),
      };
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);

      const req = createMockRequestWithBody("/api/memory/facts/delete", { id: "nonexistent" });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });

    it("deletes fact successfully", async () => {
      const mockStore = {
        delete: vi.fn().mockReturnValue(true),
      };
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);

      const req = createMockRequestWithBody("/api/memory/facts/delete", { id: "fact-1" });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockStore.delete).toHaveBeenCalledWith("fact-1");
    });
  });

  describe("POST /api/memory/facts/update", () => {
    it("returns 405 for non-POST requests", async () => {
      const req = createMockRequest("/api/memory/facts/update", "GET");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });

    it("validates id is required", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequestWithBody("/api/memory/facts/update", { importance: 0.5 });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("id is required");
    });

    it("validates importance range", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequestWithBody("/api/memory/facts/update", {
        id: "test",
        importance: 1.5,
      });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("importance must be a number between 0 and 1");
    });

    it("returns 404 when fact not found", async () => {
      const mockStore = {
        get: vi.fn().mockReturnValue(null),
      };
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);

      const req = createMockRequestWithBody("/api/memory/facts/update", {
        id: "nonexistent",
        importance: 0.5,
      });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });

    it("updates importance successfully", async () => {
      const mockFact = {
        id: "fact-1",
        type: "preference",
        content: "User likes coffee",
        importance: 0.8,
        lastAccessedAt: 1704067200,
        accessCount: 5,
      };
      const mockStore = {
        get: vi.fn().mockReturnValue(mockFact),
        update: vi.fn(),
      };
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);

      const req = createMockRequestWithBody("/api/memory/facts/update", {
        id: "fact-1",
        importance: 0.9,
      });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockStore.update).toHaveBeenCalledWith("fact-1", { importance: 0.9 });
    });
  });

  describe("POST /api/memory/facts/merge", () => {
    it("returns 405 for non-POST requests", async () => {
      const req = createMockRequest("/api/memory/facts/merge", "GET");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });

    it("validates sourceId is required", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequestWithBody("/api/memory/facts/merge", { targetId: "target" });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("sourceId is required");
    });

    it("validates targetId is required", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequestWithBody("/api/memory/facts/merge", { sourceId: "source" });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("targetId is required");
    });

    it("validates sourceId and targetId must be different", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequestWithBody("/api/memory/facts/merge", {
        sourceId: "same",
        targetId: "same",
      });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("sourceId and targetId must be different");
    });

    it("returns 404 when source not found", async () => {
      const mockStore = {
        get: vi.fn().mockReturnValue(null),
      };
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);

      const req = createMockRequestWithBody("/api/memory/facts/merge", {
        sourceId: "source",
        targetId: "target",
      });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("Source fact not found");
    });

    it("returns 404 when target not found", async () => {
      const mockStore = {
        get: vi
          .fn()
          .mockReturnValueOnce({ id: "source" }) // source exists
          .mockReturnValueOnce(null), // target doesn't exist
      };
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);

      const req = createMockRequestWithBody("/api/memory/facts/merge", {
        sourceId: "source",
        targetId: "target",
      });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("Target fact not found");
    });

    it("merges facts successfully", async () => {
      const sourceFact = { id: "source", type: "fact", content: "Old info", importance: 0.5 };
      const targetFact = { id: "target", type: "fact", content: "New info", importance: 0.8 };
      const mergedSource = { ...sourceFact, supersededBy: "target" };

      const mockStore = {
        get: vi
          .fn()
          .mockReturnValueOnce(sourceFact) // check source
          .mockReturnValueOnce(targetFact) // check target
          .mockReturnValueOnce(mergedSource) // get updated source
          .mockReturnValueOnce(targetFact), // get updated target
        update: vi.fn(),
      };
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);

      const req = createMockRequestWithBody("/api/memory/facts/merge", {
        sourceId: "source",
        targetId: "target",
      });
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.source.supersededBy).toBe("target");
      expect(mockStore.update).toHaveBeenCalledWith("source", { supersededBy: "target" });
    });
  });

  describe("GET /api/memory/facts/trace", () => {
    it("returns 405 for non-GET requests", async () => {
      const req = createMockRequest("/api/memory/facts/trace?query=test", "POST");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });

    it("returns empty when memory is disabled", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: false },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/trace?query=test");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.included).toBe(0);
      expect(body.reasons).toEqual([]);
    });

    it("validates query is required", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/trace");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("query parameter is required");
    });

    it("validates limit parameter", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/trace?query=test&limit=500");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("limit must be a number between 1 and 100");
    });

    it("validates role parameter", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/trace?query=test&role=invalid");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("invalid role");
    });

    it("validates type parameter", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const req = createMockRequest("/api/memory/facts/trace?query=test&type=invalid");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("invalid type");
    });

    it("returns trace results successfully", async () => {
      const mockEntry = {
        id: "fact-1",
        type: "fact",
        content: "User likes TypeScript",
        importance: 0.8,
        accessCount: 5,
      };
      const mockStore = {
        get: vi.fn().mockReturnValue(mockEntry),
      };
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);
      vi.mocked(getRelevantContextWithTrace).mockReturnValue({
        query: "typescript",
        timestamp: 1704067200000,
        context: "## Relevant Memories\n- [fact] User likes TypeScript",
        reasons: [
          {
            id: "fact-1",
            source: "fts",
            score: 0.85,
            snippet: "User likes TypeScript",
            type: "fact",
            metadata: { ftsScore: 0.85 },
          },
        ],
        totalConsidered: 10,
        memoriesIncluded: 1,
        access: { role: "operator", excluded: 2, excludedTypes: [] },
      });

      const req = createMockRequest("/api/memory/facts/trace?query=typescript&role=operator");
      const res = createMockResponse();

      const handled = await handleMemoryHttpRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.query).toBe("typescript");
      expect(body.included).toBe(1);
      expect(body.excluded).toBe(2);
      expect(body.reasons).toHaveLength(1);
      expect(body.reasons[0].id).toBe("fact-1");
      expect(body.reasons[0].score).toBe(0.85);
      expect(body.reasons[0].source).toBe("fts");
      expect(body.context).toContain("Relevant Memories");
    });

    it("uses default role when not specified", async () => {
      const mockStore = {
        get: vi.fn().mockReturnValue(null),
      };
      const mockManager = {
        getStore: () => mockStore,
        close: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(loadConfig).mockReturnValue({
        factsMemory: { enabled: true },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(createFactsMemoryManager).mockReturnValue(mockManager as any);
      vi.mocked(getRelevantContextWithTrace).mockReturnValue({
        query: "test",
        timestamp: Date.now(),
        context: "",
        reasons: [],
        totalConsidered: 0,
        memoriesIncluded: 0,
        access: { role: "operator", excluded: 0, excludedTypes: [] },
      });

      const req = createMockRequest("/api/memory/facts/trace?query=test");
      const res = createMockResponse();

      await handleMemoryHttpRequest(req, res);

      expect(getRelevantContextWithTrace).toHaveBeenCalledWith(
        expect.anything(),
        "test",
        expect.objectContaining({
          access: expect.objectContaining({ role: "operator" }),
        }),
      );
    });
  });
});
