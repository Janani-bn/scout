import { vi, describe, it, expect, beforeEach } from "vitest";
import { JobService } from "../services/job.service";

// Mock env config so the service module loads without real env vars
vi.mock("../../config", () => {
  return {
    env: {
      RESEARCH_JOB_ATTEMPTS: 3,
      RESEARCH_JOB_BACKOFF_MS: 5000,
    },
  };
});

// Mock the queue module so no real Redis/BullMQ connection is created
const {
  mockResearchGetJob,
  mockResearchAdd,
  mockSynthesisGetJob,
  mockSynthesisAdd,
} = vi.hoisted(() => {
  return {
    mockResearchGetJob: vi.fn(),
    mockResearchAdd: vi.fn(),
    mockSynthesisGetJob: vi.fn(),
    mockSynthesisAdd: vi.fn(),
  };
});

vi.mock("../queues/research.queue", () => {
  return {
    researchQueue: {
      getJob: mockResearchGetJob,
      add: mockResearchAdd,
    },
    synthesisQueue: {
      getJob: mockSynthesisGetJob,
      add: mockSynthesisAdd,
    },
  };
});

function fakeExistingJob(state: string, id = "existing-job") {
  return {
    id,
    getState: vi.fn().mockResolvedValue(state),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe("JobService.enqueueResearchTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResearchAdd.mockImplementation(async (name: string, data: unknown, opts: { jobId: string }) => ({
      id: opts.jobId,
      name,
      data,
    }));
  });

  it("adds a new job when no job exists with the deterministic ID", async () => {
    mockResearchGetJob.mockResolvedValue(undefined);

    const job = await JobService.enqueueResearchTask("session-1", "task-1");

    expect(mockResearchAdd).toHaveBeenCalledTimes(1);
    expect(mockResearchAdd).toHaveBeenCalledWith(
      "RESEARCH_TASK",
      { type: "RESEARCH_TASK", researchSessionId: "session-1", researchTaskId: "task-1" },
      expect.objectContaining({ jobId: "research_task_task-1" })
    );
    expect(job.id).toBe("research_task_task-1");
  });

  it("keeps an active job instead of removing and re-adding it", async () => {
    const existing = fakeExistingJob("active");
    mockResearchGetJob.mockResolvedValue(existing);

    const job = await JobService.enqueueResearchTask("session-1", "task-1");

    expect(existing.remove).not.toHaveBeenCalled();
    expect(mockResearchAdd).not.toHaveBeenCalled();
    expect(job).toBe(existing);
  });

  it("keeps a waiting job instead of removing and re-adding it", async () => {
    const existing = fakeExistingJob("waiting");
    mockResearchGetJob.mockResolvedValue(existing);

    const job = await JobService.enqueueResearchTask("session-1", "task-1");

    expect(existing.remove).not.toHaveBeenCalled();
    expect(mockResearchAdd).not.toHaveBeenCalled();
    expect(job).toBe(existing);
  });

  it("keeps a delayed job instead of removing and re-adding it", async () => {
    const existing = fakeExistingJob("delayed");
    mockResearchGetJob.mockResolvedValue(existing);

    const job = await JobService.enqueueResearchTask("session-1", "task-1");

    expect(existing.remove).not.toHaveBeenCalled();
    expect(mockResearchAdd).not.toHaveBeenCalled();
    expect(job).toBe(existing);
  });

  it("replaces a failed job so an explicit retry can re-enqueue", async () => {
    const existing = fakeExistingJob("failed");
    mockResearchGetJob.mockResolvedValue(existing);

    const job = await JobService.enqueueResearchTask("session-1", "task-1");

    expect(existing.remove).toHaveBeenCalledTimes(1);
    expect(mockResearchAdd).toHaveBeenCalledTimes(1);
    expect(job.id).toBe("research_task_task-1");
  });

  it("replaces a completed job so an explicit retry can re-enqueue", async () => {
    const existing = fakeExistingJob("completed");
    mockResearchGetJob.mockResolvedValue(existing);

    const job = await JobService.enqueueResearchTask("session-1", "task-1");

    expect(existing.remove).toHaveBeenCalledTimes(1);
    expect(mockResearchAdd).toHaveBeenCalledTimes(1);
    expect(job.id).toBe("research_task_task-1");
  });

  it("still enqueues when the existing-job lookup fails, relying on BullMQ jobId dedupe", async () => {
    mockResearchGetJob.mockRejectedValue(new Error("redis hiccup"));

    const job = await JobService.enqueueResearchTask("session-1", "task-1");

    expect(mockResearchAdd).toHaveBeenCalledTimes(1);
    expect(job.id).toBe("research_task_task-1");
  });

  it("treats the job as live when its state cannot be determined", async () => {
    const existing = fakeExistingJob("active");
    existing.getState.mockRejectedValue(new Error("redis hiccup"));
    mockResearchGetJob.mockResolvedValue(existing);

    const job = await JobService.enqueueResearchTask("session-1", "task-1");

    expect(existing.remove).not.toHaveBeenCalled();
    expect(mockResearchAdd).not.toHaveBeenCalled();
    expect(job).toBe(existing);
  });

  it("concurrent enqueue attempts for the same task result in a single queued job", async () => {
    // Simulate BullMQ's jobId dedupe at insertion time: the second add with
    // the same deterministic ID returns the already-queued job.
    const queued = new Map<string, { id: string }>();
    mockResearchGetJob.mockResolvedValue(undefined);
    mockResearchAdd.mockImplementation(async (name: string, data: unknown, opts: { jobId: string }) => {
      const existing = queued.get(opts.jobId);
      if (existing) return existing;
      const job = { id: opts.jobId, name, data };
      queued.set(opts.jobId, job);
      return job;
    });

    const [first, second] = await Promise.all([
      JobService.enqueueResearchTask("session-1", "task-1"),
      JobService.enqueueResearchTask("session-1", "task-1"),
    ]);

    expect(queued.size).toBe(1);
    expect(first.id).toBe("research_task_task-1");
    expect(second.id).toBe("research_task_task-1");
  });
});

