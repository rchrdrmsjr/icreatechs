import { inngest } from "./client";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { generateText, stepCountIs } from "ai";
import { NonRetriableError } from "inngest";
import { firecrawl } from "@/lib/firecrawl";
import { createTelemetryConfig } from "@/lib/telemetry-config";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  CODING_AGENT_SYSTEM_PROMPT,
  TITLE_GENERATOR_SYSTEM_PROMPT,
} from "@/inngest/agent/constants";
import {
  createCreateFilesTool,
  createCreateFileTool,
  createCreateFolderTool,
  createDeleteFileTool,
  createDeleteRecursiveTool,
  createExistingFilesTool,
  createGetFileByIdTool,
  createGetProjectsFilesTool,
  createGetRecentMessagesTool,
  createListFilesTool,
  createReadFilesTool,
  createRenameFileTool,
  createSyncCodebaseIndexTool,
  createUpdateConversationTitleTool,
  createUpdateFileTool,
} from "@/inngest/agent/tools";

export const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "test/hello.world" },
  async ({ event, step }) => {
    await step.sleep("wait-a-moment", "1s");
    return { message: `Hello ${event.data.email}!` };
  },
);

export const generateAIText = inngest.createFunction(
  { id: "generate-ai-text" },
  { event: "ai/generate.text" },
  async ({ event, step }) => {
    const { prompt, requestId } = event.data;

    // Step 1: Log the start
    await step.run("log-start", async () => {
      console.log(`Starting AI generation for request: ${requestId}`);
      return { status: "started" };
    });

    // Step 2: Generate text using Gemini 2.5 Flash
    const result = await step.run("generate-text", async () => {
      const { text, usage, finishReason } = await generateText({
        model: google("gemini-2.5-flash"),
        prompt: prompt,
        temperature: 0.7,
        experimental_telemetry: createTelemetryConfig(
          "inngest-gemini-background",
        ),
      });

      return {
        text,
        usage,
        finishReason,
        model: "gemini-2.5-flash",
      };
    });

    // Step 3: Log completion
    await step.run("log-completion", async () => {
      console.log(`Completed AI generation for request: ${requestId}`);
      return { status: "completed" };
    });

    return {
      requestId,
      success: true,
      data: result,
    };
  },
);

export const generateGroqText = inngest.createFunction(
  { id: "generate-groq-text" },
  { event: "ai/generate.groq" },
  async ({ event, step }) => {
    const { prompt, requestId } = event.data;

    // Step 1: Log the start
    await step.run("log-start", async () => {
      console.log(`Starting Groq AI generation for request: ${requestId}`);
      return { status: "started" };
    });

    // Step 2: Generate text using Groq (llama-3.3-70b-versatile)
    const result = await step.run("generate-text-groq", async () => {
      const { text, usage, finishReason } = await generateText({
        model: groq("llama-3.3-70b-versatile"),
        prompt: prompt,
        temperature: 0.7,
        experimental_telemetry: createTelemetryConfig(
          "inngest-groq-background",
        ),
      });

      return {
        text,
        usage,
        finishReason,
        model: "llama-3.3-70b-versatile",
        provider: "groq",
      };
    });

    // Step 3: Log completion
    await step.run("log-completion", async () => {
      console.log(`Completed Groq AI generation for request: ${requestId}`);
      return { status: "completed" };
    });

    return {
      requestId,
      success: true,
      data: result,
    };
  },
);

