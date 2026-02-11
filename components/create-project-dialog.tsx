"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import * as Sentry from "@sentry/nextjs";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectCreated: () => void;
}

interface Workspace {
  id: string;
  name: string;
  slug: string;
}

/**
 * Dialog component for creating a new project
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onProjectCreated,
}: CreateProjectDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("");
  const [framework, setFramework] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);

  // Fetch workspaces when dialog opens
  useEffect(() => {
    if (open) {
      fetchWorkspaces();
    }
  }, [open]);

  const fetchWorkspaces = async () => {
    try {
      setLoadingWorkspaces(true);
      const response = await fetch("/api/workspaces");

      if (!response.ok) {
        throw new Error("Failed to fetch workspaces");
      }

      const data = await response.json();
      setWorkspaces(data.workspaces || []);

      // Auto-select first workspace if available
      if (data.workspaces && data.workspaces.length > 0) {
        setWorkspaceId(data.workspaces[0].id);
      }
    } catch (err) {
      Sentry.captureException(err);
      setError("Failed to load workspaces");
    } finally {
      setLoadingWorkspaces(false);
    }
  };

  const handleCreateDefaultWorkspace = async () => {
    try {
      setCreatingWorkspace(true);
      setError(null);

      const response = await fetch("/api/workspaces/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "My Workspace",
          description: "Default workspace",
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to create workspace");
      }

      const data = await response.json();
      setWorkspaces([data.workspace]);
      setWorkspaceId(data.workspace.id);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to create workspace";
      setError(errorMessage);
      Sentry.captureException(err);
    } finally {
      setCreatingWorkspace(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    return Sentry.startSpan(
      {
        op: "ui.action",
        name: "Create Project",
      },
      async (span) => {
        span.setAttribute("projectName", name);
        span.setAttribute("language", language);

        try {
          setLoading(true);
          setError(null);

          const response = await fetch("/api/projects", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name,
              description: description || null,
              workspace_id: workspaceId,
              language: language || null,
              framework: framework || null,
              visibility,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "Failed to create project");
          }

          const data = await response.json();

          Sentry.logger.info("Project created successfully", {
            projectId: data.project.id,
            projectName: name,
          });

          // Reset form
          setName("");
          setDescription("");
          setLanguage("");
          setFramework("");
          setVisibility("private");

          onProjectCreated();
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : "Failed to create project";
          setError(errorMessage);
          Sentry.captureException(err);
        } finally {
          setLoading(false);
        }
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-125">
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
          <DialogDescription>
            Set up a new project to start coding
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {loadingWorkspaces ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : workspaces.length === 0 ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4">
                <h3 className="font-semibold mb-2">No Workspace Found</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  You need a workspace to create projects. Click below to create
                  your first workspace.
                </p>
                <Button
                  type="button"
                  onClick={handleCreateDefaultWorkspace}
                  disabled={creatingWorkspace}
                  className="w-full"
                >
                  {creatingWorkspace && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Create My Workspace
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="workspace">Workspace</Label>
                <Select
                  value={workspaceId}
                  onValueChange={setWorkspaceId}
                  required
                >
                  <SelectTrigger id="workspace">
                    <SelectValue placeholder="Select a workspace" />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Project Name *</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Awesome Project"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What's this project about?"
                  rows={3}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="language">Language</Label>
                  <Select value={language} onValueChange={setLanguage}>
                    <SelectTrigger id="language">
                      <SelectValue placeholder="Select language" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="javascript">JavaScript</SelectItem>
                      <SelectItem value="typescript">TypeScript</SelectItem>
                      <SelectItem value="python">Python</SelectItem>
                      <SelectItem value="java">Java</SelectItem>
                      <SelectItem value="go">Go</SelectItem>
                      <SelectItem value="rust">Rust</SelectItem>
                      <SelectItem value="php">PHP</SelectItem>
                      <SelectItem value="ruby">Ruby</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="framework">Framework</Label>
                  <Select value={framework} onValueChange={setFramework}>
                    <SelectTrigger id="framework">
                      <SelectValue placeholder="Select framework" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="nextjs">Next.js</SelectItem>
                      <SelectItem value="react">React</SelectItem>
                      <SelectItem value="vue">Vue</SelectItem>
                      <SelectItem value="angular">Angular</SelectItem>
                      <SelectItem value="express">Express</SelectItem>
                      <SelectItem value="django">Django</SelectItem>
                      <SelectItem value="flask">Flask</SelectItem>
                      <SelectItem value="laravel">Laravel</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="visibility">Visibility</Label>
                <Select value={visibility} onValueChange={setVisibility}>
                  <SelectTrigger id="visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">Private</SelectItem>
                    <SelectItem value="team">Team</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {error && (
                <div className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={loading}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={loading || !name || !workspaceId}
                >
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create Project
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
