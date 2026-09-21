import { ResearchSessionExecutionService } from "../../services/research-session-execution.service";
import { Worker } from "bullmq";
import { prisma } from "../../lib/prisma";
import { getRedisConnection } from "../queues/research.queue";
import { ResearchExecutionService } from "../../services/research-execution.service";
import { JobService } from "../services/job.service";
import { env } from "../../config";
import type { ResearchTaskJobPayload } from "../types/job.types";

/**
 * Main job execution handler for RESEARCH_TASK jobs.
 * Extracted as a named export to allow clean unit/integration testing without Redis.
 */
export const researchTaskJobHandler = async (job: any) => {
  if (job.name !== "RESEARCH_TASK") {
    return;
  }

  const { researchSessionId, researchTaskId } = job.data as ResearchTaskJobPayload;

  console.log(`[Worker] Started RESEARCH_TASK job ${job.id} for Task: ${researchTaskId} (Session: ${researchSessionId}) - Attempt #${job.attemptsMade + 1}`);

  // 1. Validate payload and entities
  const task = await prisma.researchTask.findUnique({
    where: { id: researchTaskId },
  });

  if (!task) {
    console.error(`[Worker] Non-retryable error: ResearchTask ${researchTaskId} not found in database.`);
    return; // Do not retry if entity does not exist
  }

  // 2. Prevent duplicate execution of completed tasks
  if (task.status === "COMPLETED") {
    console.log(`[Worker] Task ${researchTaskId} is already COMPLETED. Skipping execution.`);
    return;
  }

  // 3. Delegate execution to the core pipeline service
  try {
    await ResearchExecutionService.executeTask(researchSessionId, researchTaskId);
    console.log(`[Worker] Successfully completed RESEARCH_TASK: ${researchTaskId}`);
  } catch (err: any) {
    console.error(`[Worker] Attempt #${job.attemptsMade + 1} failed for Task: ${researchTaskId}. Error: ${err.message}`);
    throw err; // Re-throw to let BullMQ handle attempts/retries
  }

  // 4. Post-Task Completion Checks: Check if all tasks in the session are finished
  await ResearchSessionExecutionService.evaluateSessionTerminalState(researchSessionId);
};

/**
 * Worker processing RESEARCH_TASK jobs from the queue.
 */
export const researchTaskWorker = new Worker(
  "research-queue",
  researchTaskJobHandler,
  {
    connection: getRedisConnection(),
    concurrency: env.RESEARCH_WORKER_CONCURRENCY,
  }
);



// Log worker events for observability
researchTaskWorker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} of type ${job.name} completed successfully.`);
});

researchTaskWorker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} of type ${job?.name} failed permanently. Error: ${err.message}`);
});
