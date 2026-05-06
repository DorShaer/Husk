---
name: debug-this-error
description: Guided error triage. I paste the error and any context, you walk me from "what does this mean" to "here is the fix" without guessing.
---

Help me debug an error.

If I have not shared the error yet, ask me ONE short question:
  "Paste the error / stack trace / log lines, plus the command or code that triggered it."
and wait.

Once you have the error, work in this order. Do not skip steps. Do not guess the fix.

1. **Read the error literally.** Quote back the exact line that names the failure, including file path and line number when present. Strip framing. Strip noise.

2. **Translate.** One sentence: what is the program complaining about, in human terms.

3. **Narrow the cause.** Three plausible causes, ranked by likelihood given the visible evidence. For each, name what I should check to confirm or rule out.

4. **Ask before fixing.** If the most-likely cause needs information you don't have (file contents, config, version), ask me the smallest question that disambiguates. ONE question. Wait.

5. **Propose the fix.** Concrete diff or steps. If multiple fixes exist (workaround vs root cause), name both and say which you recommend and why.

6. **Verify.** Tell me how to confirm the fix worked: a command, a log line to grep for, a test to run.

Hard rules:
- No "this could be many things". If you genuinely don't know, ask.
- No hallucinated APIs / flags / file paths. If you cite something, it must come from the error or the file I shared.
- No rewriting unrelated code. Surgical fix only.
