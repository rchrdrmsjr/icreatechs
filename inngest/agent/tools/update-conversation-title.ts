import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";

interface UpdateConversationTitleToolOptions {
  conversationId: string;
}

const inputSchema = z.object({
  title: z.string().min(1),
});

export const createUpdateConversationTitleTool = ({
  conversationId,
}: UpdateConversationTitleToolOptions) =>
  tool({
    description: "Update the current conversation title.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ title }) => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("conversations")
        .update({ title, updated_at: new Date().toISOString() })
        .eq("id", conversationId);

      if (error) {
        return { error: error.message };
      }

      return { updated: true, title };
    },
  });
