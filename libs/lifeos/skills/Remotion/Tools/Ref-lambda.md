---
name: lambda
description: Render Remotion videos on AWS Lambda for fast, parallel, scalable cloud rendering
metadata:
  tags: lambda, aws, cloud, rendering, scale, parallel, production
---

# Remotion Lambda

Render videos on AWS Lambda. Chunks render in parallel across hundreds of Lambda invocations, then the primary function stitches the output. A 3-minute video renders in ~30 seconds instead of minutes.

## Prerequisites

- AWS account with IAM user (Remotion Lambda policy attached — see docs)
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in environment
- `@remotion/lambda` installed in the project

```bash
bunx remotion add @remotion/lambda
```

## One-time setup (per AWS region)

Deploy the Lambda function. Reusable across all your projects in that region.

```bash
bunx remotion lambda functions deploy
```

List existing functions:

```bash
bunx remotion lambda functions ls
```

## Per-project: deploy the site

Your Remotion project deploys as a static site to S3.

```bash
bunx remotion lambda sites create src/index.ts --site-name=my-project
```

List sites:

```bash
bunx remotion lambda sites ls
```

## Render a video

```bash
bunx remotion lambda render <site-url> <composition-id> \
  --props='{"title":"Hello"}' \
  --codec=h264 \
  --privacy=private
```

The CLI prints a render ID. Track progress:

```bash
bunx remotion lambda progress <bucket-name> <render-id>
```

## Programmatic render

```tsx
import { renderMediaOnLambda, getRenderProgress } from '@remotion/lambda/client';

const { renderId, bucketName } = await renderMediaOnLambda({
  region: 'us-east-1',
  functionName: 'remotion-render-...',
  serveUrl: 'https://remotionlambda-....s3.amazonaws.com/sites/my-project/index.html',
  composition: 'my-video',
  inputProps: { title: 'Hello' },
  codec: 'h264',
  privacy: 'private',
});

while (true) {
  const progress = await getRenderProgress({
    renderId,
    bucketName,
    functionName: 'remotion-render-...',
    region: 'us-east-1',
  });
  if (progress.done) {
    console.log('Output:', progress.outputFile);
    break;
  }
  if (progress.fatalErrorEncountered) throw new Error(progress.errors[0]?.message);
  await new Promise((r) => setTimeout(r, 1000));
}
```

## Constraints

- **No AV1 on Lambda** — use h264, h265, vp8, vp9, or prores.
- Max ~2 hours Full HD per render (5GB output limit).
- Default 1000 concurrent Lambda per region (requestable higher from AWS).
- Commercial use requires Remotion Cloud Rendering Units (paid license).

## When to use Lambda vs local

- **Local:** iteration, previews, single videos, non-time-critical work.
- **Lambda:** batch pipelines, production, turning 10-minute renders into 30-second renders, overnight jobs.

## Reference

- Docs: https://www.remotion.dev/docs/lambda
- Pricing: https://www.remotion.dev/docs/lambda/pricing
- IAM policy: https://www.remotion.dev/docs/lambda/permissions
