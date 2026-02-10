import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";

interface ExistingFilesToolOptions {
  projectId: string;
}

const inputSchema = z.object({
  paths: z.array(z.string()).min(1),
});

export const createExistingFilesTool = ({ projectId }: ExistingFilesToolOptions) =>
  tool({
    description: "Check which file paths already exist in the project.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ paths }) => {
      const supabase = createAdminClient();

      const { data, error } = await supabase
        .from("files")
        .select("id, name, type, parent_id, path")
        .eq("project_id", projectId)
        .eq("is_deleted", false)
        .in("path", paths);

      if (error) {
        return { error: error.message, existing: [] };
      }

      return {
        existing: (data ?? []).map((file) => ({
          id: file.id,
          name: file.name,
          type: file.type,
          parentId: file.parent_id ?? null,
          path: file.path,
        })),
      };
    },
  });
