# ScrubFlow — video verification for motion the eye misses

## What it does

Interceptor screenshots freeze one moment. A stuttering fade, a dropped transition, a menu that flickers on open, a skeleton state that never resolves — none of that shows up in a still. ScrubFlow captures the flow as a short video, then extracts frames the model can actually view, so motion bugs get caught before a claim of "works" ships.

Required by Algorithm Verification Rule 1: a **motion/interaction ISC** (animation, transition, drag, hover-state, scroll behavior, loading/skeleton state, or a multi-step flow) closes ONLY on a ScrubFlow gallery or a VerifyDeploy flow-gallery — never a single screenshot.

## The mechanism: `Tools/FrameScrub.ts`

Turns a recording into viewable, scored evidence. Two modes:

```bash
# survey — N evenly-spaced frames across the whole clip (overview)
bun Tools/FrameScrub.ts <recording> survey --frames 8

# scrub — dense frames at F fps in a ±window around a suspect moment,
# each SSIM-scored against the previous; the biggest-change frame is flagged
bun Tools/FrameScrub.ts <recording> scrub --at 4.2 --window 1.5 --fps 8
```

Output: PNG frames + a `manifest.json` (`{video, mode, frame_count, flagged_frame, min_ssim, extracted:[{frame, path, timestamp_s, ssim_to_prev}]}`). **Survey answers "does the flow broadly work"; scrub answers "does the animation at 4.2s render clean." The SSIM flag points the model at the frame with the most change so it looks at the motion, not twelve near-identical stills.**

Verify a motion ISC by opening the flagged frame (and its neighbors) with Read, then cite the manifest path — `VerificationGate` (T2) accepts a `frames/…/manifest.json` as flow-exercised evidence.

## Getting the recording

**Path A — bring your own (works today).** Any `.webm` / `.mov` / `.mp4` — a QuickTime capture, a Descript export, a screen recording you already have — feeds straight into FrameScrub. Fully functional now.

**Path B — auto-record the browser flow (next increment, designed not shipped).** Add a `MediaRecorder` to the extension's existing tab `MediaStream` (`offscreen.js` `startCapture()` already opens the stream for still capture; `captureFrame()` pulls one frame — recording taps the same stream). Emits `.webm` (MediaRecorder on Chrome is webm/vp8-vp9; mp4 muxing is inconsistent — do NOT assume mp4). `screencapture` stays banned; this records in-page with zero CDP fingerprint, consistent with Interceptor.

## Gotchas

- **Focused-tab requirement.** Chrome throttles tab capture when the tab is backgrounded — a backgrounded recording can yield frozen or garbage frames that then falsely pass the gate. ScrubFlow must record with the target tab foregrounded; if focus can't be guaranteed, downgrade to "recorded, not scrub-verified", never claim clean.
- **Cite the manifest, not the raw video.** "video.mp4 exists" is not proof it rendered right. The evidence is the frames the model viewed — the manifest.
- **webm, not mp4.** MediaRecorder emits webm. FrameScrub handles any container ffmpeg reads; just don't hardcode mp4 in Path B.
- **Scrub, don't just survey, for animation.** Even-spaced survey sampling of a 2s window can straddle a 0.4s stutter. Use scrub mode (dense fps) around the suspect timestamp for anything sub-second.
