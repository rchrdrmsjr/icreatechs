import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import * as Sentry from "@sentry/nextjs";

import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { cache } from "@/lib/redis";
import { buildFileTree } from "@/lib/preview/file-tree";

export const dynamic = "force-dynamic";

type FileRow = {
  id: string;
  path: string;
  type: "file" | "folder";
  content: string | null;
  storage_path: string | null;
};

// GET /api/projects/[id]/files/tree - Get file tree with contents
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "GET /api/projects/[id]/files/tree",
    },
    async () => {
      try {
        const { id } = await params;
        const cookieStore = await cookies();
        const supabase = createClient(cookieStore);

        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          return NextResponse.json(
            { error: "Unauthorized", details: authError?.message },
            { status: 401 },
          );
        }

        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select(
            `
            id,
            workspaces!inner (
              workspace_members!inner (
                user_id
              )
            )
          `,
          )
          .eq("id", id)
          .eq("workspaces.workspace_members.user_id", user.id)
          .single();

        if (projectError || !project) {
          return NextResponse.json(
            { error: "Project not found or access denied" },
            { status: 404 },
          );
        }

        const cacheKey = `project-files-tree:${id}`;
        try {
          const cached = await cache.get(cacheKey);
          if (cached) {
            return NextResponse.json(cached);
          }
        } catch (cacheError) {
          Sentry.captureException(cacheError, {
            data: { operation: "project_files_tree_cache_get", projectId: id },
          });
        }

        const adminClient = createAdminClient();
        const { data: files, error: filesError } = await adminClient
          .from("files")
          .select("id, path, type, content, storage_path")
          .eq("project_id", id)
          .eq("is_deleted", false);

        if (filesError) {
          Sentry.captureException(filesError);
          return NextResponse.json(
            { error: "Failed to fetch files", details: filesError.message },
            { status: 500 },
          );
        }

        const storage = adminClient.storage.from("project-files");

        const hydratedFiles = await Promise.all(
          (files ?? []).map(async (file) => {
            if (file.type !== "file") {
              return {
                id: file.id,
                path: file.path,
                type: file.type,
                content: null,
              };
            }

            if (file.content !== null && file.content !== undefined) {
              return {
                id: file.id,
                path: file.path,
                type: file.type,
                content: file.content,
              };
            }

            if (file.storage_path) {
              const { data, error: downloadError } = await storage.download(
                file.storage_path,
              );
              if (downloadError || !data) {
                Sentry.captureException(downloadError);
                return {
                  id: file.id,
                  path: file.path,
                  type: file.type,
                  content: "",
                };
              }
              const text = await data.text();
              return {
                id: file.id,
                path: file.path,
                type: file.type,
                content: text,
              };
            }

            return {
              id: file.id,
              path: file.path,
              type: file.type,
              content: "",
            };
          }),
        );

        const tree = buildFileTree(hydratedFiles as FileRow[]);
        const payload = {
          files: hydratedFiles,
          tree,
        };

        try {
          await cache.set(cacheKey, payload, 30);
        } catch (cacheError) {
          Sentry.captureException(cacheError, {
            data: { operation: "project_files_tree_cache_set", projectId: id },
          });
        }

        return NextResponse.json(payload);
      } catch (error) {
        Sentry.captureException(error);
        return NextResponse.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    },
  );
}
