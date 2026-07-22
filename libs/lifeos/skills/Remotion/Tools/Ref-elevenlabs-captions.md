---
name: elevenlabs-captions
description: Convert ElevenLabs Speech-to-Text output into Remotion Caption objects
metadata:
  tags: elevenlabs, captions, stt, speech-to-text, transcription, scribe
---

# ElevenLabs captions

`@remotion/elevenlabs` converts ElevenLabs Speech-to-Text (Scribe) output into the `Caption[]` format consumed by `@remotion/captions` (`createTikTokStyleCaptions`, etc.). Available from Remotion v4.0.443.

## Install

```bash
bunx remotion add @remotion/elevenlabs
bunx remotion add @remotion/captions
```

## Flow

1. Transcribe audio with the ElevenLabs STT API → raw `ElevenLabsTranscript` JSON
2. Convert to `Caption[]` with `elevenLabsTranscriptToCaptions()`
3. Render via `createTikTokStyleCaptions()` (see `Ref-display-captions.md`)

## Minimal example

```tsx
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { elevenLabsTranscriptToCaptions } from '@remotion/elevenlabs';
import type { ElevenLabsTranscript } from '@remotion/elevenlabs';
import fs from 'node:fs';

const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

const transcript = (await client.speechToText.convert({
  file: fs.createReadStream('narration.mp3'),
  modelId: 'scribe_v1',
})) as ElevenLabsTranscript;

const { captions } = elevenLabsTranscriptToCaptions({ transcript });
// captions: Caption[] — pass to createTikTokStyleCaptions()
```

## When to use vs alternatives

| Source | Cost | Speed | Best for |
|--------|------|-------|----------|
| `@remotion/elevenlabs` (Scribe API) | paid per minute | fast, cloud | already using ElevenLabs, want speaker labels |
| `@remotion/openai-whisper` | paid per minute | fast, cloud | highest quality, 57+ languages |
| `@remotion/install-whisper-cpp` | free | fast on server, needs setup | batch, self-hosted |
| `@remotion/whisper-web` | free | slow (WASM) | browser-only, no backend |

## For already-known scripts

If you generated the audio from a known script via ElevenLabs TTS, you don't need STT — use `@remotion/captions` directly with timed tokens. STT→captions is for audio where the script isn't authoritative (user uploads, podcasts, interviews).

See also: `Ref-display-captions.md`, `Ref-transcribe-captions.md`.
