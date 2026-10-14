/**
 * A GIF "glance" of the replay video (D-ce; spine §5 reading 196), made only when
 * `AutomationDeps.ffmpeg` is true: the standard two-pass palettegen → paletteuse method with a
 * fixed argv (no shell), our own capture as the only input, the staging directory as cwd, and a
 * budget loop that steps down frame rate, width and duration until the GIF fits
 * `EVIDENCE_LIMITS.maxGifBytes`. After the last step it gives up and the PR ships without a GIF.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_LIMITS, EvidenceFileNameSchema } from "@vtc/shared";

/** Runs `ffmpeg <args>` in `cwd` and resolves its exit code. */
export type FfmpegCommand = (args: readonly string[], cwd: string) => Promise<number>;

export const FFMPEG_TIMEOUT_MS = 60_000;

/** The budget loop's steps, tried in order. */
export const GIF_STEPS: readonly { fps: number; width: number; seconds: number }[] = [
  { fps: 8, width: 960, seconds: 12 },
  { fps: 6, width: 960, seconds: 12 },
  { fps: 6, width: 800, seconds: 10 },
  { fps: 6, width: 640, seconds: 8 },
];

const PALETTE = "palette.png";

/** Pure: the two fixed argvs of one step. */
export const gifArgs = (
  input: string,
  output: string,
  step: { readonly fps: number; readonly width: number; readonly seconds: number },
): [readonly string[], readonly string[]] => {
  const filter = `fps=${String(step.fps)},scale=${String(step.width)}:-1:flags=lanczos`;
  const head = ["-v", "error", "-ss", "0", "-t", String(step.seconds), "-i", input];
  return [
    [...head, "-vf", `${filter},palettegen=max_colors=128:stats_mode=diff`, "-y", PALETTE],
    [
      ...head,
      "-i",
      PALETTE,
      "-lavfi",
      `${filter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      "-loop",
      "0",
      "-y",
      output,
    ],
  ];
};

/** The spawn-backed {@link FfmpegCommand}: fixed argv, no shell, killed after 60 s. */
export const createFfmpegCommand =
  (command = "ffmpeg", timeoutMs = FFMPEG_TIMEOUT_MS): FfmpegCommand =>
  (args, cwd) =>
    new Promise((resolve) => {
      const child = spawn(command, [...args], { cwd, stdio: "ignore", shell: false });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(-1);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

/**
 * Makes `output` from `input` (both neutral names in `dir`) within `maxBytes`; resolves its size,
 * or `null` when ffmpeg failed or no step fit (the GIF is then removed).
 */
export const makeGif = async (input: {
  readonly ffmpeg: FfmpegCommand;
  readonly dir: string;
  readonly video: string;
  readonly output: string;
  readonly maxBytes?: number;
}): Promise<number | null> => {
  EvidenceFileNameSchema.parse(input.video);
  EvidenceFileNameSchema.parse(input.output);
  const maxBytes = input.maxBytes ?? EVIDENCE_LIMITS.maxGifBytes;
  const out = join(input.dir, input.output);
  const attempt = async (): Promise<number | null> => {
    for (const step of GIF_STEPS) {
      const [palette, gif] = gifArgs(input.video, input.output, step);
      if ((await input.ffmpeg(palette, input.dir)) !== 0) return null;
      if ((await input.ffmpeg(gif, input.dir)) !== 0) return null;
      if (!existsSync(out)) return null;
      const bytes = statSync(out).size;
      if (bytes > 0 && bytes <= maxBytes) return bytes;
    }
    return null;
  };
  try {
    const bytes = await attempt();
    if (bytes === null) rmSync(out, { force: true });
    return bytes;
  } finally {
    rmSync(join(input.dir, PALETTE), { force: true });
  }
};
