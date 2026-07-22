# Latest — Browse Recent Papers by Category

Get the most recent papers in a category or set of categories.

## Input

User provides a topic area (e.g., "AI agents", "LLM security", "machine learning"). Map to arXiv categories. If ambiguous, use multiple categories with OR.

## Steps

**1. Map topic to categories**

Common mappings:
| Topic | Categories |
|-------|-----------|
| AI, artificial intelligence | `cs.AI` |
| machine learning, ML, deep learning | `cs.LG` |
| LLMs, NLP, language models | `cs.CL` |
| security, cybersecurity | `cs.CR` |
| agents, multi-agent | `cs.MA+OR+cs.AI` |
| software engineering | `cs.SE` |
| robotics | `cs.RO` |
| computer vision | `cs.CV` |
| information retrieval, RAG | `cs.IR` |

If the user specifies a category directly, use it as-is.

**2. Fetch latest papers**

```bash
curl -sL "https://export.arxiv.org/api/query?search_query=cat:CATEGORY&sortBy=lastUpdatedDate&sortOrder=descending&start=0&max_results=15"
```

For multiple categories:
```bash
curl -sL "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.MA&sortBy=lastUpdatedDate&sortOrder=descending&start=0&max_results=15"
```

**3. Parse the Atom XML response**

Extract from each `<entry>`:
- `<title>` — paper title (strip newlines)
- `<id>` — extract paper ID from URL (e.g., `2603.12345`)
- `<published>` — submission date
- `<summary>` — abstract (first 2-3 sentences)
- `<author><name>` — first 3 authors + "et al." if more
- `<arxiv:primary_category>` — primary category

**4. Attempt AlphaXiv enrichment for top 3-5 papers**

For the most interesting papers (judge by title/abstract relevance to the user's interests — AI agents, security, LLM infrastructure, personal AI):

```bash
curl -s "https://alphaxiv.org/overview/PAPER_ID.md"
```

If 200: use the enriched overview. If 404: fall back to the abstract.

**5. Present results**

Format as a scannable list. Lead with the papers most relevant to our work.

```markdown
## Latest in {Category} — {Date}

### {Paper Title}
**{Authors}** | {Date} | `{paper_id}`
{2-3 sentence abstract or AlphaXiv summary}
**Why it matters:** {1 sentence on relevance to our work}

---
[... more papers ...]
```

For each paper, include:
- The arxiv link: `https://arxiv.org/abs/{paper_id}`
- If AlphaXiv overview exists: `https://alphaxiv.org/abs/{paper_id}`

**6. Highlight picks**

End with a "Papers worth reading" section — 2-3 papers most relevant to the user's interests (AI infrastructure, security, agents, LLMs, personal AI systems). Brief explanation of why each matters.
