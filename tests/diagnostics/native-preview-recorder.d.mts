import type { spawn } from 'node:child_process';

export interface NativePreviewDiagnostics {
  starts: number;
  frames: number;
  fallbacks: number;
  assWrites: number;
  sessionDirectories: number;
  workers: number;
}

export interface NativePreviewChildSummary {
  id: number;
  startMs: number;
  writes: number;
  inputBytes: number;
  completeSeedWrites: number;
  stdoutChunks: number;
  stdoutBytes: number;
  stderrChunks: number;
  stderrBytes: number;
  captionBboxes: number;
  focusBboxes: number;
  truncatedStderrChunks: number;
  stdoutFirstMs?: number;
  stdoutLastMs?: number;
  stderrFirstMs?: number;
  stderrLastMs?: number;
  exit?: { ms: number; code: number | null; signal: string | null };
  close?: { ms: number; code: number | null; signal: string | null };
  lastKill?: { ms: number; signal: string | null };
}

export interface NativePreviewRecorderSnapshot {
  schema: 1;
  children: NativePreviewChildSummary[];
  events: Array<{ ms: number; event: string; [key: string]: unknown }>;
  omittedEvents: number;
  omittedChildren: number;
}

export interface NativePreviewRecorder {
  wrapSpawn(original: typeof spawn): typeof spawn;
  checkpoint(phase: string, testName: string, diagnostics: Partial<NativePreviewDiagnostics>): void;
  snapshot(): NativePreviewRecorderSnapshot;
  flush(write: (text: string) => void): void;
}

export function createNativePreviewRecorder(options?: { now?: () => number }): NativePreviewRecorder;

export function installNativePreviewRecorder(
  file: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    processObject?: Pick<NodeJS.Process, 'pid' | 'once'>;
    childProcessObject?: { spawn: typeof spawn };
    sync?: () => void;
  },
): NativePreviewRecorder | null;
