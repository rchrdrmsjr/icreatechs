"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WebContainer } from "@webcontainer/api";

// Singleton WebContainer instance
let webcontainerInstance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;

const getWebContainer = async (): Promise<WebContainer> => {
  if (webcontainerInstance) {
    return webcontainerInstance;
  }

  if (!bootPromise) {
    bootPromise = WebContainer.boot({ coep: "credentialless" });
  }

  webcontainerInstance = await bootPromise;
  return webcontainerInstance;
};

const teardownWebContainer = () => {
  if (webcontainerInstance) {
    webcontainerInstance.teardown();
    webcontainerInstance = null;
  }
  bootPromise = null;
};

interface UseWebContainerProps {
  projectId: string;
  enabled: boolean;
  settings?: {
    installCommand?: string;
    devCommand?: string;
  };
  filesToSync?: Array<{ path: string; content: string }>;
}

export const useWebContainer = ({
  projectId,
  enabled,
  settings,
  filesToSync,
}: UseWebContainerProps) => {
  const [status, setStatus] = useState<
    "idle" | "booting" | "installing" | "running" | "error"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [restartKey, setRestartKey] = useState(0);

  const containerRef = useRef<WebContainer | null>(null);
  const hasStartedRef = useRef(false);

  const appendOutput = useCallback((data: string) => {
    setTerminalOutput((prev) => prev + data);
  }, []);

  useEffect(() => {
    if (!enabled || !projectId) return;
    if (hasStartedRef.current) return;

    hasStartedRef.current = true;
    let cancelled = false;

    const start = async () => {
      try {
        setStatus("booting");
        setError(null);
        setTerminalOutput("");

        const response = await fetch(`/api/projects/${projectId}/files/tree`);
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error ?? "Failed to load files");
        }

        const container = await getWebContainer();
        if (cancelled) return;
        containerRef.current = container;

        await container.mount(payload.tree ?? {});

        container.on("server-ready", (_port, url) => {
          setPreviewUrl(url);
          setStatus("running");
        });

        setStatus("installing");

        const installCmd = settings?.installCommand || "npm install";
        const [installBin, ...installArgs] = installCmd
          .split(" ")
          .filter(Boolean);
        appendOutput(`$ ${installCmd}\n`);
        const installProcess = await container.spawn(installBin, installArgs);
        installProcess.output.pipeTo(
          new WritableStream({
            write(data) {
              appendOutput(data);
            },
          }),
        );
        const installExitCode = await installProcess.exit;

        if (installExitCode !== 0) {
          throw new Error(`${installCmd} failed with code ${installExitCode}`);
        }

        const devCmd = settings?.devCommand || "npm run dev";
        const [devBin, ...devArgs] = devCmd.split(" ").filter(Boolean);
        appendOutput(`\n$ ${devCmd}\n`);
        const devProcess = await container.spawn(devBin, devArgs);
        devProcess.output.pipeTo(
          new WritableStream({
            write(data) {
              appendOutput(data);
            },
          }),
        );
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unknown error");
        setStatus("error");
      }
    };

    void start();

    return () => {
      cancelled = true;
    };
  }, [
    appendOutput,
    enabled,
    projectId,
    restartKey,
    settings?.devCommand,
    settings?.installCommand,
  ]);

  useEffect(() => {
    if (!enabled) {
      hasStartedRef.current = false;
      setStatus("idle");
      setPreviewUrl(null);
      setError(null);
      setTerminalOutput("");
    }
  }, [enabled, projectId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !filesToSync || filesToSync.length === 0) return;
    if (status === "idle" || status === "error") return;

    const write = async () => {
      for (const file of filesToSync) {
        if (!file.path) continue;
        try {
          await container.fs.writeFile(file.path, file.content ?? "");
        } catch (err) {
          console.warn("Failed to sync file to WebContainer", {
            path: file.path,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
    };

    void write();
  }, [filesToSync, status]);

  const restart = useCallback(() => {
    teardownWebContainer();
    containerRef.current = null;
    hasStartedRef.current = false;
    setStatus("idle");
    setPreviewUrl(null);
    setError(null);
    setTerminalOutput("");
    setRestartKey((key) => key + 1);
  }, []);

  return {
    status,
    previewUrl,
    error,
    terminalOutput,
    restart,
  };
};