export const scrapeWebsite = inngest.createFunction(
  { id: "scrape-website" },
  { event: "firecrawl/scrape.url" },
  async ({ event, step }) => {
    const { url, requestId, formats = ["markdown"] } = event.data;

    // Step 1: Log the start
    await step.run("log-start", async () => {
      console.log(`Starting Firecrawl scraping for request: ${requestId}`);
      return { status: "started", url };
    });

    // Step 2: Scrape the URL using Firecrawl
    const result = await step.run("scrape-url", async () => {
      if (!process.env.FIRECRAWL_API_KEY) {
        throw new Error("FIRECRAWL_API_KEY is not configured");
      }

      try {
        const scrapeResult = await firecrawl.scrape(url, {
          formats: formats,
        });

        // Validate scrape result has content
        if (
          !scrapeResult.markdown &&
          !scrapeResult.html &&
          !scrapeResult.rawHtml
        ) {
          throw new Error(
            "Firecrawl returned no content in any requested format",
          );
        }

        return {
          ...scrapeResult,
          sourceUrl: url,
          scrapedAt: new Date().toISOString(),
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(`Firecrawl scrape failed for ${url}:`, errorMessage);
        throw new Error(`Failed to scrape URL: ${errorMessage}`);
      }
    });

    // Step 3: Log completion
    await step.run("log-completion", async () => {
      console.log(`Completed Firecrawl scraping for request: ${requestId}`);
      return { status: "completed" };
    });

    return {
      requestId,
      success: true,
      data: result,
    };
  },
);

export const scrapeAndAnalyze = inngest.createFunction(
  { id: "scrape-and-analyze" },
  { event: "ai/scrape.analyze" },
  async ({ event, step }) => {
    const {
      url,
      requestId,
      aiProvider = "gemini",
      analysisPrompt,
    } = event.data;

    // Validate aiProvider
    if (aiProvider !== "gemini" && aiProvider !== "groq") {
      throw new Error(
        `Invalid aiProvider: ${aiProvider}. Must be 'gemini' or 'groq'`,
      );
    }

    // Step 1: Scrape the URL with Firecrawl
    const scrapedData = await step.run("scrape-url", async () => {
      if (!process.env.FIRECRAWL_API_KEY) {
        throw new Error("FIRECRAWL_API_KEY is not configured");
      }

      console.log(`Scraping URL for request: ${requestId}`);

      try {
        const scrapeResult = await firecrawl.scrape(url, {
          formats: ["markdown"],
        });

        // Validate scrape result
        if (!scrapeResult.markdown) {
          throw new Error("Firecrawl returned no markdown content");
        }

        if (!scrapeResult.metadata) {
          throw new Error("Firecrawl returned no metadata");
        }

        return {
          markdown: scrapeResult.markdown,
          metadata: scrapeResult.metadata,
          sourceUrl: url,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(`Firecrawl scrape failed for ${url}:`, errorMessage);
        throw new Error(`Failed to scrape URL: ${errorMessage}`);
      }
    });

    // Step 2: Generate AI analysis
    const aiResult = await step.run("analyze-with-ai", async () => {
      console.log(
        `Analyzing content with ${aiProvider} for request: ${requestId}`,
      );

      const prompt = analysisPrompt
        ? `${analysisPrompt}\n\nContent:\n${scrapedData.markdown}`
        : `Please analyze and summarize the following content:\n\n${scrapedData.markdown}`;

      let text, usage, finishReason;

      if (aiProvider === "groq") {
        if (!process.env.GROQ_API_KEY) {
          throw new Error("GROQ_API_KEY is not configured");
        }
        const result = await generateText({
          model: groq("llama-3.3-70b-versatile"),
          prompt: prompt,
          temperature: 0.7,
          experimental_telemetry: createTelemetryConfig(
            "inngest-groq-scrape-analysis",
          ),
        });
        text = result.text;
        usage = result.usage;
        finishReason = result.finishReason;
      } else {
        // Default to Gemini
        if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
          throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not configured");
        }
        const result = await generateText({
          model: google("gemini-2.5-flash"),
          prompt: prompt,
          temperature: 0.7,
          experimental_telemetry: createTelemetryConfig(
            "inngest-gemini-scrape-analysis",
          ),
        });
        text = result.text;
        usage = result.usage;
        finishReason = result.finishReason;
      }

      return {
        analysis: text,
        usage,
        finishReason,
        model:
          aiProvider === "groq"
            ? "llama-3.3-70b-versatile"
            : "gemini-2.5-flash",
        provider: aiProvider,
      };
    });

    // Step 3: Log completion
    await step.run("log-completion", async () => {
      console.log(`Completed scrape and analyze for request: ${requestId}`);
      return { status: "completed" };
    });

    return {
      requestId,
      success: true,
      data: {
        scrapedData,
        aiResult,
      },
    };
  },
);

const GEMINI_MODELS = new Set(["gemini-2.5-flash", "gemini-2.0-flash"]);
const GROQ_MODELS = new Set([
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
]);

const DEFAULT_CONVERSATION_TITLE = "New conversation";

type ConversationMessageEvent = {
  messageId: string;
  conversationId: string;
  projectId: string;
  message: string;
  aiProvider?: "gemini" | "groq";
  model?: string | null;
};

const extractTextFromSteps = (steps: unknown) => {
  if (!Array.isArray(steps)) {
    return "";
  }

  for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    const step = steps[stepIndex] as { content?: unknown };
    if (!Array.isArray(step?.content)) {
      continue;
    }

    const content = step.content as Array<{ type?: unknown; text?: unknown }>;
    for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex -= 1) {
      const item = content[contentIndex];
      if (item?.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      if (typeof item?.text === "string") {
        return item.text;
      }
    }
  }

  return "";
};

