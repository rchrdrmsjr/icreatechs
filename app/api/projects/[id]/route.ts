import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import * as Sentry from "@sentry/nextjs";
import { cache } from "@/lib/redis";

export const dynamic = "force-dynamic";

// Type for project updates in PATCH requests
type ProjectUpdate = Partial<{
  name: string;
  slug: string;
  description: string;
  language: string;
  framework: string;
  visibility: "public" | "private" | "team";
  settings: {
    installCommand?: string;
    devCommand?: string;
  };
}>;

// GET /api/projects/[id] - Get single project and update last_accessed_at
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "GET /api/projects/[id]",
    },
    async () => {
      try {
        const { id } = await params;
        const cookieStore = cookies();
        const supabase = createClient(cookieStore);

        // Get authenticated user
        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Get project with workspace info
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select(
            `
            *,
            workspaces!inner (
              id,
              name,
              slug,
              workspace_members!inner (
                user_id,
                role
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

        // Update last_accessed_at
        const { error: updateError } = await supabase
          .from("projects")
          .update({ last_accessed_at: new Date().toISOString() })
          .eq("id", id);

        if (updateError) {
          Sentry.captureException(updateError);
          // Don't fail the request if update fails
        }

        return NextResponse.json({ project });
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

// PATCH /api/projects/[id] - Update project
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "PATCH /api/projects/[id]",
    },
    async () => {
      try {
        const { id } = await params;
        const cookieStore = cookies();
        const supabase = createClient(cookieStore);

        // Get authenticated user
        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json();
        const { name, description, language, framework, visibility, settings } = body;

        // Verify user has access to project
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select(
            `
            id,
            settings,
            workspace_id,
            workspaces!inner (
              workspace_members!inner (
                user_id,
                role
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

        // Build update object
        const updates: ProjectUpdate = {};
        if (name !== undefined) {
          updates.name = name;
          updates.slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        }
        if (description !== undefined) updates.description = description;
        if (language !== undefined) updates.language = language;
        if (framework !== undefined) updates.framework = framework;
        if (visibility !== undefined) updates.visibility = visibility;
        if (settings !== undefined) {
          if (!settings || typeof settings !== "object") {
            return NextResponse.json(
              { error: "settings must be an object" },
              { status: 400 },
            );
          }
          const existingSettings = (project as { settings?: Record<string, unknown> })
            .settings ?? {};
          updates.settings = {
            ...existingSettings,
            ...settings,
          };
        }

        // Reject if no updatable fields provided
        if (Object.keys(updates).length === 0) {
          return NextResponse.json(
            { error: "No updatable fields provided" },
            { status: 400 },
          );
        }

        // Update project
        const { data: updatedProject, error: updateError } = await supabase
          .from("projects")
          .update(updates)
          .eq("id", id)
          .select()
          .single();

        if (updateError) {
          Sentry.captureException(updateError);
          return NextResponse.json(
            { error: "Failed to update project", details: updateError.message },
            { status: 500 },
          );
        }

        Sentry.logger.info("Project updated", {
          projectId: id,
          userId: user.id,
        });

        // Invalidate user's projects cache (best-effort)
        const cacheKey = `projects:user:${user.id}`;
        try {
          await cache.del(cacheKey);
          Sentry.logger.info("Projects cache invalidated", {
            userId: user.id,
            cacheKey,
          });
        } catch (cacheError) {
          Sentry.captureException(cacheError, {
            data: {
              userId: user.id,
              cacheKey,
              operation: "invalidate_user_projects_cache",
            },
          });
          Sentry.logger.error("Failed to invalidate projects cache", {
            userId: user.id,
            cacheKey,
            error:
              cacheError instanceof Error
                ? cacheError.message
                : String(cacheError),
          });
        }

        return NextResponse.json({ project: updatedProject });
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

// DELETE /api/projects/[id] - Delete project
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "DELETE /api/projects/[id]",
    },
    async () => {
      try {
        const { id } = await params;
        const cookieStore = cookies();
        const supabase = createClient(cookieStore);

        // Get authenticated user
        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Verify user has admin/owner access to project
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select(
            `
            id,
            workspace_id,
            workspaces!inner (
              workspace_members!inner (
                user_id,
                role
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

        // Check if user has admin or owner role
        const workspaceMembers = (
          project.workspaces as { workspace_members?: Array<{ role?: string }> }
        ).workspace_members ?? [];
        const memberRole = workspaceMembers[0]?.role;
        if (!["owner", "admin"].includes(memberRole)) {
          return NextResponse.json(
            { error: "You don't have permission to delete this project" },
            { status: 403 },
          );
        }

        // Delete project (cascade will handle related records)
        const { error: deleteError } = await supabase
          .from("projects")
          .delete()
          .eq("id", id);

        if (deleteError) {
          Sentry.captureException(deleteError);
          return NextResponse.json(
            { error: "Failed to delete project", details: deleteError.message },
            { status: 500 },
          );
        }

        Sentry.logger.info("Project deleted", {
          projectId: id,
          userId: user.id,
        });

        // Invalidate user's projects cache (best-effort)
        const cacheKey = `projects:user:${user.id}`;
        try {
          await cache.del(cacheKey);
          Sentry.logger.info("Projects cache invalidated", {
            userId: user.id,
            cacheKey,
          });
        } catch (cacheError) {
          Sentry.captureException(cacheError, {
            data: {
              userId: user.id,
              cacheKey,
              operation: "invalidate_user_projects_cache",
            },
          });
          Sentry.logger.error("Failed to invalidate projects cache", {
            userId: user.id,
            cacheKey,
            error:
              cacheError instanceof Error
                ? cacheError.message
                : String(cacheError),
          });
        }

        return NextResponse.json({ success: true });
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
