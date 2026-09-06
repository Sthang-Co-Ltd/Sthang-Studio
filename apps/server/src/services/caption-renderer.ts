import fs from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeCaptionAppearance, captionRenderTime, wrapCaptionText, planCaptionRenderStates,
  type CaptionAppearance, type CaptionSegment, type VideoExportFontCapability,
} from '@kcs/shared';

interface LocalCaptionFont extends VideoExportFontCapability {
  regularPath: string;
  boldPath?: string;
}

async function candidateFont(name: string, regularPath: string, boldPath?: string, source: VideoExportFontCapability['source'] = 'windows-system') {
  const available = await fs.stat(regularPath).then((stat) => stat.isFile()).catch(() => false);
  const boldAvailable = boldPath ? await fs.stat(boldPath).then((stat) => stat.isFile()).catch(() => false) : false;
  return { name, available, boldAvailable, source, regularPath, boldPath } satisfies LocalCaptionFont;
}

export async function fontCapabilities() {
  const fonts: LocalCaptionFont[] = [];
  if (process.platform === 'win32') {
    const windows = process.env.WINDIR || 'C:\\Windows';
    const systemFonts = path.join(windows, 'Fonts');
    fonts.push(await candidateFont('Khmer UI', path.join(systemFonts, 'KhmerUI.ttf'), path.join(systemFonts, 'KhmerUIB.ttf')));
    fonts.push(await candidateFont('DaunPenh', path.join(systemFonts, 'Daunpenh.ttf')));
    fonts.push(await candidateFont('MoolBoran', path.join(systemFonts, 'Moolbor.ttf')));
    const userFonts = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts');
    if (process.env.LOCALAPPDATA) {
      try {
        const names = await fs.readdir(userFonts);
        const regular = names.find((name) => /^NotoSansKhmer(?:-Regular)?\.(?:ttf|otf)$/i.test(name));
        const bold = names.find((name) => /^NotoSansKhmer-Bold\.(?:ttf|otf)$/i.test(name));
        if (regular) fonts.push(await candidateFont('Noto Sans Khmer', path.join(userFonts, regular), bold ? path.join(userFonts, bold) : undefined, 'user-installed'));
      } catch { /* optional user font directory */ }
    }
  } else {
    const linuxCandidates = [
      ['/usr/share/fonts/truetype/noto/NotoSansKhmer-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSansKhmer-Bold.ttf'],
      ['/usr/share/fonts/opentype/noto/NotoSansKhmer-Regular.ttf', '/usr/share/fonts/opentype/noto/NotoSansKhmer-Bold.ttf'],
    ];
    for (const [regular, bold] of linuxCandidates) {
      const item = await candidateFont('Noto Sans Khmer', regular, bold, 'linux-system');
      if (item.available) { fonts.push(item); break; }
    }
  }
  return fonts.filter((font, index, all) => all.findIndex((item) => item.name === font.name) === index);
}

/** Reject a changed typeface/weight rather than quietly restyling a creator's work. */
export function requireCaptionFont(fonts: VideoExportFontCapability[], appearance: CaptionAppearance) {
  const font = fonts.find((item) => item.name === appearance.fontFamily && item.available);
  if (!font) throw new Error(`The saved font “${appearance.fontFamily}” is unavailable. Choose an available font in Appearance; your saved choice has not been changed.`);
  if (appearance.bold && !font.boldAvailable) throw new Error(`Bold “${appearance.fontFamily}” is unavailable. Turn off Bold or choose a font with an installed bold face in Appearance.`);
  return font;
}

/** Local copies pin both paths to the same reviewed faces and avoid scanning every system font.
 * These files are private working data, removed with the render directory; they are never served.
 */
export async function prepareCaptionFonts(workDir: string, appearance: CaptionAppearance) {
  const fonts = await fontCapabilities();
  requireCaptionFont(fonts, appearance);
  const font = fonts.find((item) => item.name === appearance.fontFamily)!;
  const directory = path.join(workDir, 'fonts');
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(font.regularPath, path.join(directory, `regular${path.extname(font.regularPath)}`));
  if (appearance.bold && font.boldPath) await fs.copyFile(font.boldPath, path.join(directory, `bold${path.extname(font.boldPath)}`));
  return directory;
}

