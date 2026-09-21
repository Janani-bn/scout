import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock BullMQ Queue and Redis
const mockResearchQueueAdd = vi.fn();
const mockResearchQueueGetJob = vi.fn();
const mockSynthesisQueueAdd = vi.fn();
const mockSynthesisQueueGetJob = vi.fn();

vi.mock("../queues/research.queue", () => {
  return {
    researchQueue: {
      add: (...args: any[]) => mockResearchQueueAdd(...args),
      getJob: (...args: any[]) => mockResearchQueueGetJob(...args),
    },
    synthesisQueue: {
      add: (...args: any[]) => mockSynthesisQueueAdd(...args),
      getJob: (...args: any[]) => mockSynthesisQueueGetJob(...args),
    },
    getRedisConnection: vi.fn(),
  };
});

vi.mock("../../config", () => {
  return {
    env: {
      RESEARCH_JOB_ATTEMPTS: 3,
      RESEARCH_JOB_BACKOFF_MS: 5000,
    },
  };
});

import { JobService } from "../services/job.service";
import { env } from "../../config";

describe("JobService Idempotent Enqueuing Tests", () => {
  const sessionId = "sess-123";
  const taskId = "task-456";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("JobService.enqueueResearchTask", () => {
    const expectedJobId = `research_task_${taskId}`;

    it("should enqueue a new job when no existing job is found", async () => {
      mockResearchQueueGetJob.mockResolvedValue(null);
      const fakeJob = { id: expectedJobId, name: "RESEARCH_TASK" };
      mockResearchQueueAdd.mockResolvedValue(fakeJob);

      const result = await JobService.enqueueResearchTask(sessionId, taskId);

      expect(mockResearchQueueGetJob).toHaveBeenCalledWith(expectedJobId);
      expect(mockResearchQueueAdd).toHaveBeenCalledWith(
        "RESEARCH_TASK",
        {
          type: "RESEARCH_TASK",
          researchSessionId: sessionId,
          researchTaskId: taskId,
        },
        {
          jobId: expectedJobId,
          attempts: env.RESEARCH_JOB_ATTEMPTS,
          backoff: {
            type: "exponential",
            delay: env.RESEARCH_JOB_BACKOFF_MS,
          },
        }
      );
      expect(result).toBe(fakeJob);
    });

    it("should return the existing job and NOT remove or re-add when job is 'active'", async () => {
      const mockActiveJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("active"),
        remove: vi.fn(),
      };
      mockResearchQueueGetJob.mockResolvedValue(mockActiveJob);

      const result = await JobService.enqueueResearchTask(sessionId, taskId);

      expect(mockActiveJob.getState).toHaveBeenCalled();
      expect(mockActiveJob.remove).not.toHaveBeenCalled();
      expect(mockResearchQueueAdd).not.toHaveBeenCalled();
      expect(result).toBe(mockActiveJob);
    });

    it("should return the existing job and NOT remove or re-add when job is 'waiting'", async () => {
      const mockWaitingJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("waiting"),
        remove: vi.fn(),
      };
      mockResearchQueueGetJob.mockResolvedValue(mockWaitingJob);

      const result = await JobService.enqueueResearchTask(sessionId, taskId);

      expect(mockWaitingJob.getState).toHaveBeenCalled();
      expect(mockWaitingJob.remove).not.toHaveBeenCalled();
      expect(mockResearchQueueAdd).not.toHaveBeenCalled();
      expect(result).toBe(mockWaitingJob);
    });

    it("should return the existing job and NOT remove or re-add when job is 'delayed'", async () => {
      const mockDelayedJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("delayed"),
        remove: vi.fn(),
      };
      mockResearchQueueGetJob.mockResolvedValue(mockDelayedJob);

      const result = await JobService.enqueueResearchTask(sessionId, taskId);

      expect(mockDelayedJob.getState).toHaveBeenCalled();
      expect(mockDelayedJob.remove).not.toHaveBeenCalled();
      expect(mockResearchQueueAdd).not.toHaveBeenCalled();
      expect(result).toBe(mockDelayedJob);
    });

    it("should return the existing job and NOT remove or re-add when job is 'prioritized' or 'waiting-children'", async () => {
      const mockPrioritizedJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("prioritized"),
        remove: vi.fn(),
      };
      mockResearchQueueGetJob.mockResolvedValue(mockPrioritizedJob);

      const result1 = await JobService.enqueueResearchTask(sessionId, taskId);
      expect(mockPrioritizedJob.remove).not.toHaveBeenCalled();
      expect(mockResearchQueueAdd).not.toHaveBeenCalled();
      expect(result1).toBe(mockPrioritizedJob);

      const mockWaitingChildrenJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("waiting-children"),
        remove: vi.fn(),
      };
      mockResearchQueueGetJob.mockResolvedValue(mockWaitingChildrenJob);

      const result2 = await JobService.enqueueResearchTask(sessionId, taskId);
      expect(mockWaitingChildrenJob.remove).not.toHaveBeenCalled();
      expect(mockResearchQueueAdd).not.toHaveBeenCalled();
      expect(result2).toBe(mockWaitingChildrenJob);
    });

    it("should remove stale job and re-enqueue when existing job is 'failed'", async () => {
      const mockFailedJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("failed"),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      mockResearchQueueGetJob.mockResolvedValue(mockFailedJob);
      const newJob = { id: expectedJobId, name: "RESEARCH_TASK" };
      mockResearchQueueAdd.mockResolvedValue(newJob);

      const result = await JobService.enqueueResearchTask(sessionId, taskId);

      expect(mockFailedJob.getState).toHaveBeenCalled();
      expect(mockFailedJob.remove).toHaveBeenCalled();
      expect(mockResearchQueueAdd).toHaveBeenCalledWith(
        "RESEARCH_TASK",
        expect.anything(),
        expect.objectContaining({ jobId: expectedJobId })
      );
      expect(result).toBe(newJob);
    });

    it("should remove stale job and re-enqueue when existing job is 'completed'", async () => {
      const mockCompletedJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("completed"),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      mockResearchQueueGetJob.mockResolvedValue(mockCompletedJob);
      const newJob = { id: expectedJobId, name: "RESEARCH_TASK" };
      mockResearchQueueAdd.mockResolvedValue(newJob);

      const result = await JobService.enqueueResearchTask(sessionId, taskId);

      expect(mockCompletedJob.getState).toHaveBeenCalled();
      expect(mockCompletedJob.remove).toHaveBeenCalled();
      expect(mockResearchQueueAdd).toHaveBeenCalled();
      expect(result).toBe(newJob);
    });

    it("should gracefully continue and add job if remove() throws on a failed job", async () => {
      const mockFailedJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("failed"),
        remove: vi.fn().mockRejectedValue(new Error("Redis connection blip")),
      };
      mockResearchQueueGetJob.mockResolvedValue(mockFailedJob);
      const newJob = { id: expectedJobId, name: "RESEARCH_TASK" };
      mockResearchQueueAdd.mockResolvedValue(newJob);

      const result = await JobService.enqueueResearchTask(sessionId, taskId);

      expect(mockFailedJob.remove).toHaveBeenCalled();
      expect(mockResearchQueueAdd).toHaveBeenCalled();
      expect(result).toBe(newJob);
    });

    it("should gracefully continue and add job if getJob() throws", async () => {
      mockResearchQueueGetJob.mockRejectedValue(new Error("Redis get error"));
      const newJob = { id: expectedJobId, name: "RESEARCH_TASK" };
      mockResearchQueueAdd.mockResolvedValue(newJob);

      const result = await JobService.enqueueResearchTask(sessionId, taskId);

      expect(mockResearchQueueAdd).toHaveBeenCalled();
      expect(result).toBe(newJob);
    });
  });

  describe("JobService.enqueueSynthesis", () => {
    const expectedJobId = `synthesis_${sessionId}`;

    it("should enqueue a new synthesis job when no existing job is found", async () => {
      mockSynthesisQueueGetJob.mockResolvedValue(null);
      const fakeJob = { id: expectedJobId, name: "SYNTHESIS" };
      mockSynthesisQueueAdd.mockResolvedValue(fakeJob);

      const result = await JobService.enqueueSynthesis(sessionId);

      expect(mockSynthesisQueueGetJob).toHaveBeenCalledWith(expectedJobId);
      expect(mockSynthesisQueueAdd).toHaveBeenCalledWith(
        "SYNTHESIS",
        {
          type: "SYNTHESIS",
          researchSessionId: sessionId,
        },
        {
          jobId: expectedJobId,
          attempts: env.RESEARCH_JOB_ATTEMPTS,
          backoff: {
            type: "exponential",
            delay: env.RESEARCH_JOB_BACKOFF_MS,
          },
        }
      );
      expect(result).toBe(fakeJob);
    });

    it("should return the existing job and NOT remove or re-add when synthesis job is 'active'", async () => {
      const mockActiveJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("active"),
        remove: vi.fn(),
      };
      mockSynthesisQueueGetJob.mockResolvedValue(mockActiveJob);

      const result = await JobService.enqueueSynthesis(sessionId);

      expect(mockActiveJob.getState).toHaveBeenCalled();
      expect(mockActiveJob.remove).not.toHaveBeenCalled();
      expect(mockSynthesisQueueAdd).not.toHaveBeenCalled();
      expect(result).toBe(mockActiveJob);
    });

    it("should return the existing job and NOT remove or re-add when synthesis job is 'waiting'", async () => {
      const mockWaitingJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("waiting"),
        remove: vi.fn(),
      };
      mockSynthesisQueueGetJob.mockResolvedValue(mockWaitingJob);

      const result = await JobService.enqueueSynthesis(sessionId);

      expect(mockWaitingJob.getState).toHaveBeenCalled();
      expect(mockWaitingJob.remove).not.toHaveBeenCalled();
      expect(mockSynthesisQueueAdd).not.toHaveBeenCalled();
      expect(result).toBe(mockWaitingJob);
    });

    it("should remove stale job and re-enqueue when existing synthesis job is 'failed'", async () => {
      const mockFailedJob = {
        id: expectedJobId,
        getState: vi.fn().mockResolvedValue("failed"),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      mockSynthesisQueueGetJob.mockResolvedValue(mockFailedJob);
      const newJob = { id: expectedJobId, name: "SYNTHESIS" };
      mockSynthesisQueueAdd.mockResolvedValue(newJob);

      const result = await JobService.enqueueSynthesis(sessionId);

      expect(mockFailedJob.getState).toHaveBeenCalled();
      expect(mockFailedJob.remove).toHaveBeenCalled();
      expect(mockSynthesisQueueAdd).toHaveBeenCalledWith(
        "SYNTHESIS",
        expect.anything(),
        expect.objectContaining({ jobId: expectedJobId })
      );
      expect(result).toBe(newJob);
    });
  });
});
