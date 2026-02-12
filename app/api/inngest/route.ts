import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import {
  helloWorld,
  generateAIText,
  generateGroqText,
  scrapeWebsite,
  scrapeAndAnalyze,
  processMessage,
  cleanupDeletedFiles,
} from "@/inngest/functions";

// Serve Inngest functions: helloWorld, generateAIText, generateGroqText, scrapeWebsite, scrapeAndAnalyze, processMessage, cleanupDeletedFiles
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    helloWorld,
    generateAIText,
    generateGroqText,
    scrapeWebsite,
    scrapeAndAnalyze,
    processMessage,
    cleanupDeletedFiles,
  ],
});
