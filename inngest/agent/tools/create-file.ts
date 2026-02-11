import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";
import {
  computeSizeBytes,
  findFileByPath,
  loadParentPath,
  normalizeParentId,
  normalizePath,
} from "./helpers";

interface CreateFileToolOptions {
  projectId: string;
}

const inputSchema = z.object({
  name: z.string().min(1),
  parentId: z.string().nullable().optional(),
  content: z.string().optional(),
});

export const createCreateFileTool = ({ projectId }: CreateFileToolOptions) =>
  tool({
    description:
      "Create a new file in the project. If the file already exists, use updateFile instead.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ name, parentId, content }) => {
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
        return { status: "exists", file: existing };
      }

      const fileContent = content ?? "";
      const storagePath = `${projectId}/${path}`;
      const fileBlob = new Blob([fileContent], { type: "text/plain" });

      const storageClient = supabase.storage.from("project-files");
      const { error: uploadError } = await storageClient.upload(
        storagePath,
        fileBlob,
        {
          contentType: "text/plain",
          upsert: true,
        },
      );

      if (uploadError) {
        return { error: uploadError.message, path };
      }

      const { data: created, error } = await supabase
        .from("files")
        .insert({
          project_id: projectId,
          name: name.trim(),
          type: "file",
          parent_id: resolvedParentId,
          path,
          content: null,
          size_bytes: computeSizeBytes(fileContent),
          storage_path: storagePath,
        })
        .select("id, name, type, parent_id, path, storage_path")
        .single();

      if (error) {
        const { error: removeError } = await storageClient.remove([
          storagePath,
        ]);
        if (removeError) {
          console.warn("[createFile] cleanup failed", {
            projectId,
            path,
            storagePath,
            error: removeError.message,
          });
        }
        return { error: error.message, path };
      }

      return { status: "created", file: created };
    },
  });
