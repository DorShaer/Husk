# Paper — Deep-Dive a Specific Paper

Get a structured overview of a specific arXiv paper using AlphaXiv enrichment with arXiv metadata fallback.

## Input

User provides one of:
- arXiv URL (`https://arxiv.org/abs/2603.12345` or `https://arxiv.org/pdf/2603.12345`)
- AlphaXiv URL (`https://alphaxiv.org/abs/2603.12345`)
- Paper ID (`2603.12345` or `2603.12345v2`)

## Steps

**1. Extract paper ID**

Strip to just the numeric ID (e.g., `2603.12345`). Remove version suffixes for AlphaXiv lookup (it uses latest).

**2. Try AlphaXiv overview first**

```bash
curl -s "https://alphaxiv.org/overview/PAPER_ID.md"
```

If 200: this is the primary source. It returns a structured markdown analysis optimized for language models.

**3. Fetch arXiv metadata regardless**

```bash
curl -sL "https://export.arxiv.org/api/query?id_list=PAPER_ID"
```

Extract: title, authors, abstract, categories, published date, updated date, DOI if present.

**4. If AlphaXiv 404'd, try full text**

```bash
curl -s "https://alphaxiv.org/abs/PAPER_ID.md"
```

If this also 404s, work from the abstract only. Mention that the user can read the full PDF at `https://arxiv.org/pdf/PAPER_ID`.

**5. Present the paper**

```markdown
# {Paper Title}

**Authors:** {full author list}
**Published:** {date} | **Categories:** {cats}
**Links:** [arXiv](https://arxiv.org/abs/ID) | [PDF](https://arxiv.org/pdf/ID) | [AlphaXiv](https://alphaxiv.org/abs/ID)

## Overview
{AlphaXiv overview or abstract-based summary}

## Key Contributions
{3-5 bullets on what's new/important}

## Relevance to Our Work
{How this connects to LifeOS, AI agents, security, LLM infrastructure, or the user's interests}

## Worth Reading?
{Honest assessment: skim, read, or skip — and why}
```
