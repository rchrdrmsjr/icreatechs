import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";
import { computeSizeBytes, findFileById } from "./helpers";

interface UpdateFileToolOptions {
  projectId: string;
}

const inputSchema = z.object({
  fileId: z.string().min(1),
  content: z.string(),
});

export const createUpdateFileTool = ({ projectId }: UpdateFileToolOptions) =>
  tool({
    description: "Update an existing file's content by ID.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ fileId, content }) => {
      const supabase = createAdminClient();
      const file = await findFileById(supabase, projectId, fileId);

      if (!file) {
        return { error: "File not found" };
      }

      if (file.type !== "file") {
        return { error: "Cannot update folders" };
      }

      const storagePath = file.storage_path ?? `${projectId}/${file.path}`;
      const fileBlob = new Blob([content], { type: "text/plain" });
      const storage = supabase.storage.from("project-files");

      const { error: uploadError } = await storage.upload(storagePath, fileBlob, {
        contentType: "text/plain",
        upsert: true,
      });

      if (uploadError) {
        return { error: uploadError.message };
      }

      const { error: updateError } = await supabase
        .from("files")
        .update({
          content: null,
          size_bytes: computeSizeBytes(content),
          storage_path: storagePath,
          updated_at: new Date().toISOString(),
        })
        .eq("id", fileId);

      if (updateError) {
        return { error: updateError.message };
      }

      return { updated: true, fileId };
    },
  });
