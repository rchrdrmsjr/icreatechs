import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";
import { findFileById } from "./helpers";

interface GetFileByIdToolOptions {
  projectId: string;
}

const inputSchema = z.object({
  fileId: z.string().min(1),
});

export const createGetFileByIdTool = ({ projectId }: GetFileByIdToolOptions) =>
  tool({
    description: "Get file metadata by ID.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ fileId }) => {
      const supabase = createAdminClient();
      const file = await findFileById(supabase, projectId, fileId);

      if (!file) {
        return { error: "File not found" };
      }

      return { file };
    },
  });
