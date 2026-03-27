/**
 * Gnosys Video Extraction — Extract audio from video files and transcribe.
 *
 * Requires ffmpeg to be installed on the system. Extracts audio to a temp WAV
 * file, then delegates to audioExtract.ts for transcription.
 *
 * Part of v5.0 Phase 4: Multimodal Ingestion — Video support.
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { execFileSync } from "child_process";
import {
  transcribeAudio,
  type TranscriptSegment,
  type TranscriptResult,
  type TranscriptionOptions,
} from "./audioExtract.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface VideoTranscriptResult {
  segments: TranscriptSegment[];
  fullText: string;
  /** Total duration in seconds */
  duration: number;
  language?: string;
  /** Temp audio file path (cleaned up after transcription) */
  audioPath?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Check that ffmpeg is installed and accessible.
 * Throws a clear error message if not found.
 */
function checkFfmpeg(): void {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "Video transcription requires ffmpeg to be installed.\n" +
        "Install it with:\n" +
        "  macOS:   brew install ffmpeg\n" +
        "  Ubuntu:  sudo apt install ffmpeg\n" +
        "  Windows: winget install FFmpeg"
    );
  }
}

/**
 * Extract audio from a video file into a WAV file using ffmpeg.
 *
 * Uses PCM 16-bit, 16kHz mono — the format Whisper expects.
 * Uses execFileSync (not execSync) to avoid shell injection since
 * the file path comes from user input.
 */
function extractAudioTrack(videoPath: string, outputWav: string): void {
  execFileSync("ffmpeg", [
    "-i", videoPath,
    "-vn",                  // no video
    "-acodec", "pcm_s16le", // PCM 16-bit little-endian
    "-ar", "16000",         // 16kHz sample rate
    "-ac", "1",             // mono
    "-y",                   // overwrite output
    outputWav,
  ], {
    stdio: "ignore",
    timeout: 300_000, // 5-minute timeout for large files
  });
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Extract audio from a video file and transcribe it.
 *
 * Steps:
 * 1. Check that ffmpeg is installed
 * 2. Extract audio track to a temp WAV file
 * 3. Transcribe the WAV file using audioExtract
 * 4. Clean up the temp file
 * 5. Return the transcript result
 */
export async function transcribeVideo(
  filePath: string,
  options?: TranscriptionOptions
): Promise<VideoTranscriptResult> {
  // Step 1: Check for ffmpeg
  checkFfmpeg();

  // Step 2: Create a temp WAV file path
  const tempWav = path.join(os.tmpdir(), `gnosys-audio-${Date.now()}.wav`);

  try {
    // Step 3: Extract audio from video
    extractAudioTrack(filePath, tempWav);

    // Step 4: Transcribe the extracted audio
    const result: TranscriptResult = await transcribeAudio(tempWav, options);

    // Step 5: Return the result
    return {
      segments: result.segments,
      fullText: result.fullText,
      duration: result.duration,
      language: result.language,
    };
  } finally {
    // Step 6: Clean up temp file (always, even if transcription fails)
    try {
      await fs.unlink(tempWav);
    } catch {
      // Ignore cleanup errors — the temp file may not exist if
      // ffmpeg failed before creating it
    }
  }
}
