import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";

interface GetRecentMessagesToolOptions {
  conversationId: string;
}

const inputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

export const createGetRecentMessagesTool = ({
  conversationId,
}: GetRecentMessagesToolOptions) =>
  tool({
    description: "Get recent messages for the current conversation.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ limit }) => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("messages")
        .select("id, role, content, status, created_at, updated_at, model")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(limit ?? 10);

      if (error) {
        return { error: error.message, messages: [] };
      }

      const messages = (data ?? []).slice().reverse();
      return { messages };
    },
  });
