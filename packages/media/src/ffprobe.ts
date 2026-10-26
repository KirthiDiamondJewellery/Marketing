import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { FFMPEG_FIX, findBinary, MediaPyError } from "./media-py.ts";

/** ffprobe without Python: what a media file is (display size after rotation, fps, streams, duration). */

export const probeResultSchema = z.object({
  path: z.string(),
  durationS: z.number(),
  sizeBytes: z.number(),
  formatName: z.string().nullable().optional(),
  bitRate: z.number().nullable().optional(),
  video: z
    .object({
      codec: z.string().nullable(),
      width: z.number(),
      height: z.number(),
      displayWidth: z.number(),
      displayHeight: z.number(),
      rotation: z.number(),
      fps: z.number().nullable(),
      frames: z.number().nullable().optional(),
      pixFmt: z.string().nullable().optional(),
      colorTransfer: z.string().nullable().optional(),
      colorPrimaries: z.string().nullable().optional(),
      isImage: z.boolean().optional(),
    })
    .nullable(),
  audio: z.object({ codec: z.string().nullable(), sampleRate: z.number(), channels: z.number() }).nullable(),
});
export type ProbeResult = z.output<typeof probeResultSchema>;

type RawStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  pix_fmt?: string;
  color_transfer?: string;
  color_primaries?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number | string }[];
  tags?: { rotate?: string };
};

function rate(r?: string): number | null {
  if (!r || r === "0/0") return null;
  const [n, d] = r.split("/").map(Number);
  if (d === undefined) return Number.isFinite(n) ? n! : null;
  return d ? Math.round((n! / d) * 10_000) / 10_000 : null;
}

function rotation(s: RawStream): number {
  const sd = s.side_data_list?.find((x) => x.rotation !== undefined);
  const v = sd ? Number(sd.rotation) : s.tags?.rotate ? Number(s.tags.rotate) : 0;
  return Number.isFinite(v) ? ((Math.round(v) % 360) + 360) % 360 : 0;
}

export async function ffprobe(path: string, opts: { timeoutMs?: number; ffprobe?: string } = {}): Promise<ProbeResult> {
  if (!existsSync(path)) throw new MediaPyError("not_found", `File not found: ${path}`, "Check the path; it must be readable by this machine.");
  const bin = opts.ffprobe ?? findBinary("ffprobe", "ATTENTIONOS_FFPROBE");
  if (!bin) throw new MediaPyError("ffmpeg_missing", "ffprobe (part of ffmpeg) is not installed.", FFMPEG_FIX);
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new MediaPyError("timeout", "ffprobe took too long."));
    }, opts.timeoutMs ?? 30_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new MediaPyError("spawn_failed", e.message, FFMPEG_FIX));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new MediaPyError("unreadable_media", `ffprobe could not read ${path}.`, "Is it a video or audio file?", { stderr: err.slice(-500) }));
    });
  });
  const data = JSON.parse(raw || "{}") as { format?: { duration?: string; size?: string; format_name?: string; bit_rate?: string }; streams?: RawStream[] };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const fmt = data.format ?? {};
  const durationS = Number(fmt.duration ?? 0) || 0;
  const rot = v ? rotation(v) : 0;
  const w = v?.width ?? 0;
  const h = v?.height ?? 0;
  return {
    path,
    durationS: Math.round(durationS * 10_000) / 10_000,
    sizeBytes: Number(fmt.size ?? 0),
    formatName: fmt.format_name ?? null,
    bitRate: fmt.bit_rate ? Number(fmt.bit_rate) : null,
    video: v
      ? {
          codec: v.codec_name ?? null,
          width: w,
          height: h,
          displayWidth: rot === 90 || rot === 270 ? h : w,
          displayHeight: rot === 90 || rot === 270 ? w : h,
          rotation: rot,
          fps: rate(v.avg_frame_rate) ?? rate(v.r_frame_rate),
          frames: v.nb_frames && /^\d+$/.test(v.nb_frames) ? Number(v.nb_frames) : null,
          pixFmt: v.pix_fmt ?? null,
          colorTransfer: v.color_transfer ?? null,
          colorPrimaries: v.color_primaries ?? null,
          isImage: ["png", "mjpeg", "webp", "bmp", "tiff"].includes(v.codec_name ?? "") && durationS < 0.1,
        }
      : null,
    audio: a ? { codec: a.codec_name ?? null, sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0 } : null,
  };
}
