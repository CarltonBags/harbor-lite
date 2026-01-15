# Humanizer Pipeline Explained

This document details the inner workings of the Humanizer application, explaining how it transforms AI-generated text into human-like academic writing provided by the backend.

## 1. High-Level Workflow (Worker)

The process is orchestrated by a BullMQ worker (`backend/src/worker.ts`) to handle long-running tasks efficiently.

1.  **Job Reception**: The worker receives a job containing the text and metadata (Language: English/German, Tone: Academic/Casual).
2.  **Chunking**: The text is split into manageable chunks (~800 words) to fit within AI context windows while maintaining narrative flow.
3.  **Parallel Processing**: All chunks are processed **in parallel** by the AI pipeline to maximize speed.
4.  **Formatting**: The final text is formatted to mimic a scanned PDF (line wrapping, hyphenation).
5.  **Verification**: The result is sent to Winston AI to calculate the "Human Score".
6.  **Storage**: The result and scores (before/after) are saved to the database.

---

## 2. The AI Pipeline Steps

The core transformation occurs in `backend/src/services/humanizer.ts`, which runs the following 6-step pipeline for each chunk:

### Step 1: Analysis (`DiscourceAnalyzer`)
*   **Goal**: Understands the structure and flaws of the input text using a hybrid approach (Heuristics + Logic).
*   **Mechanism**:
    1.  **Sentence Splitting**: Breaks paragraph into sentences.
    2.  **Burstiness Check**: Calculates variance in sentence length. Low variance (< 5) flags `high_sentence_uniformity` (a common AI trait).
    3.  **Connectivity Check**: Scans for "AI transitions" (e.g., "Moreover", "Furthermore"). High density triggers `explicit_transition_density`.
    4.  **Punctuation Profile**: Counts usage of dashes, colons, and parentheses to establish a baseline.

### Step 2: Planning (`HumanizationPlanner`)
*   **Goal**: Decides *what* to change without writing text yet.
*   **Strategy**:
    1.  **Budgeting**: Sets a modification budget (max 35% of sentences) to avoid over-editing.
    2.  **Rule Application**:
        -   **Long Sentences (>35 words)**: Planned for `sentence_split`.
        -   **Short Sentences (<10 words)**: Planned for `sentence_combine` with neighbors.
        -   **Uniformity**: If `high_sentence_uniformity` flag is set, it forces `rhythm_variation`.
        -   **Random Hedge**: Randomly injects `add_hedge` instructions to increase uncertainty.
    3.  **Result**: Produces a structured `ParagraphPlan` that the Rewriter must strictly follow.

### Step 3: Rewriting (`SentenceRewriter`)
*   **Goal**: Applies the planned changes using a targeted LLM prompt.
*   **Prompt Key**:
    > "You are an expert editor. Rewrite the following paragraph by applying the specific modifications listed below... Only modify the sentences specified."

### Step 4: Punctuation/Flow (`SteuerzeichenCalibrator`)
*   **Goal**: Breaks the rigid "AI rhythm" using advanced punctuation.
*   **Prompt Key**:
    > "You are a 'Steuerzeichen' (Punctuation and Flow) specialist... Principles: Variance > Frequency... Balance... Rhythm."
*   **Effect**: Injects colons, semi-colons, and dashes to create a more natural, human-like reading flow.

### Step 5: Voice Calibration (`VoiceCalibrator`)
*   **Goal**: Injects "human imperfection" and academic caution.
*   **Prompt Key**:
    > "Restore 'human authorial caution' (hedging)... AI often makes absolute statements... Humans hedge ('This suggests X')... Use phrases like 'It is worth noting that...'."

### Step 6: Integrity Validation (`Validator`)
*   **Goal**: Safety check to ensure facts and citations haven't been corrupted.
*   **Action**:
    1.  **Citation Check**: Regex verification to ensure citations `(Author, Year)` are preserved.
    2.  **Semantic Check**: LLM compares Original vs. Candidate to ensure core meaning is unchanged.
*   **Rollback**: If validation fails, the system **reverts to the safe text** but *still applies formatting*.

---

## 3. Detailed Prompt Engineering

The system uses specific prompts for the `gemini-2.5-pro` model. Here are the core instructions provided to the AI:

### A. The Rewriter Prompt
```text
You are an expert editor. Rewrite the following paragraph by applying the specific modifications listed below.

CRITICAL RULES:
1. Only modify the sentences specified. Leave others EXACTLY as they are.
2. Keep the meaning unchanged.
3. Maintain academic tone.

Paragraph: "[TEXT]"
Modifications: "- Sentence 1: Apply [Combine with next, Add connective]"

Language: [English/German]
Strict Formatting: PRESERVE all Markdown headers...
```

### B. The Voice Calibrator Prompt
```text
You are an Academic Voice Calibrator. Your goal is to restore "human authorial caution" (hedging) and stance.

Rules:
1. **Hedging**: Inject hedges for interpretations ("This suggests..."). NEVER hedge facts/citations.
2. **Authorial Presence**: Use phrases like "It is worth noting that...".
3. **Tone**: "Knowledgeable peer" - confident but careful.
```

### C. The Punctuation ("Steuerzeichen") Prompt
```text
You are a "Steuerzeichen" specialist.
Principles:
1. **Variance > Frequency**: Avoid repeating the same mark.
2. **Balance**: Swap dashes for parentheses if overused.
3. **Rhythm**: Punctuation guides the breath.
Constraint: Do NOT rewrite words. ONLY adjust punctuation.
```

---

## 4. Document Formatting ("PDF Style")

To further fool AI detectors (which often expect clean, perfect digital text), we apply a "Scanned Document" formatting layer in `backend/src/lib/formatter.ts`.

**Rules Applied:**
1.  **Single Spacing**: Removes double newlines between paragraphs (`\n\n` -> `\n`).
2.  **Line Wrapping**: Hard-wraps text at **90 characters**.
3.  **Hyphenation**:
    *   If a word at the end of a line is longer than **6 characters**, it is split.
    *   **Style**: `Part1` + `- ` (hyphen + space) + `\n` + `Part2`.
    *   *Example*: `Infe- ction` (This mimics OCR artifacts or manual typing).

**Code Logic:**
```typescript
if (currentLine.length + 1 + word.length <= 90) {
    currentLine += ' ' + word;
} else {
    // Inject Hyphen Artifact
    if (word.length > 6) {
        const splitIdx = Math.floor(word.length / 2);
        currentLine += ' ' + part1 + '- '; // Note the space after hypen
        lines.push(currentLine);
        currentLine = part2;
    }
}
```

