# Screencast Polish Pipeline: Build Plan

2026-10-17 · @Shakhawat Hossain

## Summary

**Verdict: build it, for screen recordings only (no face on screen).** You record once. The pipeline fixes your words, speaks them in your own voice clone, keeps every click in sync, and adds an intro, outro and subtitles.

- **Input:** one raw English screen recording (.mp4 or .mkv) with your voice.
- **Output:** `final.mp4` (1080p, intro, outro, burned subtitles, loudness -14 LUFS), `final.srt`, and `report.md`.
- **How you run it:** put the file in `jobs/<name>/input/`, then type `/polish-video` in Claude Code. You approve the clean script once. The rest runs alone.
- **Two voice modes:** `clone` (default) and `original`. Original mode keeps your real voice and only cuts and cleans. It is your fallback, and it keeps your English speaking practice.
- **Stack:** Node.js + TypeScript, ffmpeg, ElevenLabs (Scribe v2, Instant Voice Clone, Text to Speech), Remotion for intro and outro. Claude Code is the editor brain. It runs on your Claude Max plan, so you need no Anthropic API key.
- **Start cost:** $0 to build with a stock voice, then $6 per month (Starter) for your own voice clone.
- **Language:** English only for now. Bangla is a later phase (see Risks).

## Tools and accounts

You need one paid account (ElevenLabs Starter, $6 per month), and only after the free build works. Everything else is free or already yours.

