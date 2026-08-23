export interface DecodedWaveformAudio {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
  channels: number;
  decoder: 'pcm-wav' | 'web-audio';
}

function fourCc(view: DataView, offset: number) {
  if (offset < 0 || offset + 4 > view.byteLength) return '';
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function clampSample(value: number) {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Decode the normalized PCM WAV produced by the local FFmpeg pipeline without
 * depending on the browser's codec stack. Browsers occasionally reject an
 * otherwise usable WAV preview with "Unable to decode audio data"; parsing the
 * known PCM container directly keeps the precision timeline reliable.
 */
export function decodePcmWav(buffer: ArrayBuffer): DecodedWaveformAudio {
  const view = new DataView(buffer);
  if (view.byteLength < 44) throw new Error('Waveform preview is incomplete.');

  const container = fourCc(view, 0);
  const littleEndian = container !== 'RIFX';
  if (!['RIFF', 'RIFX', 'RF64'].includes(container) || fourCc(view, 8) !== 'WAVE') {
    throw new Error('Waveform preview is not a WAV file.');
  }

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = fourCc(view, offset);
    const declaredSize = view.getUint32(offset + 4, littleEndian);
    const payloadOffset = offset + 8;
    const availableSize = Math.max(0, view.byteLength - payloadOffset);
    const chunkSize = Math.min(declaredSize, availableSize);

    if (id === 'fmt ' && chunkSize >= 16) {
      audioFormat = view.getUint16(payloadOffset, littleEndian);
      channels = view.getUint16(payloadOffset + 2, littleEndian);
      sampleRate = view.getUint32(payloadOffset + 4, littleEndian);
      blockAlign = view.getUint16(payloadOffset + 12, littleEndian);
      bitsPerSample = view.getUint16(payloadOffset + 14, littleEndian);

      // WAVE_FORMAT_EXTENSIBLE stores the underlying PCM/float type in the
      // SubFormat GUID. The first 16 bits carry the compatible format tag.
      if (audioFormat === 0xfffe && chunkSize >= 40) {
        audioFormat = view.getUint16(payloadOffset + 24, littleEndian);
      }
    } else if (id === 'data') {
      dataOffset = payloadOffset;
      dataSize = chunkSize;
      break;
    }

    // RIFF chunks are padded to an even byte boundary.
    offset = payloadOffset + declaredSize + (declaredSize % 2);
    if (offset <= payloadOffset) break;
  }

  if (!channels || !sampleRate || !bitsPerSample || dataOffset < 0 || dataSize <= 0) {
    throw new Error('Waveform preview is missing required WAV metadata.');
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`Unsupported WAV encoding (${audioFormat}).`);
  }

  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const frameSize = blockAlign || bytesPerSample * channels;
  if (!frameSize || frameSize < bytesPerSample * channels) {
    throw new Error('Waveform preview has an invalid frame size.');
  }

  const frames = Math.floor(dataSize / frameSize);
  if (frames <= 0) throw new Error('Waveform preview does not contain audio samples.');
  const mono = new Float32Array(frames);

  const readSample = (sampleOffset: number) => {
    if (audioFormat === 3) {
      if (bitsPerSample === 32) return view.getFloat32(sampleOffset, littleEndian);
      if (bitsPerSample === 64) return view.getFloat64(sampleOffset, littleEndian);
      throw new Error(`Unsupported floating-point WAV depth (${bitsPerSample}).`);
    }

    switch (bitsPerSample) {
      case 8:
        return (view.getUint8(sampleOffset) - 128) / 128;
      case 16:
        return view.getInt16(sampleOffset, littleEndian) / 32768;
      case 24: {
        const b0 = view.getUint8(sampleOffset);
        const b1 = view.getUint8(sampleOffset + 1);
        const b2 = view.getUint8(sampleOffset + 2);
        let value = littleEndian ? (b0 | (b1 << 8) | (b2 << 16)) : (b2 | (b1 << 8) | (b0 << 16));
        if (value & 0x800000) value |= ~0xffffff;
        return value / 8388608;
      }
      case 32:
        return view.getInt32(sampleOffset, littleEndian) / 2147483648;
      default:
        throw new Error(`Unsupported PCM WAV depth (${bitsPerSample}).`);
    }
  };

  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = dataOffset + frame * frameSize;
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      mixed += readSample(frameOffset + channel * bytesPerSample);
    }
    mono[frame] = clampSample(mixed / channels);
  }

  return {
    samples: mono,
    sampleRate,
    durationMs: frames / sampleRate * 1000,
    channels,
    decoder: 'pcm-wav',
  };
}

export async function decodeWaveformAudio(buffer: ArrayBuffer): Promise<DecodedWaveformAudio> {
  try {
    return decodePcmWav(buffer);
  } catch (pcmError) {
    const Context = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw pcmError;

    const context = new Context();
    try {
      const decoded = await context.decodeAudioData(buffer.slice(0));
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const data = decoded.getChannelData(channel);
        for (let index = 0; index < data.length; index += 1) {
          mono[index] += data[index] / decoded.numberOfChannels;
        }
      }
      return {
        samples: mono,
        sampleRate: decoded.sampleRate,
        durationMs: decoded.duration * 1000,
        channels: decoded.numberOfChannels,
        decoder: 'web-audio',
      };
    } catch (browserError) {
      const pcmMessage = pcmError instanceof Error ? pcmError.message : String(pcmError);
      const browserMessage = browserError instanceof Error ? browserError.message : String(browserError);
      throw new Error(`Could not decode the waveform preview. PCM parser: ${pcmMessage} Browser decoder: ${browserMessage}`);
    } finally {
      void context.close();
    }
  }
}
