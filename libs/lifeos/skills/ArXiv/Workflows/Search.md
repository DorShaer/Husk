# Search — Find Papers by Topic or Keywords

Search arXiv for papers matching specific topics, keywords, or author names.

## Input

User provides a search query: topic, keywords, author name, or a combination.

## Steps

**1. Build the search query**

Map user intent to arXiv query syntax:
- Topic/keywords → `all:{query}` or `ti:{query}+AND+abs:{query}` for tighter matches
- Author search → `au:{name}`
- Combined → chain with `AND`/`OR`

URL-encode spaces as `+`, special chars as `%XX`.

Examples:
- "papers on prompt injection" → `all:prompt+injection`
- "LLM agent papers by Shunyu Yao" → `au:Yao+AND+all:agent`
- "retrieval augmented generation security" → `ti:retrieval+augmented+generation+AND+abs:security`

**2. Fetch results**

```bash
curl -sL "https://export.arxiv.org/api/query?search_query=QUERY&sortBy=submittedDate&sortOrder=descending&start=0&max_results=15"
```

Use `submittedDate` sort for search (vs `lastUpdatedDate` for latest) — the user wants the most relevant recent work, not old papers with minor edits.

**3. Parse and filter**

Extract same fields as Latest workflow. Filter out:
- Papers older than 12 months (unless the user specifically asks for older work)
- Papers with low relevance (title/abstract don't match intent)

**4. AlphaXiv enrichment**

Try AlphaXiv overview for top 3-5 results:
```bash
curl -s "https://alphaxiv.org/overview/PAPER_ID.md"
```

**5. Present results**

Same format as Latest workflow but with relevance-ordered results (most relevant first, not just most recent).

Add a "Related searches" section at the end if the query could be refined:
```markdown
## Related Searches
- Try `cat:cs.CR+AND+all:prompt+injection` for security-focused results
- Try `au:Smith+AND+cat:cs.CL` to narrow by category
```
