import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { syncFileFromContainer } from "@/server/file-sync";
import { cookies } from "next/headers";

/**
 * POST /api/files/sync
 * Sync a file from Docker container back to Supabase
 */
export async function POST(req: NextRequest) {
    try {
        const cookieStore = await cookies();
        const supabase = createClient(cookieStore);

        // Authenticate user
        const {
            data: { user },
            error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 }
            );
        }

        // Parse request body
        const body = await req.json();
        const { projectId, filepath, content } = body;

        if (!projectId || !filepath || content === undefined) {
            return NextResponse.json(
                { error: "Missing required fields: projectId, filepath, content" },
                { status: 400 }
            );
        }

        // Verify user has access to project
        const { data: project, error: projectError } = await supabase
            .from("projects")
            .select("id, workspace_id")
            .eq("id", projectId)
            .single();

        if (projectError || !project) {
            return NextResponse.json(
                { error: "Project not found" },
                { status: 404 }
            );
        }

        // Check workspace membership
        const { data: member, error: memberError } = await supabase
            .from("workspace_members")
            .select("role")
            .eq("workspace_id", project.workspace_id)
            .eq("user_id", user.id)
            .single();

        if (memberError || !member) {
            return NextResponse.json(
                { error: "Access denied" },
                { status: 403 }
            );
        }

        // Sync file from container to Supabase
        const result = await syncFileFromContainer({
            projectId,
            filepath,
            content,
            userId: user.id,
        });

        if (!result.success) {
            return NextResponse.json(
                { error: result.error || "Failed to sync file" },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            message: `File ${filepath} synced successfully`,
        });
    } catch (error) {
        console.error("[api/files/sync] Error:", error);
        return NextResponse.json(
            {
                error:
                    error instanceof Error ? error.message : "Internal server error",
            },
            { status: 500 }
        );
    }
}
