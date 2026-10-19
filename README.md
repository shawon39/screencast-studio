# Screencast Studio

A local web app that turns one raw screen recording into a finished video. It cleans up what you said, speaks it again in an ElevenLabs voice, keeps every click in sync, and adds an intro, an outro and subtitles.

## Requirements

- macOS with Node.js 24 or newer
- ffmpeg, installed with [Homebrew](https://brew.sh) (`brew install ffmpeg`)
- [Claude Code](https://claude.com/claude-code), signed in. It rewrites the script.
- An ElevenLabs API key and a voice ID

## Costs

Prices checked on 2026-10-19.

- **Claude:** Claude Code needs a paid plan. [Pro](https://claude.com/pricing) is $20 a month ($17 a month billed yearly). The free plan does not include Claude Code.
- **ElevenLabs:** the [free plan](https://elevenlabs.io/pricing) (10k credits a month) is enough to try the app with a stock voice. For your own cloned voice or commercial use, you need Starter ($6 a month, 30k credits) or higher.
- Everything else is free. Remotion is free for individuals; see [License](#license).

## Setup

```bash
npm install
cp .env.example .env   # then fill in ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID
npm run doctor         # checks tools, keys and the voice
```

## Run

```bash
npm start
```

This opens http://localhost:4321. Brand settings live in `config/brand.json`. Put your logo, font and music in `brand/`.

## Tests

```bash
npm run typecheck
npm test
```

## License

MIT. See [LICENSE](LICENSE).

This project uses [Remotion](https://www.remotion.dev), which has its own license. It is free for individuals and companies of up to 3 people; larger companies need a Remotion company license. See [Remotion's pricing page](https://www.remotion.dev/docs/license/pricing).
