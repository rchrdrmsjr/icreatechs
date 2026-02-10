import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import * as Sentry from "@sentry/nextjs";
import { cache } from "@/lib/redis";

export const dynamic = "force-dynamic";

const normalizePath = (parentPath: string | null, name: string) => {
  const trimmedName = name.trim();
  const basePath = parentPath ? parentPath.replace(/\/+$|\/$/g, "") : "";
  return basePath ? `${basePath}/${trimmedName}` : trimmedName;
};

const createStorageClient = () => createAdminClient();

// GET /api/projects/[id]/files - List files for a project
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "GET /api/projects/[id]/files",
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
            {
              error: "Unauthorized",
              details: authError?.message,
            },
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
            {
              error: "Project not found or access denied",
              details: projectError?.message,
            },
            { status: 404 },
          );
        }

        const cacheKey = `project-files:${id}`;
        try {
          const cached = await cache.get(cacheKey);
          if (cached) {
            return NextResponse.json({ files: cached, cached: true });
          }
        } catch (cacheError) {
          Sentry.captureException(cacheError, {
            data: { operation: "project_files_cache_get", projectId: id },
          });
        }

        const { data: files, error: filesError } = await supabase
          .from("files")
          .select("id, name, type, parent_id, path")
          .eq("project_id", id)
          .eq("is_deleted", false);

        if (filesError) {
          Sentry.captureException(filesError);
          return NextResponse.json(
            { error: "Failed to fetch files", details: filesError.message },
            { status: 500 },
          );
        }

        try {
          await cache.set(cacheKey, files ?? [], 60);
        } catch (cacheError) {
          Sentry.captureException(cacheError, {
            data: { operation: "project_files_cache_set", projectId: id },
          });
        }

        return NextResponse.json({ files: files || [] });
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

// POST /api/projects/[id]/files - Create a file or folder in a project
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "POST /api/projects/[id]/files",
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
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json();
        const { name, type, parent_id, content } = body;

        if (!name || !type) {
          return NextResponse.json(
            { error: "name and type are required" },
            { status: 400 },
          );
        }

        if (type !== "file" && type !== "folder") {
          return NextResponse.json(
            { error: "type must be file or folder" },
            { status: 400 },
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

        let parentPath: string | null = null;
        if (parent_id) {
          const { data: parent, error: parentError } = await supabase
            .from("files")
            .select("id, path, type")
            .eq("id", parent_id)
            .eq("project_id", id)
            .single();

          if (parentError || !parent) {
            return NextResponse.json(
              { error: "Parent folder not found" },
              { status: 404 },
            );
          }

          if (parent.type !== "folder") {
            return NextResponse.json(
              { error: "Parent must be a folder" },
              { status: 400 },
            );
          }

          parentPath = parent.path;
        }

        const path = normalizePath(parentPath, name);
        const safeContent = type === "file" ? (content ?? null) : null;
        const sizeBytes =
          type === "file" && typeof safeContent === "string"
            ? new TextEncoder().encode(safeContent).length
            : null;

        let storagePath: string | null = null;
        const storageClient = createStorageClient();

        // Always store file contents in Supabase Storage.
        if (type === "file") {
          const storageFilePath = `${id}/${path}`;
          const fileBlob = new Blob([safeContent ?? ""], { type: "text/plain" });

          const { error: uploadError } = await storageClient.storage
            .from("project-files")
            .upload(storageFilePath, fileBlob, {
              contentType: "text/plain",
              upsert: true,
            });

          if (uploadError) {
            Sentry.captureException(uploadError);
            return NextResponse.json(
              { error: "Failed to upload file to storage", details: uploadError.message },
              { status: 500 },
            );
          }

          storagePath = storageFilePath;
        }

        const { data: file, error: createError } = await supabase
          .from("files")
          .insert({
            project_id: id,
            name: name.trim(),
            type,
            parent_id: parent_id || null,
            path,
            content: null,
            size_bytes: sizeBytes,
            storage_path: storagePath,
            created_by: user.id,
            updated_by: user.id,
          })
          .select()
          .single();

        if (createError) {
          const status = createError.code === "23505" ? 409 : 500;
          Sentry.captureException(createError);
          return NextResponse.json(
            { error: "Failed to create file", details: createError.message },
            { status },
          );
        }

        try {
          await cache.del(`project-files:${id}`);
        } catch (cacheError) {
          Sentry.captureException(cacheError, {
            data: { operation: "project_files_cache_invalidate", projectId: id },
          });
        }

        return NextResponse.json({ file }, { status: 201 });
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
