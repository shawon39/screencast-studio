# Screencast Studio

A local web app that turns one raw screen recording into a finished video. The full spec is `PLAN.md`, exported from the Claude doc "Screencast Polish Pipeline: Build Plan". Where this file and `PLAN.md` disagree, this file wins.

## Run

- `npm start` starts the server on http://localhost:4321 and opens the browser.
- `npm run doctor` checks tools, keys and the voice.
- `npm run typecheck` and `npm test`.
- `node scripts/make-test-video.ts` builds a synthetic test recording in `tests/fixtures/`.
- `node scripts/inspect.ts <job-id>` prints what the Listen phase found for a job.
- `node scripts/check-sync.ts <job-id>` checks cue sync on the rendered cut by comparing frames (SSIM).
- `npm run clean-training -- <file>` cleans a voice-clone sample (fillers out, pauses to 0.5 s) into `<file>.clean.mp3`.
- `npm run clone -- <file> --name "<name>"` creates an Instant Voice Clone from cleaned samples and prints its voice ID for `.env`. The API key needs the Voices write permission.
- Brand settings live in `config/brand.json`; logo, font and music files go in `brand/`.

## Decisions that change PLAN.md

- A local web page replaces the `/polish-video` skill, `src/cli.ts` and the `--auto` flag.
- Stage 4 (script rewrite) runs `claude -p --json-schema` from the server, so it stays on the Max plan. No Anthropic API key.
- Screen analysis counts changed pixels per frame (`tblend` + `signalstats`) instead of using `freezedetect` and `scdet`. A moving cursor is too small to register in `freezedetect`'s whole-frame average, and the cut rule depends on seeing it.
- Original-voice mode, auto-zoom, Bangla and the Professional clone are out of v1.
- Timing is fitted by the video only. The voice `speed` setting stays at 1.0, because re-voicing a line to fit would double the ElevenLabs cost. When the video is too short, frames are held inside still parts first, where a hold is invisible.
- Pieces in `work/pieces/` are named by a hash of what they contain, so a re-render only renders what changed.
- Subtitles are Remotion-rendered transparent PNGs (cached in `cache/subs/`) overlaid with ffmpeg as the last filter, instead of libass. This matches the UI design exactly and avoids installing `ffmpeg-full`.
- The video keeps the recording's own shape, 1920 wide: a 16:10 Mac screen gives 1920 × 1248, with nothing cut and nothing padded (`frameSize` in `01-probe.ts`). The cards are drawn at that size; captions stay 1920 × 1080 pictures placed at the bottom. Only the thumbnail stays 16:9.
- Every input is converted to BT.709 before the final encode; the voice is made stereo before loudness is measured (two equal channels measure 3 dB louder than one).
- Loudness is -16 LUFS, not -14: one measured gain plus a peak limiter, no compressor and no loudnorm. loudnorm falls back to riding the volume when peaks are high, which pumped every pause between sentences and made the voice sound pushed.
- The voice is recorded one take per paragraph (a new take after a 1 s pause in the recording), so ElevenLabs makes the pauses between sentences. Where the plan lengthens a pause, the take is cut at its quietest moment, found in the audio rather than from word timings, and the rest of the pause is silence. That needs a clean clone (made with `--remove-noise`): a clone that carries room sound makes silence audible.
- The build runs in 4 shots: 1 shell + Listen, 2 Rewrite + Review, 3 Voice + Cut, 4 Finish + Done. Each shot ends with its check and waits for the user's OK.
- The UI design reference is `design/mockup.html`.

## Code conventions

- Node 24 runs the TypeScript directly (type stripping). Import local files with the `.ts` extension. No enums, namespaces or constructor parameter properties.
- No web framework: a `node:http` server in `src/server.ts` and plain JS in `public/`.
- Every step writes its outputs through a temp file and a rename, so a crash never leaves a half-written file that looks fresh.
- UI copy is sentence case and says what happens. Errors say what went wrong and what to do next.

## Hard rules (from PLAN.md)

1. Fix grammar only. Never add a fact, claim or step the speaker did not say.
2. Keep each clean sentence within ±15% of its original word count.
3. Keep every action word, and mark it as an anchor.
4. Cut only inside still intervals.
5. Apply subtitles last in the filter chain.
6. Put a 30 ms audio fade at every edge.
7. Never re-transcribe or re-voice an item that is in the cache.
8. Never change `input/`. Write only to `work/` and `output/`.
9. Stop after 3 failed check passes and report the problems.
10. Read the API key only from `.env`. Never print it or log it.
