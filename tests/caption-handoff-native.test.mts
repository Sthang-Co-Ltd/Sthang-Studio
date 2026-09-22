import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  DEFAULT_CAPTION_APPEARANCE,
  serializeCaptionFile,
  type CaptionSegment,
} from '@kcs/shared';

// Independent native-format validation only: isolated synthetic files, no app/server,
// API keys, models, network, private media, or font staging.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-caption-handoff-native-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';

const { config } = await import('../apps/server/src/config.js');
const { createStoreZip } = await import('../apps/server/src/services/caption-handoff.js');
const { buildAssDocument } = await import('../apps/server/src/services/caption-renderer.js');

after(() => fs.rm(root, { recursive: true, force: true }));

function native(command: string, args: string[]) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function ffmpegToSrt(file: string) {
  return native(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', file,
    '-map', '0:s:0',
    '-c:s', 'srt',
    '-f', 'srt',
    '-',
  ]);
}

function ffprobePackets(file: string) {
  const raw = native(config.ffprobePath, [
    '-v', 'error',
    '-select_streams', 's:0',
    '-show_entries', 'packet=pts_time,duration_time',
    '-of', 'json',
    file,
  ]);
  return (JSON.parse(raw) as { packets?: Array<{ pts_time?: string; duration_time?: string }> }).packets || [];
}

function pythonRuntime() {
  const candidates: Array<{ command: string; prefix: string[] }> = process.env.STHANG_TEST_PYTHON
    ? [{ command: process.env.STHANG_TEST_PYTHON, prefix: [] }]
    : process.platform === 'win32'
      ? [{ command: 'py', prefix: ['-3.12'] }]
      : [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, '-I', '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'], {
      cwd: root,
      windowsHide: true,
      timeout: 10_000,
    });
    if (!probe.error && probe.status === 0 && probe.signal === null) return candidate;
  }
  throw new Error('Python 3.10+ is required for native caption handoff parser tests. Set STHANG_TEST_PYTHON or install the supported Python 3.12 runtime.');
}

