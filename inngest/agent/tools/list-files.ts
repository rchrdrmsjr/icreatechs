import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";

interface ListFilesToolOptions {
  projectId: string;
}

export const createListFilesTool = ({ projectId }: ListFilesToolOptions) =>
  tool({
    description:
      "List all files and folders in the project. Returns names, IDs, types, parentId, and path for each item.",
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

      const sorted = (data ?? []).sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "folder" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      return {
        files: sorted.map((file) => ({
          id: file.id,
          name: file.name,
          type: file.type,
          parentId: file.parent_id ?? null,
          path: file.path,
        })),
      };
    },
  });
