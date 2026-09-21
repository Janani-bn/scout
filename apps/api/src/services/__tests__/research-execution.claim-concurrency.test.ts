import { vi, describe, it, expect, beforeEach } from "vitest";
import { ResearchExecutionService } from "../research-execution.service";
import { prisma } from "../../lib/prisma";
import { AgentExecutionService } from "../../agents/core/agent-execution.service";

// We must mock the entire prisma client for these tests
vi.mock("../../lib/prisma", () => ({
  prisma: {
    researchTask: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    claim: {
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    evidence: {
      findMany: vi.fn(),
    },
    claimEvidence: {
      upsert: vi.fn(),
    },
    agentRun: {
      create: vi.fn().mockResolvedValue({ id: "run-1" }),
      update: vi.fn(),
    },
    source: {
      findFirst: vi.fn(),
      create: vi.fn(),
    }
  }
}));

vi.mock("../../agents/core/agent-execution.service", () => ({
  AgentExecutionService: {
    execute: vi.fn(),
  }
}));

describe("Claim Verification Concurrency Tests", () => {
  let mockClaimsDB: any[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(AgentExecutionService.execute).mockImplementation(async (agentType: string) => {
      if (agentType === "RESEARCH") return { success: true, output: JSON.stringify([]) } as any;
      return { success: true, output: JSON.stringify({ status: "VERIFIED", confidenceScore: 0.9, mappings: [] }) } as any;
    });

    // Default mock behavior
    vi.mocked(prisma.researchTask.findUnique).mockResolvedValue({ id: "task-1", status: "PENDING", title: "Test" } as any);
    vi.mocked(prisma.evidence.findMany).mockResolvedValue([{ id: "ev-1" }] as any);

    // Simulate DB state
    mockClaimsDB = [
      { id: "claim-1", content: "Test Claim", status: "UNVERIFIED", updatedAt: new Date("2023-01-01T00:00:00Z"), metadata: null }
    ];

    vi.mocked(prisma.claim.findMany).mockImplementation(async () => [...mockClaimsDB] as any);

    // Realistic CAS Mock for updateMany
    vi.mocked(prisma.claim.updateMany).mockImplementation(async ({ where, data }: any) => {
      let updatedCount = 0;
      mockClaimsDB = mockClaimsDB.map(c => {
        // CAS logic: id must match AND updatedAt must exactly match
        if (c.id === where.id && c.updatedAt.getTime() === where.updatedAt.getTime()) {
          updatedCount++;
          return { ...c, metadata: data.metadata, updatedAt: data.updatedAt };
        }
        return c;
      });
      return { count: updatedCount } as any;
    });
  });

  it("TEST 1 & 2 - CONCURRENCY AND +1ms TOKEN: Two concurrent workers, only one acquires, exact +1ms token used", async () => {
    vi.mocked(prisma.researchTask.findUnique).mockImplementation(async ({ where }: any) => {
      return { id: where.id, status: "PENDING", title: "Test" } as any;
    });

    vi.mocked(AgentExecutionService.execute).mockImplementation(async (agentType: string) => {
      if (agentType === "RESEARCH") return { success: true, output: JSON.stringify([]) } as any;
      if (agentType === "CRITIC") {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { success: true, output: JSON.stringify({ status: "VERIFIED", confidenceScore: 0.9, mappings: [] }) } as any;
      }
      return { success: true } as any;
    });

    const p1 = ResearchExecutionService.executeTask("session-1", "task-1");
    const p2 = ResearchExecutionService.executeTask("session-1", "task-2");

    await Promise.all([p1, p2]);

    const criticCalls = vi.mocked(AgentExecutionService.execute).mock.calls.filter(c => c[0] === "CRITIC");
    // Only one worker should successfully call CRITIC
    expect(criticCalls.length).toBe(1);

    // updateMany calls: Worker 1 acquire, Worker 2 acquire (fails), Worker 1 success release
    // But since Promise.all resolves both, we check the actual calls
    const updateManyCalls = vi.mocked(prisma.claim.updateMany).mock.calls;

    // Find the successful acquisition call (it has lockedBy in data)
    const acquisitionCall = updateManyCalls.find(c => c[0].data.metadata?.lockedBy);
    expect(acquisitionCall).toBeDefined();

    const originalUpdatedAt = new Date("2023-01-01T00:00:00Z");

    // VERIFY +1ms TOKEN logic
    const appliedToken = acquisitionCall![0].data.updatedAt;
    expect(appliedToken.getTime()).toBe(originalUpdatedAt.getTime() + 1);
  });

  it("TEST 3 - SUCCESS OWNERSHIP: Verify success uses exact CAS token", async () => {
    await ResearchExecutionService.executeTask("session-1", "task-1");

    const updateManyCalls = vi.mocked(prisma.claim.updateMany).mock.calls;
    const acquisitionCall = updateManyCalls[0];
    const successReleaseCall = updateManyCalls[1];

    const appliedToken = acquisitionCall[0].data.updatedAt;

    // Success path must filter by the exact token generated during acquisition
    expect(successReleaseCall[0].where.updatedAt.getTime()).toBe(appliedToken.getTime());
  });

  it("TEST 4 - FAILURE OWNERSHIP: Verify failure uses exact CAS token", async () => {
    vi.mocked(AgentExecutionService.execute).mockImplementation(async (agentType: string) => {
      if (agentType === "RESEARCH") return { success: true, output: JSON.stringify([]) } as any;
      if (agentType === "CRITIC") throw new Error("LLM failure");
      return { success: true } as any;
    });

    await expect(ResearchExecutionService.executeTask("session-1", "task-1")).rejects.toThrow("LLM failure");

    const updateManyCalls = vi.mocked(prisma.claim.updateMany).mock.calls;
    const acquisitionCall = updateManyCalls[0];
    const failureReleaseCall = updateManyCalls[1];

    const appliedToken = acquisitionCall[0].data.updatedAt;

    // Failure path must filter by the exact token generated during acquisition
    expect(failureReleaseCall[0].where.updatedAt.getTime()).toBe(appliedToken.getTime());
  });

  it("TEST 5 - ZOMBIE WORKER: Old execution cannot clear current lock", async () => {
    // 1. Setup zombie worker to fail
    vi.mocked(AgentExecutionService.execute).mockImplementation(async (agentType: string) => {
      if (agentType === "RESEARCH") return { success: true, output: JSON.stringify([]) } as any;
      if (agentType === "CRITIC") {
        // Here we simulate Worker B reclaiming the lock WHILE Worker A is hung.
        // Worker B changes the DB token.
        mockClaimsDB[0].updatedAt = new Date("2023-01-01T00:00:05Z"); // Changed token
        mockClaimsDB[0].metadata = { lockedBy: "task-1" };
        throw new Error("Zombie LLM failure");
      }
      return { success: true } as any;
    });

    await expect(ResearchExecutionService.executeTask("session-1", "task-1")).rejects.toThrow("Zombie LLM failure");

    const updateManyCalls = vi.mocked(prisma.claim.updateMany).mock.calls;
    const failureReleaseCall = updateManyCalls[1];

    // Worker A tries to release its old token
    expect(failureReleaseCall[0].where.updatedAt.getTime()).toBe(new Date("2023-01-01T00:00:00Z").getTime() + 1);

    // But since we manually advanced mockClaimsDB[0].updatedAt in the mock, the DB state remains untouched
    expect(mockClaimsDB[0].metadata.lockedBy).toBe("task-1"); // Still locked!
  });

  it("TEST 6 - SAME-TASK RECLAIM: task-1 can reclaim its own lock", async () => {
    mockClaimsDB[0].metadata = { lockedBy: "task-1" };
    mockClaimsDB[0].updatedAt = new Date("2023-01-01T00:00:02Z"); // Some older token

    await ResearchExecutionService.executeTask("session-1", "task-1");

    const updateManyCalls = vi.mocked(prisma.claim.updateMany).mock.calls;
    const acquisitionCall = updateManyCalls[0];

    // Acquisition succeeds and changes the token
    expect(acquisitionCall[0].where.updatedAt.getTime()).toBe(new Date("2023-01-01T00:00:02Z").getTime());
    expect(acquisitionCall[0].data.updatedAt.getTime()).toBe(new Date("2023-01-01T00:00:02Z").getTime() + 1);
  });

  it("TEST 7 - FOREIGN LOCK: task-2 cannot process claim locked by task-1", async () => {
    vi.mocked(prisma.researchTask.findUnique).mockResolvedValue({ id: "task-2", status: "PENDING", title: "Test" } as any);
    mockClaimsDB[0].metadata = { lockedBy: "task-1" };

    await ResearchExecutionService.executeTask("session-1", "task-2");

    const criticCalls = vi.mocked(AgentExecutionService.execute).mock.calls.filter(c => c[0] === "CRITIC");
    expect(criticCalls.length).toBe(0); // Cannot process
    expect(vi.mocked(prisma.claim.updateMany)).toHaveBeenCalledTimes(0);
  });

  it("TEST 8 - DIFFERENT CLAIMS: Independent claims do not block each other", async () => {
    mockClaimsDB = [
      { id: "claim-1", content: "Claim 1", status: "UNVERIFIED", updatedAt: new Date("2023-01-01T00:00:00Z"), metadata: null },
      { id: "claim-2", content: "Claim 2", status: "UNVERIFIED", updatedAt: new Date("2023-01-01T00:00:00Z"), metadata: null }
    ];

    const p1 = ResearchExecutionService.executeTask("session-1", "task-1");

    vi.mocked(prisma.researchTask.findUnique).mockResolvedValueOnce({ id: "task-2", status: "PENDING", title: "Test" } as any);
    const p2 = ResearchExecutionService.executeTask("session-1", "task-2");

    await Promise.all([p1, p2]);

    const criticCalls = vi.mocked(AgentExecutionService.execute).mock.calls.filter(c => c[0] === "CRITIC");
    // Wait, since findMany returns ALL UNVERIFIED claims, both task-1 and task-2 will see both claims.
    // If they race, one will get claim-1, one might get claim-2.
    // In our simplified realistic mock, they process sequentially in the mock loop.
    // But since they both get an array of 2 claims, they will process them.
    // We just want to ensure both CRITIC calls happen in total (one per claim).
    expect(criticCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("TEST 9 - NORMAL EXECUTION: status, confidenceScore, reasoning, metadata behave as before", async () => {
    mockClaimsDB[0].metadata = { someOtherMeta: "value" };

    await ResearchExecutionService.executeTask("session-1", "task-1");

    const updateManyCalls = vi.mocked(prisma.claim.updateMany).mock.calls;
    const successCall = updateManyCalls[1];

    expect(successCall[0].data.status).toBe("VERIFIED");
    expect(successCall[0].data.confidenceScore).toBe(0.9);
    expect(successCall[0].data.metadata).toEqual({ someOtherMeta: "value" }); // lockedBy removed
  });
});
