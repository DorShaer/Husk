---
name: poc
description: Build a proof of concept exploit for a vulnerability. Create a single, clean, working script with minimal output. Use when a vulnerability has been identified and needs validation.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent
---

Build a proof of concept for: $ARGUMENTS

Rules:

1. Single file. Python unless the target requires something else. No unnecessary dependencies.

2. Minimal comments. Only explain what is not obvious from the code itself.

3. Clean output. The person running it should see what is happening at each step without walls of text. Use short log lines with timestamps and tags.

4. No hardcoded credentials or secrets. Take them as command-line arguments.

5. Include proof collection. The script should gather evidence that the vulnerability was triggered (log entries, HTTP responses, error messages, screenshots). Do not claim success without evidence.

6. Do not add explanatory output blocks at the end. No "attack flow" summaries, no "vulnerable code" references. That belongs in the report, not the exploit.

7. Test that the script runs without syntax errors before presenting it.

8. If the PoC requires infrastructure (DNS server, fake API, etc), include it in the same script with different modes (like --server-mode). Keep it self-contained.
