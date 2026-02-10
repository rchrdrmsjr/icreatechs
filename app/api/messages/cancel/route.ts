import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import * as Sentry from "@sentry/nextjs";

import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { inngest } from "@/inngest/client";

export const dynamic = "force-dynamic";

// POST /api/messages/cancel - Cancel processing messages in a project
export async function POST(request: NextRequest) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "POST /api/messages/cancel",
    },
    async () => {
      try {
        const cookieStore = cookies();
        const supabase = createClient(cookieStore);

        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json();
        const projectId = body?.projectId;

        if (!projectId) {
          return NextResponse.json(
            { error: "projectId is required" },
            { status: 400 },
          );
        }

        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select(
            `
            id,
            workspaces!inner (
              workspace_members!inner (
                user_id
              )
            )
          `,
          )
          .eq("id", projectId)
          .eq("workspaces.workspace_members.user_id", user.id)
          .single();

        if (projectError || !project) {
          return NextResponse.json(
            { error: "Project not found or access denied" },
            { status: 404 },
          );
        }

        const { data: conversations, error: conversationsError } = await supabase
          .from("conversations")
          .select("id")
          .eq("project_id", projectId);

        if (conversationsError) {
          Sentry.captureException(conversationsError);
          return NextResponse.json(
            { error: "Failed to load conversations" },
            { status: 500 },
          );
        }

        const conversationIds = (conversations ?? []).map((c) => c.id);

        if (conversationIds.length === 0) {
          return NextResponse.json({ success: true, cancelled: false });
        }

        const adminClient = createAdminClient();
        const { data: processingMessages, error: processingError } = await adminClient
          .from("messages")
          .select("id")
          .in("conversation_id", conversationIds)
          .eq("status", "processing");

        if (processingError) {
          Sentry.captureException(processingError);
          return NextResponse.json(
            { error: "Failed to load processing messages" },
            { status: 500 },
          );
        }

        if (!processingMessages || processingMessages.length === 0) {
          return NextResponse.json({ success: true, cancelled: false });
        }

        const messageIds = processingMessages.map((msg) => msg.id);

        const { error: updateError, status: updateStatus } = await adminClient
          .from("messages")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .in("id", messageIds);

        if (updateError || (updateStatus && updateStatus >= 400)) {
          console.error("Failed to cancel processing messages", {
            error: updateError,
            status: updateStatus,
          });
          Sentry.captureException(
            updateError ??
              new Error(
                `Failed to cancel processing messages (status ${updateStatus})`,
              ),
          );
          return NextResponse.json(
            { error: "Failed to cancel messages" },
            { status: 500 },
          );
        }

        await Promise.all(
          processingMessages.map(async (msg) => {
            await inngest.send({
              name: "message/cancel",
              data: { messageId: msg.id },
            });
          }),
        );

        return NextResponse.json({
          success: true,
          cancelled: true,
          messageIds,
        });
      } catch (error) {
        Sentry.captureException(error);
        return NextResponse.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    },
  );
}
