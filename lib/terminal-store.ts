import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TerminalSession = {
    sessionId: string;
    projectId: string;
    createdAt: number;
    lastActivity: number;
};

type TerminalStore = {
    // Map of projectId → sessionId
    sessions: Record<string, string>;

    // Get session for a project
    getSession: (projectId: string) => string | null;

    // Set session for a project
    setSession: (projectId: string, sessionId: string) => void;

    // Clear session for a project
    clearSession: (projectId: string) => void;

    // Clear all sessions
    clearAllSessions: () => void;
};

export const useTerminalStore = create<TerminalStore>()(
    persist(
        (set, get) => ({
            sessions: {},

            getSession: (projectId: string) => {
                return get().sessions[projectId] || null;
            },

            setSession: (projectId: string, sessionId: string) => {
                set((state) => ({
                    sessions: {
                        ...state.sessions,
                        [projectId]: sessionId,
                    },
                }));
            },

            clearSession: (projectId: string) => {
                set((state) => {
                    const { [projectId]: _, ...rest } = state.sessions;
                    return { sessions: rest };
                });
            },

            clearAllSessions: () => {
                set({ sessions: {} });
            },
        }),
        {
            name: 'terminal-sessions', // localStorage key
            partialize: (state) => ({ sessions: state.sessions }), // Only persist sessions
        }
    )
);
