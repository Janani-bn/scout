import { Queue, Job } from "bullmq";
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
   * Helper to safely handle deterministic job enqueuing.
   * - If an existing job is in an active or queued/delayed state, returns the existing job to prevent duplicates.
   * - If an existing job has reached a terminal state ('failed' or 'completed'), removes the stale job so BullMQ accepts re-enqueuing.
   */
  private static async enqueueIdempotent(
    queue: Queue,
    name: string,
    payload: JobPayload,
    jobId: string
  ): Promise<Job> {
    try {
      const existingJob = await queue.getJob(jobId);
      if (existingJob) {
        const state = await existingJob.getState();

        // If the job is active or queued/delayed to run, do not remove or create duplicate work
        if (
          state === "active" ||
          state === "waiting" ||
          state === "delayed" ||
          state === "prioritized" ||
          state === "waiting-children"
        ) {
          console.log(
            `[Queue] Job ${jobId} already exists in '${state}' state. Skipping duplicate enqueue.`
          );
          return existingJob;
        }

        // For terminal states ('failed' or 'completed'), remove stale job to permit clean re-enqueue
        try {
          await existingJob.remove();
        } catch (removeErr: any) {
          console.warn(
            `[Queue] Warning: Could not remove stale job ${jobId} (state: ${state}): ${removeErr?.message}`
          );
        }
      }
    } catch (err: any) {
      console.warn(`[Queue] Non-critical error checking existing job ${jobId}: ${err?.message}`);
    }

    const job = await queue.add(name, payload, {
      jobId,
      attempts: env.RESEARCH_JOB_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: env.RESEARCH_JOB_BACKOFF_MS,
      },
    });

    return job;
  }

  /**
   * Enqueues a single research task job to be processed.
   * Utilizes task ID as deterministic job ID to prevent duplicate processing queues.
   */
  static async enqueueResearchTask(sessionId: string, taskId: string): Promise<Job> {
    const payload: JobPayload = {
      type: "RESEARCH_TASK",
      researchSessionId: sessionId,
      researchTaskId: taskId,
    };

    const jobId = `research_task_${taskId}`;
    console.log(`[Queue] Enqueuing RESEARCH_TASK job for task: ${taskId} (Session: ${sessionId})`);

    return this.enqueueIdempotent(researchQueue, "RESEARCH_TASK", payload, jobId);
  }

  /**
   * Enqueues the final report synthesis job.
   * Utilizes session ID as deterministic job ID to prevent duplicate synthesis tasks.
   */
  static async enqueueSynthesis(sessionId: string): Promise<Job> {
    const payload: JobPayload = {
      type: "SYNTHESIS",
      researchSessionId: sessionId,
    };

    const jobId = `synthesis_${sessionId}`;
    console.log(`[Queue] Enqueuing SYNTHESIS job for session: ${sessionId}`);

    return this.enqueueIdempotent(synthesisQueue, "SYNTHESIS", payload, jobId);
  }
}
