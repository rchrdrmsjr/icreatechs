import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";
import {
  findFileByPath,
  loadParentPath,
  normalizeParentId,
  normalizePath,
} from "./helpers";

interface CreateFolderToolOptions {
  projectId: string;
}

const inputSchema = z.object({
  name: z.string().min(1),
  parentId: z.string().nullable().optional(),
});

export const createCreateFolderTool = ({ projectId }: CreateFolderToolOptions) =>
  tool({
    description: "Create a folder in the project. Returns the folder ID and path.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ name, parentId }) => {
      const supabase = createAdminClient();
      const resolvedParentId = normalizeParentId(parentId);
      const parentPath = await loadParentPath(
        supabase,
        projectId,
        resolvedParentId,
      );
      const path = normalizePath(parentPath, name);

      const existing = await findFileByPath(supabase, projectId, path);
      if (existing) {
        return { status: "exists", folder: existing };
      }

      const { data: folder, error } = await supabase
        .from("files")
        .insert({
          project_id: projectId,
          name: name.trim(),
          type: "folder",
          parent_id: resolvedParentId,
          path,
          content: null,
          size_bytes: null,
          storage_path: null,
        })
        .select("id, name, type, parent_id, path")
        .single();

      if (error) {
        return { error: error.message };
      }

      return { status: "created", folder };
    },
  });
