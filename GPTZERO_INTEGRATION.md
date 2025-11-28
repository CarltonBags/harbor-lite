# GPTZero Integration for Thesis Generation

## Overview

This document explains the GPTZero integration that automatically checks and improves the "human-written" score of generated theses during the generation process.

## Problem

Generated theses were scoring only **15% human-written** on GPTZero, which is not acceptable. The API returns specific sentences that were flagged as AI-generated.

## Solution

A three-step approach has been implemented in the thesis generation worker:

### 1. GPTZero Check Function (`checkWithGPTZero`)

- Calls the ZeroGPT API via RapidAPI
- Extracts plain text from markdown
- Returns:
  - `isHumanWritten`: Percentage (0-100)
  - `isGptGenerated`: Percentage (0-100)
  - `gptGeneratedSentences`: Array of flagged sentences

### 2. Sentence Rewriting Function (`rewriteFlaggedSentences`)

- Takes flagged sentences and rewrites them using **Gemini 2.5 Flash** (cheaper model)
- Processes sentences in batches of 10
- Preserves:
  - ALL facts and data
  - ALL citations (e.g., "(Autor, 2021, S. 15)")
  - Original meaning
- Makes sentences:
  - More varied in length and structure
  - More natural and human-like
  - Free of AI-typical phrases

### 3. Iterative Improvement Function (`ensureHumanLikeContent`)

- Target: **≥70% human-written score**
- Maximum 2 iterations to avoid infinite loops
- Process:
  1. Check content with GPTZero
  2. If score < 70%, rewrite flagged sentences
  3. Check again
  4. Repeat if needed (max 2 times)

## Integration into Workflow

The GPTZero check is integrated into the thesis generation workflow as **Step 7.4**, positioned between:

- **Step 7**: Generate Thesis Content (using Gemini Pro with RAG)
- **Step 7.4**: GPTZero Check & Sentence Rewrite (NEW)
- **Step 7.5**: Humanize Thesis Content (existing full-text humanization)

This ensures that:
1. Content is generated
2. Flagged sentences are rewritten with Gemini Flash
3. Full humanization pass is applied
4. Final content has high human-written score

## Cost Optimization

- Uses **Gemini 2.5 Flash** for sentence rewriting (cheaper than Pro)
- Only rewrites flagged sentences, not entire content
- Processes in batches to avoid token limits
- Maximum 2 iterations to control costs

## Configuration

Requires `RAPIDAPI_KEY` environment variable for ZeroGPT API access. If not configured, the check is skipped gracefully.

## Logging

The implementation includes comprehensive logging:
- `[GPTZero]` - API checks and results
- `[Rewrite]` - Sentence rewriting progress
- `[HumanCheck]` - Overall process status

## Example Output

```
[GPTZero] Checking content for AI detection...
[GPTZero] Results: 15% human, 85% AI-generated
[GPTZero] Flagged 127 sentences
[HumanCheck] ⚠️ Content scored 15% human (below 70%)
[HumanCheck] Rewriting 127 flagged sentences...
[Rewrite] Processing batch 1/13
[Rewrite] Processing batch 2/13
...
[Rewrite] Sentence rewriting completed
[HumanCheck] Checking again...
[GPTZero] Results: 73% human, 27% AI-generated
[HumanCheck] ✓ Content passed with 73% human score
```

## Error Handling

- If GPTZero API fails, continues with original content
- If rewriting fails, continues with original content
- Gracefully handles missing RAPIDAPI_KEY
- Logs all errors for debugging

## Future Improvements

1. Adjust `MIN_HUMAN_SCORE` threshold based on requirements
2. Increase `MAX_ITERATIONS` if needed
3. Fine-tune rewriting prompts for better results
4. Add caching to avoid re-checking same content
