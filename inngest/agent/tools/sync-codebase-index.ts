import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";

interface SyncCodebaseIndexToolOptions {
  projectId: string;
}

export const createSyncCodebaseIndexTool = ({
  projectId,
}: SyncCodebaseIndexToolOptions) =>
  tool({
    description:
      "Refresh the codebase index and return the current file list for the project.",
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
