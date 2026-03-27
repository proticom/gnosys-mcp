/**
 * Gnosys Audio Extraction — Transcribe audio files with timestamps.
 *
 * API-first approach: Groq Whisper API ($0.02/hr) -> OpenAI Whisper API -> local Whisper (opt-in).
 *
 * Part of v5.0 Phase 4: Multimodal Ingestion — Audio support.
 */

import * as fs from "fs/promises";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  text: string;
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  fullText: string;
  /** Total audio duration in seconds */
  duration: number;
  language?: string;
}

export interface TranscriptionOptions {
  provider?: "groq" | "openai" | "local";
  apiKey?: string;
  model?: string;
  language?: string;
}

// ─── MIME type detection for audio files ─────────────────────────────────

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".aac": "audio/aac",
};

function detectAudioMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return AUDIO_MIME[ext] || "audio/wav";
}

// ─── Groq Whisper API ───────────────────────────────────────────────────

interface WhisperApiSegment {
  text: string;
  start: number;
  end: number;
}

interface WhisperApiResponse {
  text: string;
  segments?: WhisperApiSegment[];
  language?: string;
  duration?: number;
}

async function transcribeWithGroq(
  audioBuffer: Buffer,
  fileName: string,
  mimeType: string,
  apiKey: string,
  options?: TranscriptionOptions
): Promise<TranscriptResult> {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), fileName);
  formData.append("model", options?.model || "whisper-large-v3-turbo");
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");

  if (options?.language) {
    formData.append("language", options.language);
  }

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq Whisper API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as WhisperApiResponse;
  return parseWhisperResponse(data);
}

// ─── OpenAI Whisper API ─────────────────────────────────────────────────

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  fileName: string,
  mimeType: string,
  apiKey: string,
  options?: TranscriptionOptions
): Promise<TranscriptResult> {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), fileName);
  formData.append("model", options?.model || "whisper-1");
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");

  if (options?.language) {
    formData.append("language", options.language);
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Whisper API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as WhisperApiResponse;
  return parseWhisperResponse(data);
}

// ─── Local Whisper via @xenova/transformers ──────────────────────────────

interface XenovaTimestamp {
  text: string;
  timestamp: [number, number | null];
}

async function transcribeWithLocal(
  filePath: string,
  options?: TranscriptionOptions
): Promise<TranscriptResult> {
  let pipeline: (task: string, model: string) => Promise<unknown>;

  try {
    // Dynamic import — @xenova/transformers is an optional dependency
    const transformers = await import("@xenova/transformers");
    pipeline = transformers.pipeline as typeof pipeline;
  } catch {
    throw new Error(
      "Local Whisper transcription requires @xenova/transformers. " +
        'Install it with: npm install @xenova/transformers\n' +
        "Or set a Groq/OpenAI API key for cloud transcription."
    );
  }

  const modelName = options?.model || "Xenova/whisper-small";
  const transcriber = await pipeline("automatic-speech-recognition", modelName) as (
    input: string,
    opts: Record<string, unknown>
  ) => Promise<{ text: string; chunks?: XenovaTimestamp[] }>;

  const result = await transcriber(filePath, {
    return_timestamps: true,
    ...(options?.language ? { language: options.language } : {}),
  });

  const segments: TranscriptSegment[] = [];
  let duration = 0;

  if (result.chunks && Array.isArray(result.chunks)) {
    for (const chunk of result.chunks) {
      const startTime = chunk.timestamp[0];
      const endTime = chunk.timestamp[1] ?? startTime;
      segments.push({
        text: chunk.text.trim(),
        startTime,
        endTime,
      });
      if (endTime > duration) {
        duration = endTime;
      }
    }
  }

  // If no segments were returned, create a single segment from the full text
  if (segments.length === 0 && result.text) {
    segments.push({
      text: result.text.trim(),
      startTime: 0,
      endTime: 0,
    });
  }

  return {
    segments,
    fullText: result.text.trim(),
    duration,
  };
}