const python = pythonRuntime();
function runPython(script: string, args: string[]) {
  return execFileSync(python.command, [...python.prefix, '-I', '-B', '-c', script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

const plainCaption: CaptionSegment = {
  id: 'plain-over-hour',
  startMs: 3_661_234.4,
  endMs: 3_663_456.6,
  text: 'ខ្មែរ 😀 CapCut 2026',
  timingSource: 'manual',
  timingQuality: 'high',
};

const wordText = 'ខ្មែរ CapCut';
const latinStart = wordText.indexOf('CapCut');
const wordCaption: CaptionSegment = {
  id: 'word-over-hour',
  startMs: 3_661_200.1,
  endMs: 3_662_300.9,
  text: wordText,
  timingSource: 'manual',
  timingQuality: 'high',
  wordTiming: {
    version: 1,
    text: wordText,
    words: [
      { id: 'khmer', startOffset: 0, endOffset: latinStart - 1, startMs: 3_661_300.2, endMs: 3_661_500.2, source: 'manual' },
      { id: 'latin', startOffset: latinStart, endOffset: wordText.length, startMs: 3_661_700.7, endMs: 3_662_000.9, source: 'manual' },
    ],
  },
};

async function writeSubtitle(name: string, contents: string) {
  const file = path.join(root, name);
  await fs.writeFile(file, contents, 'utf8');
  return file;
}

test('FFmpeg/ffprobe independently parse SRT, VTT, word gaps and the actual ASS document beyond one hour', async () => {
  const plainInput = { captions: [plainCaption], durationMs: 3_664_000.25 };
  const srt = serializeCaptionFile(plainInput, 'srt');
  const vtt = serializeCaptionFile(plainInput, 'vtt');
  const wordSrt = serializeCaptionFile({ captions: [wordCaption], durationMs: 3_664_000.25 }, 'word-srt');
  const wordVtt = serializeCaptionFile({ captions: [wordCaption], durationMs: 3_664_000.25 }, 'word-vtt');

  for (const serialized of [srt, vtt, wordSrt, wordVtt]) {
    assert.ok(serialized.warnings.some((warning) => warning.code === 'timing-rounded-to-millisecond'));
  }

  const srtFile = await writeSubtitle('captions.srt', srt.text);
  const vttFile = await writeSubtitle('captions.vtt', vtt.text);
  const wordSrtFile = await writeSubtitle('captions-word.srt', wordSrt.text);
  const wordVttFile = await writeSubtitle('captions-word.vtt', wordVtt.text);

  for (const file of [srtFile, vttFile]) {
    const decoded = ffmpegToSrt(file);
    assert.match(decoded, /01:01:01,234 --> 01:01:03,457/);
    assert.match(decoded, /ខ្មែរ 😀 CapCut 2026/);
  }

  for (const file of [wordSrtFile, wordVttFile]) {
    const decoded = ffmpegToSrt(file);
    assert.match(decoded, /ខ្មែរ/);
    assert.match(decoded, /CapCut/);
    const packets = ffprobePackets(file);
    assert.equal(packets.length, 2);
    const firstStart = Number(packets[0].pts_time) * 1000;
    const firstDuration = Number(packets[0].duration_time) * 1000;
    const secondStart = Number(packets[1].pts_time) * 1000;
    assert.equal(Math.round(firstStart), 3_661_300);
    assert.equal(Math.round(secondStart), 3_661_701);
    assert.equal(Math.round(secondStart - (firstStart + firstDuration)), 201, 'word-level silence gap must survive native parsing');
  }

  const assText = buildAssDocument(
    [plainCaption],
    { ...DEFAULT_CAPTION_APPEARANCE, highlightMode: 'off', backgroundEnabled: false },
    1920,
    1080,
  );
  const assFile = await writeSubtitle('captions-styled.ass', assText);
  const decodedAss = ffmpegToSrt(assFile);
  assert.match(decodedAss, /01:01:01,230 --> 01:01:03,460/);
  assert.match(decodedAss, /ខ្មែរ 😀 CapCut 2026/);

  const tree = await fs.readdir(root);
  assert.equal(tree.some((name) => /\.(?:ttf|otf|ttc)$/i.test(name)), false, 'ASS parser test must not stage or generate fonts');
});

test('ElementTree parses TTML with exact Khmer/emoji/XML characters and line breaks while Caption data keeps fractional milliseconds', async () => {
  const text = 'ខ្មែរ 😀 & <CapCut>\nជួរទី២ > test';
  const cue: CaptionSegment = { ...plainCaption, id: 'xml', text };
  const input = { captions: [cue], durationMs: 3_664_000.25 };
  const ttml = serializeCaptionFile(input, 'ttml');
  const data = serializeCaptionFile(input, 'data');
  const ttmlFile = await writeSubtitle('captions.ttml', ttml.text);

  const parsed = JSON.parse(runPython(String.raw`
import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
ns = {'t': 'http://www.w3.org/ns/ttml'}
p = root.find('.//t:p', ns)
if p is None:
    raise RuntimeError('TTML paragraph missing')
parts = [p.text or '']
for child in list(p):
    if child.tag == '{http://www.w3.org/ns/ttml}br':
        parts.append('\n')
    else:
        parts.extend(child.itertext())
    parts.append(child.tail or '')
sys.stdout.buffer.write((json.dumps({'begin': p.attrib['begin'], 'end': p.attrib['end'], 'text': ''.join(parts)}, ensure_ascii=False) + '\n').encode('utf-8'))
`, [ttmlFile])) as { begin: string; end: string; text: string };

  assert.deepEqual(parsed, {
    begin: '01:01:01.234',
    end: '01:01:03.457',
    text,
  });
  const portable = JSON.parse(data.text) as { durationMs: number; captions: Array<{ startMs: number; endMs: number; text: string }> };
  assert.equal(portable.durationMs, 3_664_000.25);
  assert.equal(portable.captions[0].startMs, 3_661_234.4);
  assert.equal(portable.captions[0].endMs, 3_663_456.6);
  assert.equal(portable.captions[0].text, text);
});

test('Python zipfile validates STORE central directory, CRCs, UTF-8 flags and exact generated entry bytes', async () => {
  const plainInput = { captions: [plainCaption], durationMs: 3_664_000.25 };
  const wordInput = { captions: [wordCaption], durationMs: 3_664_000.25 };
  const generated = [
    ['captions.srt', serializeCaptionFile(plainInput, 'srt').text],
    ['captions.vtt', serializeCaptionFile(plainInput, 'vtt').text],
    ['captions-word-by-word.srt', serializeCaptionFile(wordInput, 'word-srt').text],
    ['captions-word-by-word.vtt', serializeCaptionFile(wordInput, 'word-vtt').text],
    ['captions.ttml', serializeCaptionFile(plainInput, 'ttml').text],
    ['caption-data.json', serializeCaptionFile(plainInput, 'data').text],
    ['captions-styled.ass', buildAssDocument([plainCaption], { ...DEFAULT_CAPTION_APPEARANCE, highlightMode: 'off' }, 1920, 1080)],
  ] as const;
  const zip = createStoreZip(generated.map(([name, contents]) => ({ name, contents })));
  const zipFile = path.join(root, 'handoff.zip');
  await fs.writeFile(zipFile, zip);

  const report = JSON.parse(runPython(String.raw`
import json, sys, zipfile, zlib
with zipfile.ZipFile(sys.argv[1], 'r') as archive:
    rows = []
    for info in archive.infolist():
        data = archive.read(info.filename)  # zipfile verifies the stored CRC while reading.
        rows.append({
            'name': info.filename,
            'method': info.compress_type,
            'utf8': bool(info.flag_bits & 0x800),
            'crc_ok': (zlib.crc32(data) & 0xffffffff) == info.CRC,
            'contents': data.decode('utf-8'),
        })
sys.stdout.buffer.write((json.dumps(rows, ensure_ascii=False) + '\n').encode('utf-8'))
`, [zipFile])) as Array<{ name: string; method: number; utf8: boolean; crc_ok: boolean; contents: string }>;

  assert.deepEqual(report.map((row) => row.name), generated.map(([name]) => name));
  assert.ok(report.every((row) => row.method === 0), 'all bundle entries must use ZIP STORE');
  assert.ok(report.every((row) => row.utf8), 'all central-directory entries must carry the UTF-8 flag');
  assert.ok(report.every((row) => row.crc_ok), 'Python must independently validate every entry CRC');
  assert.deepEqual(report.map((row) => row.contents), generated.map(([, contents]) => contents));
});