describe("JobService.enqueueSynthesis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSynthesisAdd.mockImplementation(async (name: string, data: unknown, opts: { jobId: string }) => ({
      id: opts.jobId,
      name,
      data,
    }));
  });

  it("adds a new synthesis job when none exists with the deterministic ID", async () => {
    mockSynthesisGetJob.mockResolvedValue(undefined);

    const job = await JobService.enqueueSynthesis("session-1");

    expect(mockSynthesisAdd).toHaveBeenCalledTimes(1);
    expect(mockSynthesisAdd).toHaveBeenCalledWith(
      "SYNTHESIS",
      { type: "SYNTHESIS", researchSessionId: "session-1" },
      expect.objectContaining({ jobId: "synthesis_session-1" })
    );
    expect(job.id).toBe("synthesis_session-1");
  });

  it("keeps an active synthesis job instead of removing and re-adding it", async () => {
    const existing = fakeExistingJob("active");
    mockSynthesisGetJob.mockResolvedValue(existing);

    const job = await JobService.enqueueSynthesis("session-1");

    expect(existing.remove).not.toHaveBeenCalled();
    expect(mockSynthesisAdd).not.toHaveBeenCalled();
    expect(job).toBe(existing);
  });

  it("replaces a failed synthesis job so an explicit retry can re-enqueue", async () => {
    const existing = fakeExistingJob("failed");
    mockSynthesisGetJob.mockResolvedValue(existing);

    const job = await JobService.enqueueSynthesis("session-1");

    expect(existing.remove).toHaveBeenCalledTimes(1);
    expect(mockSynthesisAdd).toHaveBeenCalledTimes(1);
    expect(job.id).toBe("synthesis_session-1");
  });
});