// ─── Response parsing ───────────────────────────────────────────────────

function parseWhisperResponse(data: WhisperApiResponse): TranscriptResult {
  const segments: TranscriptSegment[] = [];
  let duration = data.duration ?? 0;

  if (data.segments && Array.isArray(data.segments)) {
    for (const seg of data.segments) {
      segments.push({
        text: seg.text.trim(),
        startTime: seg.start,
        endTime: seg.end,
      });
      if (seg.end > duration) {
        duration = seg.end;
      }
    }
  }

  // If the API returned no segments, create one from the full text
  if (segments.length === 0 && data.text) {
    segments.push({
      text: data.text.trim(),
      startTime: 0,
      endTime: duration,
    });
  }

  return {
    segments,
    fullText: data.text?.trim() || segments.map((s) => s.text).join(" "),
    duration,
    language: data.language,
  };
}

// ─── API key resolution ─────────────────────────────────────────────────

function resolveGroqKey(options?: TranscriptionOptions): string | undefined {
  return options?.apiKey || process.env.GNOSYS_GROQ_KEY || process.env.GROQ_API_KEY;
}

function resolveOpenAIKey(options?: TranscriptionOptions): string | undefined {
  return options?.apiKey || process.env.GNOSYS_OPENAI_KEY || process.env.OPENAI_API_KEY;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Transcribe an audio file with timestamps.
 *
 * Provider resolution order:
 * 1. If `options.provider` is specified, use that provider
 * 2. Try Groq (if GNOSYS_GROQ_KEY or GROQ_API_KEY is set)
 * 3. Try OpenAI (if GNOSYS_OPENAI_KEY or OPENAI_API_KEY is set)
 * 4. Try local Whisper (if @xenova/transformers is installed)
 * 5. Throw an error with setup instructions
 */
export async function transcribeAudio(
  filePath: string,
  options?: TranscriptionOptions
): Promise<TranscriptResult> {
  // Read the audio file
  const audioBuffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  const mimeType = detectAudioMime(filePath);

  // 1. Explicit provider requested
  if (options?.provider) {
    switch (options.provider) {
      case "groq": {
        const key = resolveGroqKey(options);
        if (!key) {
          throw new Error(
            "Groq transcription requires an API key. " +
              "Set GNOSYS_GROQ_KEY or GROQ_API_KEY in your environment."
          );
        }
        return transcribeWithGroq(audioBuffer, fileName, mimeType, key, options);
      }

      case "openai": {
        const key = resolveOpenAIKey(options);
        if (!key) {
          throw new Error(
            "OpenAI transcription requires an API key. " +
              "Set GNOSYS_OPENAI_KEY or OPENAI_API_KEY in your environment."
          );
        }
        return transcribeWithOpenAI(audioBuffer, fileName, mimeType, key, options);
      }

      case "local":
        return transcribeWithLocal(filePath, options);
    }
  }

  // 2. Try Groq (cheapest API option)
  const groqKey = resolveGroqKey(options);
  if (groqKey) {
    return transcribeWithGroq(audioBuffer, fileName, mimeType, groqKey, options);
  }

  // 3. Try OpenAI
  const openaiKey = resolveOpenAIKey(options);
  if (openaiKey) {
    return transcribeWithOpenAI(audioBuffer, fileName, mimeType, openaiKey, options);
  }

  // 4. Try local Whisper as a fallback
  try {
    return await transcribeWithLocal(filePath, options);
  } catch {
    // Local Whisper not available — fall through to the error below
  }

  // 5. No provider available
  throw new Error(
    "No transcription provider available. Set up one of:\n" +
      "  1. Groq API key: export GROQ_API_KEY=your-key  (cheapest, $0.02/hr)\n" +
      "  2. OpenAI API key: export OPENAI_API_KEY=your-key\n" +
      "  3. Local Whisper: npm install @xenova/transformers\n" +
      "Or set multimodal.transcriptionProvider in gnosys.json."
  );
}