| Tool | Job in the pipeline | Cost |
| --- | --- | --- |
| Claude Code | Runs every step. Rewrites the script. Checks frames at cuts. | In your Max plan |
| Node.js (LTS) + TypeScript | Pipeline code. Chosen because you know it. | Free |
| ffmpeg + ffprobe | Cut, speed up, freeze, join, subtitles, loudness, checks | Free |
| [ElevenLabs](https://elevenlabs.io/pricing) Free plan, then Starter | Scribe v2 transcription, Instant Voice Clone, Text to Speech | $0 to build; $6/month for your clone |
| `@elevenlabs/elevenlabs-js` | Official SDK for the calls above | Free |
| [Remotion](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) | Intro and outro, written in React | Free for individuals |
| OBS Studio | Screen recorder (any recorder works) | Free |
| A good microphone | Clean audio for the clone sample | One-time |

Optional reference: [browser-use/video-use](https://github.com/browser-use/video-use) (MIT). Reuse its ideas: an edit decision list, 30 ms audio fades at cuts, subtitles applied last, self-check before showing output.

## One-time setup (you do this)

Claude Code cannot do these steps for you. They need your card, your voice or your accounts.

- [ ] Install Node.js LTS, ffmpeg, Claude Code and OBS Studio. Check with `node -v` and `ffmpeg -version`.
- [ ] Create a free ElevenLabs account. Pick a stock English voice and copy its `voice_id`.
- [ ] Create an API key. Limit its scope to Text to Speech, Speech to Text, Voices and Pronunciation dictionaries. Set a credit quota.
- [ ] Copy `.env.example` to `.env`. Fill `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. Never commit `.env`. GitHub secret scanning disables a leaked ElevenLabs key automatically.
- [ ] Put brand files in `brand/`: a transparent logo, your colors, a font file, the outro text, and music you own the rights to.
- [ ] Set OBS to 1920×1080, 30 fps, mic on its own audio track. Turn off notifications. Record in a demo org, never in a customer org.
- [ ] Record the 2-minute test video (see Milestones). Build M0 to M7 with the stock voice.
- [ ] When M7 passes, buy Starter and create your Instant Voice Clone (next section). Put its ID in `ELEVENLABS_VOICE_ID`. The code does not change.

## Voice clone setup

**Start with an Instant Voice Clone on the Starter plan.** Upgrade to a Professional clone only if the Instant clone does not sound like you. Any clone copies its sample audio, good and bad, so clean audio decides the quality.

1. **Record 1 to 2 minutes** of English, in your teaching style and energy. ElevenLabs says more than 3 minutes gives little gain and can make the clone worse.
2. **Recording rules:** one speaker, quiet room, pop filter, mic about two fists away. Keep the level between -23 and -18 dB RMS with a true peak of -3 dB. No music, no echo.
3. **Clean the sample.** Run `npm run clean-training`: it cuts "uhm" sounds and long gaps from the real audio with ffmpeg. It does not generate audio.
4. **Export** as MP3 at 192 kbps or higher.
5. **Create the clone:** Voices → plus icon → Instant Voice Clone → upload the sample. It is ready in seconds.
6. **Test** one paragraph from a real script with both models below. Copy the `voice_id` and the model you keep.

**Later, only if needed: Professional clone (Creator, $22 per month)**

- Record 1 to 3 hours in the same style (30 minutes minimum), in files of about 30 minutes. Clean it with `npm run clean-training`.
- Upload it in Voices → Professional Voice Clone. Read the captcha lines once each, with the same mic.
- Wait 3 to 6 hours for training (sometimes up to 24). Then replace `ELEVENLABS_VOICE_ID`. The code does not change.

**Model choice**

- **Default: ****`eleven_multilingual_v2`****.** Stable for long narration. Supports request stitching and the `speed` setting. Limit: 10,000 characters per request. It does not support Bengali, which is fine while you work in English.
- **Test: ****`eleven_v4`****.** ElevenLabs says it makes more accurate clones, Instant clones included. It supports request stitching but has **no speed or style setting**, so the video does all the timing work.
- **Avoid: ****`eleven_v3`****.** It does not support request stitching, so sentences can sound disconnected.
- Keep the model that sounds more like you. Set it in `config/voice.json`.

**Two facts to accept**

- The clone keeps **your accent**. You cannot change accent after creation. To change the result, change the sample.
- Pronunciation fixes: phoneme rules work only on `eleven_v4`, `eleven_flash_v2` and `eleven_v3`. On `eleven_multilingual_v2`, use alias rules (for example, map `SOQL` to the spelling you want spoken).

## Pipeline stages

Twelve stages turn one raw recording into a finished video. Only stage 5 waits for you.

_[diagram: pipeline · 12 stages, 1 human stop, 1 fix loop]_

The script review is the only stop. A failed check loops back to the render, at most 3 times.

1. **Probe.** Read resolution, fps, duration and audio tracks with ffprobe. Convert variable frame rate to a constant 30 fps first, because frame math needs it.
2. **Transcribe.** Call Speech to Text with `model_id: scribe_v2`, `timestamps_granularity: word`, `tag_audio_events: true`, `language_code: en`. Keep `no_verbatim` off, so fillers stay visible with their times. Add Salesforce terms as `keyterms`. Cache the result by file hash.
3. **Analyze the screen.** ffmpeg `freezedetect` finds still parts. `scdet` finds screen changes (clicks, page loads). `silencedetect` finds pauses in the audio. Save all to `screen.json`.
4. **Rewrite the script (Claude).** The pipeline writes `script-input.md`: numbered sentences with their times. Claude writes `script.json`: clean text, kept or dropped, and action anchors. A validator checks the schema, the length ratio and the anchors.
5. **Review gate.** You read `review.md`: original and clean text side by side. Reply "approve" or edit `script.json`. The `--auto` flag skips this gate.
6. **Voice.** For each sentence, call `POST /v1/text-to-speech/{voice_id}/with-timestamps`. Send the same model, settings and `seed` every time. Send `previous_request_ids` (maximum 3, younger than 2 hours) for smooth flow between sentences. Save the audio and its character timings. Cache by text + voice + model + settings.
7. **Plan.** Build `edl.json` with the re-timing rules (next section).
8. **Render the body.** Cut each piece with ffmpeg: `trim` + `setpts` for speed, `tpad` for a frame hold. Use the same encoder settings for every piece, then join with the concat demuxer. Place each voice clip at its planned time, silence in gaps, 30 ms fades at every edge.
9. **Intro and outro.** Render two Remotion compositions with your title, logo and colors. Claude writes the title from the script. Same resolution and fps as the body.
10. **Finish.** Build subtitles from the voice timings, so they match exactly. Burn them last. Also save `final.srt`. Duck optional music under the voice. Run two-pass `loudnorm` to -14 LUFS, true peak -1 dBTP or lower.
11. **Check.** Measure duration, loudness (`ebur128`), every anchor and every cut. Fix and re-render, maximum 3 passes. Problems left after 3 passes go into the report.
12. **Deliver.** Write `final.mp4`, `final.srt`, `thumbnail.png` and `report.md` to `jobs/<name>/output/`.

## Re-timing rules

**The video bends to fit the new voice. Anchors never move.** Each action word in the new audio must play within 150 ms of its action on screen.

- **Segment:** one sentence of the clean script, with its source time range.
- **Anchor:** an action word ("click", "here", "this", "select", "open", "type") tied to its original timestamp. Claude marks anchors in `script.json`. The voice timings give each anchor's new time.
- **Piece:** the video between two anchors inside one segment. Each piece is fitted on its own.

| Situation | Action, in this order | Limit |
| --- | --- | --- |
| New audio is a little longer or shorter | Change the voice `speed` setting first (`eleven_multilingual_v2` only; `eleven_v4` has none) | ±10% |
| Piece is too long for its audio | Remove still frames inside it, then speed it up | Speed 1.5x or lower while voice plays |
| Piece is too short for its audio | Hold a still frame just before the next action, then slow down | Hold 2 s or less; speed 0.8x or higher |
| Gap between sentences, screen still | Cut the gap | Keep 0.4 s |
| Gap between sentences, screen moving (page load, typing) | Speed up, no voice | 2x to 4x; output 3 s or less. Longer: cut the middle with a 0.3 s crossfade |
| Dropped sentence (retake, false start) | Remove its video if the screen was still | If the screen moved, keep it, speed it up, no voice |

**Cut rule:** cut only inside a still interval from `freezedetect`. Never cut while the cursor or the page moves. This rule removes visible jumps.

**Build note:** write the planner as a pure function (`src/lib/timemap.ts`): inputs are the transcript, `screen.json`, `script.json` and the voice timings; the output is `edl.json`. Cover it with unit tests before any rendering code.

## Project structure

One repo holds the code, the skill and every job. Each job keeps its input, work files and output apart.

```text
screencast-studio/
├── CLAUDE.md                          # project rules for Claude Code
├── .claude/skills/polish-video/SKILL.md   # the one-command workflow
├── .env.example                       # ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
├── package.json, tsconfig.json
├── config/
│   ├── brand.json                     # colors, font, logo, intro and outro text, music
│   ├── voice.json                     # model_id, voice settings, seed
│   ├── keyterms.json                  # Salesforce terms for transcription
│   └── pronunciations.pls             # alias rules for the voice
├── brand/                             # logo.png, font, music you own
├── remotion/                          # Intro.tsx, Outro.tsx
├── src/
│   ├── cli.ts                         # npm run polish -- <job>
│   ├── steps/                         # 01-probe … 12-deliver, one file per stage
│   └── lib/                           # ffmpeg.ts, elevenlabs.ts, cache.ts, timemap.ts
├── tests/                             # timemap unit tests, sample fixtures
└── jobs/<yyyy-mm-dd-slug>/
    ├── input/raw.mp4
    ├── work/                          # transcript.json, screen.json, script.json, tts/, edl.json
    └── output/                        # final.mp4, final.srt, thumbnail.png, report.md
```

Every stage reads from `work/` and writes to `work/`. A stage skips itself when its output is newer than its input. So a re-run after a script edit only repeats voice, plan and render.

## Build milestones

Build in ten steps. Do not start a step until the step before it passes its check.

**Test video (record this first):** 2 minutes, three "click here" actions, one slipped sentence that you repeat, one 10-second still pause, one 10-second page load.

| Step | What Claude Code builds | Done when |
| --- | --- | --- |
| M0 Setup check | `npm run doctor` | Node, ffmpeg, API key, voice_id and a blank Remotion render all pass |
| M1 Sample cleaner | `npm run clean-training <file>` | A 2-minute clone sample has no "uhm" and no gap over 0.7 s |
| M2 Transcribe + analyze | Stages 1 to 3 | `screen.json` shows the still pause and the page load at the right times |
| M3 Script + review | Stages 4 and 5 | Validator passes; the repeat is dropped; all three "click here" are anchors |
| M4 Voice | Stage 6 + cache, with the stock voice | Every sentence has audio and timings; a second run makes 0 API calls |
| M5 Planner | `timemap.ts` + unit tests | Tests pass for shorter audio, longer audio, still gap, moving gap, dropped sentence, anchors |
| M6 Body render | Stages 7 and 8 | Every anchor is within 150 ms; no cut happens while the screen moves |
| M7 Intro, outro, finish | Stages 9 and 10 | Intro and outro play; subtitles show; loudness is -14 LUFS ±1, true peak -1 dBTP or lower |
| M8 Your voice | Starter plan + Instant clone ID in `.env` | The test video renders in your clone's voice with no code change; both models compared |
| M9 Check, report, skill | Stages 11 and 12 + `SKILL.md` | `/polish-video jobs/test` runs end to end with one approval and writes `report.md` |

`report.md` lists: original vs clean text, every cut and speed change, anchor results, loudness numbers, and credits used (from the `character-cost` response header).

## Cost

**$0 to build, then $6 per month.** Build and test everything on the free plan with a stock voice. Then buy Starter for your Instant clone. Creator ($22) is only for a Professional clone.

Note: the web app view of Starter shows 30k credits, while the API view shows about 75 minutes of voice. ElevenLabs says API usage has lower rates than web app usage. Check your usage page after the first runs.

| Plan | Price | Voice per month (API) | Transcription per month | Voice clone |
| --- | --- | --- | --- | --- |
| Free | $0 | about 10 minutes | 4.5 hours | None (stock voices only) |
| Starter | $6 (first month $1 until Oct 18) | about 75 minutes | 27 hours | Instant |
| Creator | $22 (first month $11) | about 275 minutes | 100 hours | Instant + Professional |

A 10-minute final video needs 10,000 to 15,000 characters with one retry, so Starter fits about 5 to 7 such videos per month. Free plan output is for non-commercial use with attribution, so do not publish it. Claude Code is inside your Max plan. Remotion, ffmpeg and OBS cost $0.

Payment: ElevenLabs accepts credit cards, Apple Pay and Google Pay. Its docs say prepaid cards often fail.

## Risks and hard rules

**Hard rules** (copy these into `CLAUDE.md`):

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

| Risk | Fix |
| --- | --- |
| You say "click here" long before the click | Say the word at the moment of the click. The check flags any anchor over 150 ms. |
| Clone sounds flat | Record training audio with real teaching energy. Test `stability` and `style` settings. |
| Salesforce terms are wrong | `keyterms` for transcription, alias rules for the voice |
| Sentences sound disconnected | Request stitching, same model and `seed` every time |
| Credits run out | Cache every call. Set a credit quota on the API key. |
| Customer data on screen | Record only in a demo org |
| AI-generated music | YouTube requires disclosure for it. Use music you own. |
| Accent stays | You cannot change it after cloning. Change the samples instead. |

**Disclosure:** YouTube lists "cloning one's own voice to create voice overs or dubs" as content that needs no AI disclosure. Check the rules of any other platform you post on.

**Mentor note:** if the clone speaks in every video, you stop practicing spoken English. Use `original` mode for some videos.

**Bangla later:** `eleven_multilingual_v2` does not support Bengali. Switch to `eleven_v4`, which has no speed setting. Burn Bangla subtitles with the Noto Sans Bengali font. Test a clone made from a Bangla sample, because a clone from an English sample speaks fluent Bangla but not in your own accent.

## Prompt for the new project

Export this doc as Markdown and save it as `PLAN.md` in an empty folder. Open Claude Code in that folder. Fill in your OS, then paste the prompt below.

```text
You are building "screencast-studio": a Node.js + TypeScript pipeline that turns one raw screen recording into a finished video. The full spec is in PLAN.md at the repo root. Read all of it before you write code. PLAN.md wins over your own defaults.

My computer: <macOS or Windows>.
Language: English only for now. Start with a stock ElevenLabs voice on the free plan. I add my Instant Voice Clone in M8.

Rules:
- TypeScript on Node.js LTS. No Python.
- Call ffmpeg and ffprobe as child processes. Use the official @elevenlabs/elevenlabs-js SDK. Use Remotion for the intro and outro.
- Before you use an ElevenLabs endpoint, read its current docs page (add .md to any elevenlabs.io/docs URL). Do not trust memory for parameter names or limits.
- Build milestones M0 to M9 in order. After each one, run its "Done when" check, show me the result, and wait for my OK.
- Create .env.example. I fill .env myself. Never print the API key.
- Copy the hard rules from PLAN.md into CLAUDE.md.
- Stage 4 (script rewrite) is your job inside the session, not an API call. Follow the hard rules and the JSON schema you define in M3.
- Read the model from config/voice.json. The code must work with both eleven_multilingual_v2 and eleven_v4 (eleven_v4 has no speed setting).
- In M9, create .claude/skills/polish-video/SKILL.md so that "/polish-video jobs/<name>" runs the full pipeline, stops once at the review gate, then finishes alone.

Start with M0. First list the files you will create, then build them.
```

After M9, each new video is two steps: copy the recording to `jobs/<name>/input/raw.mp4`, then type `/polish-video jobs/<name>`.

## Sources

All pages opened on 17 October 2026.

- [ElevenLabs: Models](https://elevenlabs.io/docs/overview/models)
- [ElevenLabs: Eleven v4](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4)
- [ElevenLabs: Speech to Text overview](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)
- [ElevenLabs: Create transcript (API reference)](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- [ElevenLabs: Create speech with timing (API reference)](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
- [ElevenLabs: Stitching multiple requests](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching)
- [ElevenLabs: Instant Voice Cloning guide](https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning)
- [ElevenLabs: Professional Voice Cloning guide](https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning)
- [ElevenLabs: Professional Voice Cloning quickstart (API)](https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/professional-voice-cloning)
- [ElevenLabs: Models a Professional clone trains on](https://elevenlabs.io/docs/help-center/product/voices/voice-cloning/how-do-i-add-or-upgrade-the-models-used-to-train-my-professional-voice-clone)
- [ElevenLabs: Pronunciation dictionaries](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/pronunciation-dictionaries)
- [ElevenLabs: API keys](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys)
- [ElevenLabs: Billing](https://elevenlabs.io/docs/overview/administration/billing)
- [ElevenLabs: Pay As You Go](https://elevenlabs.io/docs/overview/administration/pay-as-you-go)
- [ElevenLabs: ElevenCreative pricing](https://elevenlabs.io/pricing)
- [ElevenLabs: ElevenAPI pricing](https://elevenlabs.io/pricing/api)
- [FFmpeg Filters Documentation](https://ffmpeg.org/ffmpeg-filters.html)
- [Remotion License](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)
- [Claude Code: Extend Claude with skills](https://code.claude.com/docs/en/skills)
- [YouTube Help: Disclosing use of GenAI content](https://support.google.com/youtube/answer/14328491)
- [browser-use/video-use](https://github.com/browser-use/video-use)
