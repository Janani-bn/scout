import { vi, describe, it, expect, beforeEach } from "vitest";
import { ResearchExecutionService } from "../research-execution.service";

// Mock prisma and dependencies
vi.mock("../../lib/prisma", () => ({
  prisma: {
    researchTask: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    researchSession: { findUnique: vi.fn() },
    source: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    evidence: { create: vi.fn(), findMany: vi.fn() },
    claim: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    claimEvidence: { upsert: vi.fn() },
    agentRun: { create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../../agents/core/agent-execution.service", () => ({
  AgentExecutionService: {
    execute: vi.fn().mockImplementation(async (agentType, context) => {
      if (agentType === "RESEARCH") {
        return {
          success: true,
          output: JSON.stringify([
            { url: "https://example.com/duplicate", title: "Test", publisher: "Test" }
          ]),
        };
      }
      if (agentType === "SOURCE") {
        return { success: true, output: JSON.stringify({ relevant: true, credibilityScore: 0.9 }) };
      }
      if (agentType === "EVIDENCE") {
        return { success: true, output: JSON.stringify({ evidence: [] }) };
      }
      return { success: true, output: "{}" };
    }),
  },
}));

import { prisma } from "../../lib/prisma";
vi.mock("../../lib/content-fetcher", () => ({
  ContentFetcher: { fetchContent: vi.fn().mockResolvedValue("mocked content") }
}));

describe("ResearchExecutionService - Source Creation Concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default Prisma mocks
    vi.mocked(prisma.researchTask.update).mockResolvedValue({} as any);
    vi.mocked(prisma.researchTask.findUnique).mockResolvedValue({ id: 'task-1', title: 'Task' } as any);
    vi.mocked(prisma.researchTask.updateMany).mockResolvedValue({} as any);
    vi.mocked(prisma.researchTask.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.evidence.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.claim.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.agentRun.create).mockResolvedValue({ id: 'run-1' } as any);
  });

  it("1. Existing source is reused", async () => {
    vi.mocked(prisma.source.findFirst).mockResolvedValue({ id: "source-1" } as any);

    await ResearchExecutionService.executeTask("session-1", "task-1");

    expect(prisma.source.findFirst).toHaveBeenCalled();
    expect(prisma.source.create).not.toHaveBeenCalled();
  });

  it("2. New source is created when no source exists", async () => {
    vi.mocked(prisma.source.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.source.create).mockResolvedValue({ id: "source-new" } as any);

    await ResearchExecutionService.executeTask("session-1", "task-1");

    expect(prisma.source.create).toHaveBeenCalled();
  });

  it("3 & 4. Unique-constraint race (P2002) is recovered by fetching the existing source", async () => {
    vi.mocked(prisma.source.findFirst).mockResolvedValue(null); // First check returns nothing

    // Create throws P2002 error
    const p2002Error = new Error("Unique constraint failed");
    (p2002Error as any).code = "P2002";
    vi.mocked(prisma.source.create).mockRejectedValueOnce(p2002Error);

    // The fallback findFirst should return the concurrent source
    vi.mocked(prisma.source.findFirst).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "source-recovered" } as any);

    await expect(ResearchExecutionService.executeTask("session-1", "task-1")).resolves.not.toThrow();

    expect(prisma.source.create).toHaveBeenCalledTimes(1);
    expect(prisma.source.findFirst).toHaveBeenCalledTimes(2);
  });

  it("5. The same URL can still exist independently in different research sessions", async () => {
    vi.mocked(prisma.source.findFirst).mockImplementation(((args: any) => {
      // Simulate that session-2 doesn't have it, even if session-1 does (conceptually)
      if (args?.where?.researchSessionId === "session-2") return Promise.resolve(null);
      return Promise.resolve(null);
    }) as any);

    vi.mocked(prisma.source.create).mockResolvedValue({ id: "source-new" } as any);

    await ResearchExecutionService.executeTask("session-2", "task-2");

    expect(prisma.source.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          researchSessionId: "session-2"
        })
      })
    );
  });
});
