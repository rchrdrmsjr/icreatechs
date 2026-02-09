import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import * as Sentry from "@sentry/nextjs";

import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

const AI_REQUEST_TIMEOUT_MS = 20000;

type MessagePayload = {
  conversationId: string;
  message: string;
  aiProvider?: "gemini" | "groq";
  model?: string;
};

// POST /api/messages - Send a message to a conversation
export async function POST(request: NextRequest) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "POST /api/messages",
    },
    async () => {
      const cookieStore = cookies();
      const supabase = createClient(cookieStore);
      let assistantMessageId: string | null = null;

      try {
        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = (await request.json()) as MessagePayload;
        const conversationId = body?.conversationId;
        const message = body?.message?.trim();

        if (!conversationId || !message) {
          return NextResponse.json(
            { error: "conversationId and message are required" },
            { status: 400 },
          );
        }

        const { data: conversation, error: conversationError } = await supabase
          .from("conversations")
          .select(
            `
            id,
            project_id,
            projects!inner (
              id,
              workspaces!inner (
                workspace_members!inner (
                  user_id
                )
              )
            )
          `,
          )
          .eq("id", conversationId)
          .eq("projects.workspaces.workspace_members.user_id", user.id)
          .single();

        if (conversationError || !conversation) {
          return NextResponse.json(
            { error: "Conversation not found or access denied" },
            { status: 404 },
          );
        }

        const { data: processingMessages } = await supabase
          .from("messages")
          .select("id")
          .eq("conversation_id", conversationId)
          .eq("status", "processing");

        if (processingMessages && processingMessages.length > 0) {
          await supabase
            .from("messages")
            .update({ status: "cancelled", updated_at: new Date().toISOString() })
            .in(
              "id",
              processingMessages.map((msg) => msg.id),
            );
        }

        const { error: userMessageError } = await supabase.from("messages").insert({
          conversation_id: conversationId,
          role: "user",
          content: message,
          status: "completed",
        });

        if (userMessageError) {
          Sentry.captureException(userMessageError);
          return NextResponse.json(
            { error: "Failed to save user message" },
            { status: 500 },
          );
        }

        const { data: assistantMessage, error: assistantError } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversationId,
            role: "assistant",
            content: "",
            status: "processing",
          })
          .select("id")
          .single();

        if (assistantError || !assistantMessage) {
          Sentry.captureException(assistantError);
          return NextResponse.json(
            { error: "Failed to create assistant message" },
            { status: 500 },
          );
        }

        assistantMessageId = assistantMessage.id;

        await supabase
          .from("conversations")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", conversationId);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);

        let aiPayload: unknown;
        let aiResponse: Response;

        try {
          aiResponse = await fetch(new URL("/api/demo/blocking", request.url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: message }),
            signal: controller.signal,
          });

          aiPayload = await aiResponse.json();
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            throw new Error("AI request timed out");
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }

        if (!aiResponse.ok) {
          const payload = aiPayload as { error?: string } | null;
          throw new Error(payload?.error ?? "AI request failed");
        }

        const payloadData = aiPayload as {
          data?: { text?: string; response?: string; model?: string; usage?: { totalTokens?: number } };
        };

        const responseText =
          payloadData?.data?.text ??
          payloadData?.data?.response ??
          "I processed your request. Let me know if you need anything else.";

        const { error: updateError } = await supabase
          .from("messages")
          .update({
            content: responseText,
            status: "completed",
            model: payloadData?.data?.model ?? null,
            tokens_used: payloadData?.data?.usage?.totalTokens ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", assistantMessageId)
          .eq("status", "processing");

        if (updateError) {
          throw updateError;
        }

        return NextResponse.json({
          success: true,
          messageId: assistantMessage.id,
        });
      } catch (error) {
        if (assistantMessageId) {
          const { data: currentMessage } = await supabase
            .from("messages")
            .select("status")
            .eq("id", assistantMessageId)
            .maybeSingle();

          if (currentMessage?.status !== "cancelled") {
            await supabase
              .from("messages")
              .update({
                status: "failed",
                content: "Sorry, I ran into an error. Please try again.",
                updated_at: new Date().toISOString(),
              })
              .eq("id", assistantMessageId)
              .eq("status", "processing");
          }
        }

        Sentry.captureException(error);
        return NextResponse.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    },
  );
}
