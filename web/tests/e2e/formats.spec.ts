import fs from "node:fs";

import { expect, test } from "@playwright/test";

interface TrackRecord {
  id: string;
  title: string;
  format: string;
  durationMs: number;
}

const runtimePath = process.env.ZURADIO_RUNTIME;
if (!runtimePath) throw new Error("ZURADIO_RUNTIME must name the running daemon's runtime.json");
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as { hostUrl: string };

test("catalogs real WAV, FLAC, AIFF, MP3, and OGG files and decodes WAV and FLAC", async ({ page }) => {
  test.skip(process.env.ZURADIO_FORMAT_FIXTURES !== "1", "sox and flac are required for generated format fixtures");
  await page.goto(`${runtime.hostUrl}&autobroadcast=0`);

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/v1/snapshot");
    const snapshot = (await response.json()) as { tracks: TrackRecord[] };
    const fixtures = snapshot.tracks.filter((track) => track.title.startsWith("Zuradio Format"));
    const decoded: Record<string, number> = {};
    const context = new AudioContext();
    try {
      for (const format of ["wav", "flac"]) {
        const track = fixtures.find((candidate) => candidate.format === format);
        if (!track) continue;
        const media = await fetch(`/api/v1/media/${encodeURIComponent(track.id)}`);
        const audio = await context.decodeAudioData(await media.arrayBuffer());
        decoded[format] = audio.duration;
      }
    } finally {
      await context.close();
    }
    return {
      formats: fixtures.map((track) => track.format).sort(),
      durations: fixtures.map((track) => track.durationMs),
      decoded,
    };
  });

  expect(result.formats).toEqual(["aiff", "flac", "mp3", "ogg", "wav"]);
  expect(result.durations.every((duration) => duration >= 900)).toBe(true);
  expect(result.decoded.wav).toBeGreaterThan(0.9);
  expect(result.decoded.flac).toBeGreaterThan(0.9);
});
