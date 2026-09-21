import { vi, describe, it, expect, beforeEach } from "vitest";
import { SynthesisAgent } from "../synthesis.agent";
import { AgentContext } from "../../core/agent.types";

// Mock prisma so ReportContextBuilder can execute naturally
vi.mock("../../../lib/prisma", () => {
  return {
    prisma: {
      researchSession: {
        findUnique: vi.fn(),
      },
      source: {
        findMany: vi.fn(),
      },
      claim: {
        findMany: vi.fn(),
      },
    },
  };
});

import { prisma } from "../../../lib/prisma";

describe("SynthesisAgent Citation Validation", () => {
  let agent: SynthesisAgent;
  let mockContext: AgentContext;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new SynthesisAgent();

    // Create a strict AgentContext
    mockContext = {
      researchSessionId: "session-123",
      researchTaskId: "task-1",
      query: "test"
    } as unknown as AgentContext;

    // Mock standard session context
    vi.mocked(prisma.researchSession.findUnique).mockResolvedValue({
      id: "session-123",
      query: "Test query",
      title: "Test session",
      description: "",
      tasks: [{ status: "COMPLETED" }],
    } as unknown as Awaited<ReturnType<typeof prisma.researchSession.findUnique>>);
  });

  it("should preserve valid citations from sources outside the top 25", async () => {
    // 1. Mock 25 base sources (top 25)
    const baseSources = Array.from({ length: 25 }, (_, i) => ({
      id: `source-${i + 1}`,
      title: `Source ${i + 1}`,
      url: `http://example.com/${i + 1}`,
      credibilityScore: 0.9,
    }));

    vi.mocked(prisma.source.findMany).mockResolvedValue(
      baseSources as unknown as Awaited<ReturnType<typeof prisma.source.findMany>>
    );

    // 2. Mock a supported claim that references source-26
    vi.mocked(prisma.claim.findMany).mockImplementation(((args: unknown) => {
      const query = args as { where?: { status?: string } };
      if (query?.where?.status === "SUPPORTED") {
        return Promise.resolve([
          {
            id: "claim-1",
            content: "Battery lasts 10 hours",
            evidence: [
              {
                evidence: {
                  source: {
                    id: "source-26",
                    title: "Source 26",
                    url: "http://example.com/26",
                    credibilityScore: 0.8,
                  },
                },
              },
            ],
          },
        ]);
      }
      return Promise.resolve([]);
    }) as unknown as typeof prisma.claim.findMany);

    // 3. Mock LLM provider to return citations using source-26
    // @ts-ignore - bypassing protected getProvider for testing
    agent.getProvider = () => ({
      generateStructured: async <T>() => ({
        title: "Test Report",
        executiveSummary: "Summary",
        researchQuestion: "Test",
        methodology: {
          overview: "Test",
          tasksCompleted: 1,
          tasksFailed: 0,
          sourcesAnalyzed: 26
        },
        keyFindings: [
          {
            finding: "Battery lasts 10 hours",
            confidence: 0.9,
            citations: ["source-26"],
          },
        ],
        detailedAnalysis: [],
        contradictions: [],
        limitations: [],
        conclusion: "Conclusion",
      } as unknown as T),
    });

    const result = await agent.execute(mockContext);

    expect(result.success).toBe(true);
    const report = JSON.parse(result.output);

    // Validation MUST preserve source-26 because it was in the evidence
    expect(report.keyFindings[0].citations).toContain("source-26");
  });

  it("should preserve valid citation from one of the top 25 sources", async () => {
    const baseSources = Array.from({ length: 25 }, (_, i) => ({
      id: `source-${i + 1}`,
      title: `Source ${i + 1}`,
      url: `http://example.com/${i + 1}`,
      credibilityScore: 0.9,
    }));

    vi.mocked(prisma.source.findMany).mockResolvedValue(
      baseSources as unknown as Awaited<ReturnType<typeof prisma.source.findMany>>
    );

    vi.mocked(prisma.claim.findMany).mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof prisma.claim.findMany>>
    );

    // @ts-ignore
    agent.getProvider = () => ({
      generateStructured: async <T>() => ({
        title: "Test Report",
        executiveSummary: "Summary",
        researchQuestion: "Test",
        methodology: {
          overview: "Test",
          tasksCompleted: 1,
          tasksFailed: 0,
          sourcesAnalyzed: 25
        },
        keyFindings: [
          {
            finding: "Something",
            confidence: 0.9,
            citations: ["source-5"],
          },
        ],
        detailedAnalysis: [],
        contradictions: [],
        limitations: [],
        conclusion: "Conclusion",
      } as unknown as T),
    });

    const result = await agent.execute(mockContext);
    const report = JSON.parse(result.output);
    expect(report.keyFindings[0].citations).toContain("source-5");
  });

  it("should remove fabricated/unknown citation", async () => {
    const baseSources = Array.from({ length: 25 }, (_, i) => ({
      id: `source-${i + 1}`,
      title: `Source ${i + 1}`,
      url: `http://example.com/${i + 1}`,
      credibilityScore: 0.9,
    }));

    vi.mocked(prisma.source.findMany).mockResolvedValue(
      baseSources as unknown as Awaited<ReturnType<typeof prisma.source.findMany>>
    );

    vi.mocked(prisma.claim.findMany).mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof prisma.claim.findMany>>
    );

    // @ts-ignore
    agent.getProvider = () => ({
      generateStructured: async <T>() => ({
        title: "Test Report",
        executiveSummary: "Summary",
        researchQuestion: "Test",
        methodology: {
          overview: "Test",
          tasksCompleted: 1,
          tasksFailed: 0,
          sourcesAnalyzed: 25
        },
        keyFindings: [
          {
            finding: "Fabricated",
            confidence: 0.9,
            citations: ["fake-uuid-999"],
          },
        ],
        detailedAnalysis: [],
        contradictions: [],
        limitations: [],
        conclusion: "Conclusion",
      } as unknown as T),
    });

    const result = await agent.execute(mockContext);
    const report = JSON.parse(result.output);
    expect(report.keyFindings[0].citations).not.toContain("fake-uuid-999");
    expect(report.keyFindings[0].citations.length).toBe(0);
  });

  it("should not create duplicate allowable citations for duplicate source references", async () => {
    const baseSources = [
      { id: "source-1", title: "Source 1", url: "http://example.com/1", credibilityScore: 0.9 }
    ];

    vi.mocked(prisma.source.findMany).mockResolvedValue(
      baseSources as unknown as Awaited<ReturnType<typeof prisma.source.findMany>>
    );

    vi.mocked(prisma.claim.findMany).mockImplementation(((args: unknown) => {
      const query = args as { where?: { status?: string } };
      if (query?.where?.status === "SUPPORTED") {
        return Promise.resolve([
          {
            id: "claim-1",
            content: "Battery lasts 10 hours",
            evidence: [
              { evidence: { source: { id: "source-26", title: "Source 26", url: "url" } } },
              { evidence: { source: { id: "source-26", title: "Source 26", url: "url" } } },
            ],
          },
        ]);
      }
      return Promise.resolve([]);
    }) as unknown as typeof prisma.claim.findMany);

    let capturedSystemPrompt = "";

    // @ts-ignore
    agent.getProvider = () => ({
      generateStructured: async <T>(opts: unknown) => {
        const options = opts as { messages: { role: string; content: string }[] };
        const userMsg = options.messages.find((m) => m.role === "user");
        if (userMsg) {
          capturedSystemPrompt = userMsg.content;
        }

        return {
          title: "Test",
          executiveSummary: "",
          researchQuestion: "",
          methodology: {
            overview: "",
            tasksCompleted: 0,
            tasksFailed: 0,
            sourcesAnalyzed: 0
          },
          keyFindings: [],
          detailedAnalysis: [],
          contradictions: [],
          limitations: [],
          conclusion: ""
        } as unknown as T;
      },
    });

    await agent.execute(mockContext);

    const matches = capturedSystemPrompt.match(/"id": "source-26"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });
});
