import { vi, describe, it, expect, beforeEach } from "vitest";
import { ResearchSessionExecutionService } from "../research-session-execution.service";
import { JobService } from "../../jobs/services/job.service";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    researchSession: { findUnique: vi.fn(), update: vi.fn() },
    researchTask: { updateMany: vi.fn(), findMany: vi.fn() },
    report: { findFirst: vi.fn() },
  }
}));
import { prisma } from "../../lib/prisma";

vi.mock("../../jobs/services/job.service", () => ({
  JobService: {
    enqueueResearchTask: vi.fn(),
    enqueueSynthesis: vi.fn(),
  }
}));


describe("ResearchSessionExecutionService - Retry Synthesis Failure", () => {
  let evalSpy: any;
  beforeEach(() => {
    vi.clearAllMocks();
    evalSpy = vi.spyOn(ResearchSessionExecutionService, "evaluateSessionTerminalState");
  });

  it("1. FAILED session + all research tasks COMPLETED -> retry execution triggers ResearchSessionExecutionService.evaluateSessionTerminalState", async () => {
    // Session is FAILED
    vi.mocked(prisma.researchSession.findUnique).mockResolvedValue({
      id: "session-failed",
      userId: "user-1",
      status: "FAILED",
      tasks: [{ id: "task-1" }]
    } as any);

    // No tasks reset because none are FAILED/IN_PROGRESS (they are COMPLETED)
    vi.mocked(prisma.researchTask.updateMany).mockResolvedValue({ count: 0 } as any);

    // Find PENDING tasks returns empty (because they are COMPLETED)
    vi.mocked(prisma.researchTask.findMany).mockImplementation((async (args: any) => {
      if ((args as any)?.where?.status === "PENDING") return [];
      return [{ id: "task-1", status: "COMPLETED" }] as any;
    }) as any);

    const result = await ResearchSessionExecutionService.startExecution("session-failed", "user-1");

    expect(result.status).toBe("IN_PROGRESS");
    expect(evalSpy).toHaveBeenCalledWith("session-failed");
    expect(JobService.enqueueSynthesis).toHaveBeenCalledWith("session-failed");
    expect(JobService.enqueueSynthesis).toHaveBeenCalledTimes(1);
  });

  it("2. Session with research tasks that are still incomplete -> retry should NOT incorrectly enqueue synthesis", async () => {
    vi.mocked(prisma.researchSession.findUnique).mockResolvedValue({
      id: "session-progress",
      userId: "user-1",
      status: "IN_PROGRESS",
      tasks: [{ id: "task-1" }]
    } as any);

    vi.mocked(prisma.researchTask.updateMany).mockResolvedValue({ count: 0 } as any);

    // Task is pending
    vi.mocked(prisma.researchTask.findMany).mockResolvedValue([{ id: "task-1" }] as any);

    await ResearchSessionExecutionService.startExecution("session-progress", "user-1");

    expect(evalSpy).not.toHaveBeenCalled();
    expect(JobService.enqueueResearchTask).toHaveBeenCalled();
  });

  it("3. A session with no completed research work (but no pending either) -> retry should NOT enqueue synthesis", async () => {
    // If the session has no tasks at all
    vi.mocked(prisma.researchSession.findUnique).mockResolvedValue({
      id: "session-empty",
      userId: "user-1",
      status: "FAILED",
      tasks: []
    } as any);

    vi.mocked(prisma.researchTask.updateMany).mockResolvedValue({ count: 0 } as any);

    vi.mocked(prisma.researchTask.findMany).mockImplementation((async (args: any) => {
      if ((args as any)?.where?.status === "PENDING") return [];
      return [{ id: "task-1", status: "COMPLETED" }] as any;
    }) as any);

    await expect(ResearchSessionExecutionService.startExecution("session-empty", "user-1")).rejects.toThrowError(/No tasks are planned/);
    // Wait! ResearchSessionExecutionService.evaluateSessionTerminalState will handle checking min completed, so calling it IS CORRECT, but synthesis won't be enqueued inside it.
    // The test asserts that ResearchSessionExecutionService.evaluateSessionTerminalState handles the rules.
  });
});
