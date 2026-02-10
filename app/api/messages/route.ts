import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import * as Sentry from "@sentry/nextjs";

import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { inngest } from "@/inngest/client";

export const dynamic = "force-dynamic";

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

        const adminClient = createAdminClient();

        const { data: processingMessages } = await adminClient
          .from("messages")
          .select("id")
          .eq("conversation_id", conversationId)
          .eq("status", "processing");

        if (processingMessages && processingMessages.length > 0) {
          await adminClient
            .from("messages")
            .update({ status: "cancelled", updated_at: new Date().toISOString() })
            .in(
              "id",
              processingMessages.map((msg) => msg.id),
            );
        }

        const { error: userMessageError } = await adminClient.from("messages").insert({
          conversation_id: conversationId,
          role: "user",
          content: message,
          status: "completed",
        });

        if (userMessageError) {
          Sentry.captureException(userMessageError);
          return NextResponse.json(
            {
              error: "Failed to save user message",
              details: userMessageError.message,
            },
            { status: 500 },
          );
        }

        const { data: assistantMessage, error: assistantError } = await adminClient
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

        await adminClient
          .from("conversations")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", conversationId);

        await inngest.send({
          name: "message/sent",
          data: {
            messageId: assistantMessageId,
            conversationId,
            projectId: conversation.project_id,
            message,
            aiProvider: body.aiProvider ?? "gemini",
            model: body.model ?? null,
          },
        });

        return NextResponse.json({
          success: true,
          messageId: assistantMessage.id,
        });
      } catch (error) {
        if (assistantMessageId) {
          const adminClient = createAdminClient();
          const { data: currentMessage } = await adminClient
            .from("messages")
            .select("status")
            .eq("id", assistantMessageId)
            .maybeSingle();

          if (currentMessage?.status !== "cancelled") {
            await adminClient
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
