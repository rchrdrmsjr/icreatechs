import React from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import Link from "next/link";
import { Navbar } from "@/components/navbar";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center px-4">
        <div className="max-w-3xl space-y-6 text-center">
          <h2 className="text-5xl font-bold tracking-tight">
            Build faster with AI-powered code editor
          </h2>
          <p className="text-lg text-muted-foreground">
            Write, edit, and ship production-ready code with intelligent
            completions, refactoring tools, and real-time collaboration.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link
              href="/auth/sign-up"
              className="rounded-md bg-foreground px-6 py-2.5 text-sm font-medium text-background hover:opacity-90"
            >
              Get started free
            </Link>
            <Link
              href="/docs"
              className="rounded-md border border-border px-6 py-2.5 text-sm font-medium hover:bg-accent"
            >
              Read the docs
            </Link>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-8">
        <div className="container mx-auto px-4 text-center text-xs text-muted-foreground">
          © 2026 MortarLab. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
