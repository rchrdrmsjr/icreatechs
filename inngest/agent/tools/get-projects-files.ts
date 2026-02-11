import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";

interface GetProjectsFilesToolOptions {
  projectId: string;
}

export const createGetProjectsFilesTool = ({
  projectId,
}: GetProjectsFilesToolOptions) =>
  tool({
    description: "Get all files for the current project.",
    inputSchema: zodSchema(z.object({}).nullable().optional()),
    execute: async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("files")
        .select("id, name, type, parent_id, path")
        .eq("project_id", projectId)
        .eq("is_deleted", false);

      if (error) {
        return { error: error.message };
      }

      return {
        files: (data ?? []).map((file) => ({
          id: file.id,
          name: file.name,
          type: file.type,
          parentId: file.parent_id ?? null,
          path: file.path,
        })),
      };
    },
  });
