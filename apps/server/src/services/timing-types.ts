export interface TimingWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  /** True when one timing-engine word was divided into Khmer display tokens locally. */
  derived?: boolean;
}

export interface TimingResult {
  transcript: string;
  words: TimingWord[];
  engine: 'kfa-local' | 'faster-whisper-local' | 'google-cloud-stt-v2';
  provider: 'local' | 'google-cloud';
  model: string;
  location?: string;
  device?: string;
  computeType?: string;
  /** KFA aligns Gemini's exact transcript directly; Whisper fallback does not. */
  directAlignment?: boolean;
  /** Present when KFA failed and the local Whisper fallback was used. */
  fallbackReason?: string;
}