export const processMessage = inngest.createFunction(
  {
    id: "process-message",
    cancelOn: [
      {
        event: "message/cancel",
        if: "event.data.messageId == async.data.messageId",
      },
    ],
    onFailure: async (context) => {
      const { event, step } = context;
      const error = (context as { error?: unknown }).error;
      const originalEvent = event.data.event as { data?: ConversationMessageEvent };
      const messageId = originalEvent?.data?.messageId;

      if (!messageId) {
        return;
      }

      const errorMessage = error instanceof Error ? error.message : "";
      const normalized = errorMessage.toLowerCase();
      let failureMessage =
        "Sorry, I ran into an error while processing that request. Please try again.";

      if (
        normalized.includes("quota") ||
        normalized.includes("rate limit") ||
        normalized.includes("billing")
      ) {
        failureMessage =
          "AI provider quota exceeded. Check billing or switch providers.";
      } else if (
        normalized.includes("api key") ||
        normalized.includes("not configured")
      ) {
        failureMessage = "AI provider API key is missing or invalid.";
      }

      const supabase = createAdminClient();
      await step.run("mark-message-failed", async () => {
        await supabase
          .from("messages")
          .update({
            status: "failed",
            content: failureMessage,
            updated_at: new Date().toISOString(),
          })
          .eq("id", messageId)
          .eq("status", "processing");
      });
    },
  },
  { event: "message/sent" },
  async ({ event, step }) => {
    const {
      messageId,
      conversationId,
      projectId,
      message,
      aiProvider = "gemini",
      model,
    } = event.data as ConversationMessageEvent;

    const supabase = createAdminClient();

    const provider = aiProvider === "groq" ? "groq" : "gemini";
    const selectedModel =
      provider === "groq"
        ? GROQ_MODELS.has(model ?? "")
          ? (model as string)
          : "llama-3.3-70b-versatile"
        : GEMINI_MODELS.has(model ?? "")
          ? (model as string)
          : "gemini-2.5-flash";

    if (provider === "groq" && !process.env.GROQ_API_KEY) {
      throw new NonRetriableError("GROQ_API_KEY is not configured");
    }

    if (provider === "gemini" && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new NonRetriableError("GOOGLE_GENERATIVE_AI_API_KEY is not configured");
    }

    const conversation = await step.run("get-conversation", async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, title")
        .eq("id", conversationId)
        .single();

      if (error) {
        throw error;
      }

      return data;
    });

    const recentMessages = await step.run("get-recent-messages", async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, role, content, status")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(12);

      if (error) {
        throw error;
      }

      return data ?? [];
    });

    const contextMessages = recentMessages.filter(
      (msg) => msg.id !== messageId && msg.content?.trim(),
    );

    const historyText = contextMessages
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join("\n\n");

    let systemPrompt = CODING_AGENT_SYSTEM_PROMPT;
    if (historyText) {
      systemPrompt += `\n\n## Previous Conversation (for context only - do NOT repeat these responses):\n${historyText}\n\n## Current Request:\nRespond ONLY to the user's new message below. Do not repeat or reference your previous responses.`;
    }
    systemPrompt +=
      "\n\nIf you need a fresh view of the codebase, call syncCodebaseIndex before making changes.";

    if (conversation?.title === DEFAULT_CONVERSATION_TITLE) {
      const title = await step.run("generate-title", async () => {
        try {
          const { text } = await generateText({
            model:
              provider === "groq"
                ? groq("llama-3.1-8b-instant")
                : google("gemini-2.0-flash"),
            system: TITLE_GENERATOR_SYSTEM_PROMPT,
            prompt: message,
            temperature: 0,
            experimental_telemetry: createTelemetryConfig(
              provider === "groq"
                ? "groq-title-generator"
                : "gemini-title-generator",
            ),
          });

          return text.trim().replace(/^"|"$/g, "");
        } catch (error) {
          console.error("Failed to generate conversation title", error);
          return null;
        }
      });

      if (title) {
        await step.run("update-conversation-title", async () => {
          await supabase
            .from("conversations")
            .update({ title, updated_at: new Date().toISOString() })
            .eq("id", conversationId);
        });
      }
    }

    const tools = {
      listFiles: createListFilesTool({ projectId }),
      syncCodebaseIndex: createSyncCodebaseIndexTool({ projectId }),
      readFiles: createReadFilesTool({ projectId }),
      createFile: createCreateFileTool({ projectId }),
      createFiles: createCreateFilesTool({ projectId }),
      createFolder: createCreateFolderTool({ projectId }),
      updateFile: createUpdateFileTool({ projectId }),
      renameFile: createRenameFileTool({ projectId }),
      deleteFile: createDeleteFileTool({ projectId }),
      deleteRecursive: createDeleteRecursiveTool({ projectId }),
      existingFiles: createExistingFilesTool({ projectId }),
      getProjectsFiles: createGetProjectsFilesTool({ projectId }),
      getFileById: createGetFileByIdTool({ projectId }),
      getRecentMessages: createGetRecentMessagesTool({ conversationId }),
      updateConversationTitle: createUpdateConversationTitleTool({
        conversationId,
      }),
    };

    const { text, usage, totalUsage, steps } = await step.run(
      "generate-response",
      async () => {
      return await generateText({
        model:
          provider === "groq"
            ? groq(selectedModel)
            : google(selectedModel),
        system: systemPrompt,
        prompt: message,
        tools,
        stopWhen: stepCountIs(12),
        temperature: 0.3,
        experimental_telemetry: createTelemetryConfig(
          provider === "groq" ? "groq-conversation" : "gemini-conversation",
        ),
      });
    },
    );

    const primaryText = typeof text === "string" ? text : "";
    const stepText = extractTextFromSteps(steps);
    console.log("[processMessage] generate-response output", {
      messageId,
      conversationId,
      provider,
      model: selectedModel,
      hasText: Boolean(primaryText.trim()),
      stepsCount: Array.isArray(steps) ? steps.length : 0,
      stepTextLength: stepText.length,
    });
    const responseText =
      primaryText.trim() ||
      stepText.trim() ||
      "I processed your request. Let me know if you need anything else.";

    await step.run("update-assistant-message", async () => {
      await supabase
        .from("messages")
        .update({
            content: responseText,
            status: "completed",
            model: selectedModel,
            tokens_used: totalUsage?.totalTokens ?? usage?.totalTokens ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", messageId)
          .eq("status", "processing");
      });

    await step.run("touch-conversation", async () => {
      await supabase
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", conversationId);
    });

    return { success: true, messageId, conversationId, projectId };
  },
);
