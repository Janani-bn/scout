import type { Job, Queue } from "bullmq";
import { researchQueue, synthesisQueue } from "../queues/research.queue";
import { env } from "../../config";
import type { JobPayload } from "../types/job.types";

/**
 * Service managing job dispatching and queue insertion operations.
 * Handles deterministic naming for idempotency and duplicate job prevention.
 *
 * NOTE: BullMQ job IDs must not contain colons (`:`). Underscores are used instead.
 */
export class JobService {
  /**
   * States where an existing job is still executable. Removing a job in one of
   * these states can orphan a running worker or run the same logical task
   * twice, so duplicate enqueue attempts must keep it instead of replacing it.
   */
  private static readonly LIVE_JOB_STATES = new Set([
    "active",
    "waiting",
    "delayed",
    "prioritized",
    "waiting-children",
  ]);

  /**
   * Decides what to do with an existing job that shares the deterministic ID.
   *
   * - Live jobs (active/waiting/delayed/...) are returned as-is: the enqueue
   *   request is already covered, so adding another copy would duplicate work.
   * - Completed/failed jobs are removed so an explicit retry can re-add them.
   * - If the lookup itself fails, we proceed to add(): BullMQ dedupes on jobId
   *   at insertion time, so a racing enqueue still results in a single job.
   */
  private static async resolveExistingJob(
    queue: Queue,
    jobId: string
  ): Promise<Job | null> {
    let existingJob: Job | undefined;
    try {
      existingJob = await queue.getJob(jobId);
    } catch {
      // Lookup failed — fall through to add(), BullMQ dedupes on jobId.
      return null;
    }

    if (!existingJob) {
      return null;
    }

    let state: string;
    try {
      state = await existingJob.getState();
    } catch {
      // Cannot prove the job is stale — treat it as live and keep it.
      return existingJob;
    }

    if (JobService.LIVE_JOB_STATES.has(state)) {
      return existingJob;
    }

    // Genuinely stale (completed/failed/unknown): safe to replace when the
    // caller explicitly re-enqueues for retry or recovery.
    try {
      await existingJob.remove();
    } catch {
      // A racing remove from another enqueue attempt is fine.
    }
    return null;
  }

  /**
   * Enqueues a single research task job to be processed.
   * Utilizes task ID as deterministic job ID to prevent duplicate processing queues.
   *
   * Idempotent: if a job with the same deterministic ID is still active,
   * waiting, or delayed, the live job is returned instead of being replaced.
   * Only completed/failed jobs are removed to allow an explicit retry.
   */
  static async enqueueResearchTask(sessionId: string, taskId: string) {
    const payload: JobPayload = {
      type: "RESEARCH_TASK",
      researchSessionId: sessionId,
      researchTaskId: taskId,
    };

    const jobId = `research_task_${taskId}`;

    const existingJob = await JobService.resolveExistingJob(researchQueue, jobId);
    if (existingJob) {
      console.log(`[Queue] RESEARCH_TASK job already in flight for task: ${taskId} (Session: ${sessionId}), skipping duplicate enqueue`);
      return existingJob;
    }

    console.log(`[Queue] Enqueuing RESEARCH_TASK job for task: ${taskId} (Session: ${sessionId})`);

    const job = await researchQueue.add(
      "RESEARCH_TASK",
      payload,
      {
        jobId, // Deterministic duplicate protection (no colons — BullMQ forbids them)
        attempts: env.RESEARCH_JOB_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: env.RESEARCH_JOB_BACKOFF_MS,
        },
      }
    );

    return job;
  }

  /**
   * Enqueues the final report synthesis job.
   * Utilizes session ID as deterministic job ID to prevent duplicate synthesis tasks.
   *
   * Follows the same idempotency semantics as enqueueResearchTask: live jobs
   * are preserved, completed/failed jobs may be replaced on explicit retry.
   */
  static async enqueueSynthesis(sessionId: string) {
    const payload: JobPayload = {
      type: "SYNTHESIS",
      researchSessionId: sessionId,
    };

    const jobId = `synthesis_${sessionId}`;

    const existingJob = await JobService.resolveExistingJob(synthesisQueue, jobId);
    if (existingJob) {
      console.log(`[Queue] SYNTHESIS job already in flight for session: ${sessionId}, skipping duplicate enqueue`);
      return existingJob;
    }

    console.log(`[Queue] Enqueuing SYNTHESIS job for session: ${sessionId}`);

    const job = await synthesisQueue.add(
      "SYNTHESIS",
      payload,
      {
        jobId, // Deterministic duplicate protection (no colons — BullMQ forbids them)
        attempts: env.RESEARCH_JOB_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: env.RESEARCH_JOB_BACKOFF_MS,
        },
      }
    );

    return job;
  }
}
