export const systemMessages = {
  description: "Checks the app, media tools, caption timing, AI connection, and local storage. The report excludes your API key.",
  empty: "No report yet",
  help: "Run checks after setup or if caption generation fails.",
  running: "Running checks…",
  retry: "Retry system check",
  run: "Run checks",
  complete: "System check complete.",
  copy: "Copy diagnostic report",
  checking: "Checking system…",
  checkingWithReport: "Checking system… The last loaded report remains below.",
  failure: "System check could not finish.",
  failureWithReport: "<b>{error}</b> The last loaded report is shown. Try the check again.",
  failureWithoutReport: "<b>{error}</b> No report is available yet. Try the check again.",
  overall: {
    ok: "System checks passed",
    warning: "Ready with warnings",
    error: "Setup needs attention",
  },
  stale: "Last loaded report · {summary}",
  environment: "{date} · {platform} · Node {node}",
  check: {
    node: "Node.js runtime",
    ffmpeg: "FFmpeg",
    "ffmpeg-ass": "FFmpeg native subtitle filter",
    ffprobe: "FFprobe",
    python: "Python timing runtime",
    kfa: "KFA Khmer aligner",
    onnx: "ONNX Runtime",
    "kfa-model": "KFA Khmer model",
    whisper: "Local Whisper fallback",
    "python-packages": "Local timing packages",
    "gemini-key": "Gemini API key",
    "gemini-storage": "AI credential storage",
    uploads: "Upload storage",
    cache: "Stage cache storage",
    data: "Project/profile storage",
    history: "Project history storage",
    proposals: "Regeneration preview storage",
    jobs: "Processing queue storage",
    "project-readability": "Saved project readability",
    segmenter: "Khmer word segmenter",
  },
  timingFix: {
    win32: "Run Install Sthang Studio.bat again from your download, or run setup-local-timing-windows.bat in the Studio folder. Then run the System check again.",
    darwin: "In the Studio folder, run bash ./setup-local-timing-macos.sh. Then run the System check again.",
    other: "Install the local timing Python dependencies for this platform.",
  },
} as const;

export function doctorCheckKey(id: string) {
  if (Object.hasOwn(systemMessages.check, id)) {
    return `system.check.${id as keyof typeof systemMessages.check}` as const;
  }
}

const timingCheckIds = new Set(['python', 'python-packages', 'kfa', 'kfa-model', 'onnx', 'whisper']);

export function doctorTimingFixKey(id: string, environmentPlatform: string, fix?: string) {
  if (!fix || !timingCheckIds.has(id)) return undefined;
  const [platform] = environmentPlatform.split(' ', 1);
  const platformKey = platform === 'win32' || platform === 'darwin' ? platform : 'other';
  if (fix === systemMessages.timingFix[platformKey]) return `system.timingFix.${platformKey}` as const;
}