function assTimestamp(ms: number) {
  const cs = captionRenderTime(ms) / 10;
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs % 360000 / 6000)).padStart(2, '0')}:${String(Math.floor(cs % 6000 / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Libass supports escaped braces. An empty override block separates a literal backslash
 * from N/n/h or a following brace without changing the visible characters or glyph advance.
 */
export function escapeAssText(text: string) {
  return text.replace(/\\|\{|\}|\r?\n/g, (character) => {
    if (character === '\\') return '\\{}';
    if (character === '{') return '\\{';
    if (character === '}') return '\\}';
    return '\\N';
  });
}

function assColor(hex: string, opacity = 1) {
  const value = hex.slice(1);
  const alpha = Math.round((1 - opacity) * 255).toString(16).toUpperCase().padStart(2, '0');
  return `&H${alpha}${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`;
}

/** The only caption appearance recipe. Both native preview and finished MP4 consume this. */
export function buildAssDocument(captions: CaptionSegment[], appearanceInput: Partial<CaptionAppearance> | undefined, width: number, height: number, visibilityMask?: ReadonlySet<number>) {
  const a = normalizeCaptionAppearance(appearanceInput);
  const scale = height / 1080;
  const fontSize = Math.round(a.fontSize1080 * scale * 10) / 10;
  const outline = Math.round(a.outlineWidth1080 * scale * 10) / 10;
  const shadow = Math.round(a.shadowWidth1080 * scale * 10) / 10;
  const padding = Math.round(a.backgroundPadding1080 * scale * 10) / 10;
  const side = Math.max(8, Math.round(width * (100 - a.maxWidthPct) / 200));
  const bottom = Math.max(8, Math.round(height * a.positionBottomPct / 100));
  const lineLimit = Math.max(6, Math.floor(width * a.maxWidthPct / 100 / Math.max(1, fontSize * 0.72)));
  const alignment = a.alignment === 'left' ? 1 : a.alignment === 'right' ? 3 : 2;
  const style = (name: string, text: string, edge: string, back: string, border: number, edgeWidth: number, shadowWidth: number) =>
    `Style: ${name},${a.fontFamily.replace(/[\r\n,]/g, ' ')},${fontSize},${text},${text},${edge},${back},${a.bold ? -1 : 0},0,0,0,100,100,0,0,${border},${edgeWidth},${shadowWidth},${alignment},${side},${side},${bottom},1`;
  const styles = [style('Default', assColor(a.textColor), assColor(a.outlineColor), assColor('#000000', 0.88), 1, outline, shadow)];
  // An independent lower layer keeps background color/padding from replacing the glyph outline.
  if (a.backgroundEnabled) styles.unshift(style('Background', assColor(a.textColor, 0), assColor(a.backgroundColor, a.backgroundOpacity), assColor(a.backgroundColor, 0), 3, padding, 0));
  // A single block per active interval gives overlaps stable line layout after a seek.
  // Libass collision placement otherwise depends on which earlier frames were rendered.
  // Stored cue boundaries and SRT stay untouched; only the burned-in composition is grouped.
  const events = planCaptionRenderStates(captions).filter((c) => c.key).flatMap((c) => {
    const text = c.key.split(',').map((key) => {
      const index = Number(key);
      const visible = escapeAssText(wrapCaptionText(captions[index].text, lineLimit));
      // The editor may request a separate white-on-black focus mask. Alpha changes
      // paint only, never font metrics or line layout; this document is never exported.
      const mask = visibilityMask ? (visibilityMask.has(index) ? '{\\alpha&H00&\\1c&HFFFFFF&\\3c&HFFFFFF&\\4c&HFFFFFF&}' : '{\\alpha&HFF&}') : '';
      return mask + visible;
    }).join('\\N');
    const event = (layer: number, name: string) => `Dialogue: ${layer},${assTimestamp(c.atMs)},${assTimestamp(c.endMs)},${name},,0,0,0,,${text}`;
    return a.backgroundEnabled ? [event(0, 'Background'), event(1, 'Default')] : [event(0, 'Default')];
  });
  return `\uFEFF[Script Info]\nScriptType: v4.00+\nLanguage: km\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\nYCbCr Matrix: None\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}

function filterPath(filePath: string) {
  // Both FFmpeg option parsing and filtergraph parsing consume escaping. No shell is involved.
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\\\''");
}

export function buildAssCaptionFilter(assPath: string, fontDirectory: string) {
  return `ass=filename='${filterPath(assPath)}':fontsdir='${filterPath(fontDirectory)}':shaping=complex:alpha=1`;
}
