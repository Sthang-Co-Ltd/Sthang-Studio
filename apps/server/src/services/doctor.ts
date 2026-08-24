import fs from 'node:fs/promises';
import path from 'node:path';
import type { DoctorCheck, DoctorCheckStatus, SystemDoctorReport } from '@kcs/shared';
import { config, rootDir } from '../config.js';
import { runCommand } from './media.js';
import { resolveGeminiSettings } from './llm-settings.js';

function check(id: string, label: string, status: DoctorCheckStatus, detail: string, fix?: string): DoctorCheck {
  return { id, label, status, detail, fix };
}

async function writableDirectory(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  const testPath = path.join(dir, `.doctor-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(testPath, 'ok', 'utf8');
  await fs.rm(testPath, { force: true });
}

async function probe(command: string, args: string[], label: string) {
  try {
    const result = await runCommand(command, args, label, 12000);
    return { ok: true, text: (result.stdout || result.stderr).trim() };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

export async function runSystemDoctor(): Promise<SystemDoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(check('node', 'Node.js runtime', 'ok', process.version));

  const ffmpeg = await probe(config.ffmpegPath, ['-version'], 'FFmpeg probe');
  checks.push(ffmpeg.ok
    ? check('ffmpeg', 'FFmpeg', 'ok', ffmpeg.text.split(/\r?\n/)[0] || 'Available')
    : check('ffmpeg', 'FFmpeg', 'error', ffmpeg.text, 'Install FFmpeg or set FFMPEG_PATH in apps/server/.env.'));

  const ffprobe = await probe(config.ffprobePath, ['-version'], 'FFprobe probe');
  checks.push(ffprobe.ok
    ? check('ffprobe', 'FFprobe', 'ok', ffprobe.text.split(/\r?\n/)[0] || 'Available')
    : check('ffprobe', 'FFprobe', 'error', ffprobe.text, 'Install a complete FFmpeg package or set FFPROBE_PATH.'));

  const python = await probe(config.localTimingPython, ['--version'], 'Python timing runtime');
  checks.push(python.ok
    ? check('python', 'Python timing runtime', 'ok', python.text)
    : check('python', 'Python timing runtime', 'error', python.text, 'Run setup-local-timing-windows.bat.'));

  if (python.ok) {
    const pythonCheck = [
      'import importlib.util, json, os',
      "base=os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')",
      "model=os.path.join(base,'kfa','wav2vec2-km-base-1500.onnx')",
      "print(json.dumps({'kfa':bool(importlib.util.find_spec('kfa')),'whisper':bool(importlib.util.find_spec('faster_whisper')),'onnx':bool(importlib.util.find_spec('onnxruntime')),'model':os.path.exists(model),'model_path':model}))",
    ].join(';');
    const packages = await probe(config.localTimingPython, ['-c', pythonCheck], 'Local timing package probe');
    if (packages.ok) {
      try {
        const parsed = JSON.parse(packages.text) as { kfa: boolean; whisper: boolean; onnx: boolean; model: boolean; model_path: string };
        checks.push(parsed.kfa
          ? check('kfa', 'KFA Khmer aligner', 'ok', 'Python package installed')
          : check('kfa', 'KFA Khmer aligner', 'error', 'Python package is missing', 'Run setup-local-timing-windows.bat.'));
        checks.push(parsed.onnx
          ? check('onnx', 'ONNX Runtime', 'ok', 'Installed')
          : check('onnx', 'ONNX Runtime', 'error', 'Missing', 'Run setup-local-timing-windows.bat.'));
        checks.push(parsed.model
          ? check('kfa-model', 'KFA Khmer model', 'ok', parsed.model_path)
          : check('kfa-model', 'KFA Khmer model', 'warning', 'Not cached yet. It will download on first KFA import/generation.', 'Run the KFA import test or generate captions once while online.'));
        checks.push(parsed.whisper
          ? check('whisper', 'Local Whisper fallback', 'ok', 'Installed')
          : check('whisper', 'Local Whisper fallback', 'warning', 'Not installed. KFA can still work, but there is no local fallback.', 'Run setup-local-timing-windows.bat.'));
      } catch {
        checks.push(check('python-packages', 'Local timing packages', 'warning', `Could not parse package probe: ${packages.text}`));
      }
    } else {
      checks.push(check('python-packages', 'Local timing packages', 'error', packages.text, 'Run setup-local-timing-windows.bat.'));
    }
  }

  const llm = await resolveGeminiSettings();
  checks.push(llm.configured
    ? check('gemini-key', 'Gemini API key', 'ok', `Configured via ${llm.keySource === 'secure-store' ? 'Windows protected storage' : 'environment'} (value hidden)`)
    : check('gemini-key', 'Gemini API key', 'error', 'Not configured yet', 'Open Settings → AI connection and paste your Gemini API key.'));
  checks.push(check(
    'gemini-storage',
    'AI credential storage',
    llm.secureStorageAvailable ? 'ok' : 'warning',
    llm.secureStorageLabel,
    llm.secureStorageAvailable ? undefined : 'Use GEMINI_API_KEY in the server environment on this platform.',
  ));

  for (const [id, label, dir] of [
    ['uploads', 'Upload storage', config.uploadDir],
    ['cache', 'Stage cache storage', config.cacheDir],
    ['data', 'Project/profile storage', path.dirname(config.dataFile)],
    ['history', 'Project history storage', config.historyDir],
    ['proposals', 'Regeneration preview storage', config.proposalDir],
    ['jobs', 'Processing queue storage', path.dirname(config.jobsFile)],
  ] as const) {
    try {
      await writableDirectory(dir);
      checks.push(check(id, label, 'ok', dir));
    } catch (error) {
      checks.push(check(id, label, 'error', error instanceof Error ? error.message : String(error), 'Check folder permissions or move the app to a writable folder.'));
    }
  }

  checks.push(typeof Intl.Segmenter === 'function'
    ? check('segmenter', 'Khmer word segmenter', 'ok', 'Intl.Segmenter available')
    : check('segmenter', 'Khmer word segmenter', 'error', 'Intl.Segmenter is unavailable in this Node runtime', 'Install the current Node.js LTS release.'));

  const rank: Record<DoctorCheckStatus, number> = { ok: 0, warning: 1, error: 2 };
  const overall = checks.reduce<DoctorCheckStatus>((current, item) => rank[item.status] > rank[current] ? item.status : current, 'ok');

  return {
    generatedAt: new Date().toISOString(),
    engineVersion: '0.7.11',
    overall,
    checks,
    environment: {
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      appRoot: rootDir,
      apiPort: config.port,
      webOrigin: config.webOrigin,
    },
  };
}
