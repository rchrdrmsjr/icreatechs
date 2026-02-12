"use client";

import { useState } from "react";
import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";

interface PreviewSettingsPopoverProps {
  projectId: string;
  initialValues?: {
    installCommand?: string;
    devCommand?: string;
  };
  onSave?: (settings: { installCommand?: string; devCommand?: string }) => void;
}

export const PreviewSettingsPopover = ({
  projectId,
  initialValues,
  onSave,
}: PreviewSettingsPopoverProps) => {
  const [open, setOpen] = useState(false);
  const [installCommand, setInstallCommand] = useState(
    initialValues?.installCommand ?? "",
  );
  const [devCommand, setDevCommand] = useState(
    initialValues?.devCommand ?? "",
  );
  const [saving, setSaving] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setInstallCommand(initialValues?.installCommand ?? "");
      setDevCommand(initialValues?.devCommand ?? "");
    }
    setOpen(nextOpen);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            installCommand: installCommand || undefined,
            devCommand: devCommand || undefined,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to save settings");
      }
      onSave?.({
        installCommand: installCommand || undefined,
        devCommand: devCommand || undefined,
      });
      setOpen(false);
    } catch (error) {
      console.error("Failed to save preview settings", error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-full rounded-none">
          <Settings className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-4">
          <div className="space-y-1">
            <h4 className="font-medium text-sm">Preview Settings</h4>
            <p className="text-xs text-muted-foreground">
              Configure how your project runs in the preview.
            </p>
          </div>
          <Field>
            <FieldLabel htmlFor="preview-install-command">
              Install Command
            </FieldLabel>
            <Input
              id="preview-install-command"
              value={installCommand}
              onChange={(event) => setInstallCommand(event.target.value)}
              placeholder="npm install"
            />
            <FieldDescription>Command to install dependencies</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="preview-dev-command">Start Command</FieldLabel>
            <Input
              id="preview-dev-command"
              value={devCommand}
              onChange={(event) => setDevCommand(event.target.value)}
              placeholder="npm run dev"
            />
            <FieldDescription>
              Command to start the development server
            </FieldDescription>
          </Field>
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
