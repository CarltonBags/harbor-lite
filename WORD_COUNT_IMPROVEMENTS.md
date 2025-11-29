# Thesis Word Count Management Improvements

## Problem Statement
The thesis generation worker was producing theses that exceeded the requested length by more than 10%. For example:
- Requested: 25,000 words
- Received: 34,000 words (36% overshoot)
- Expected: Maximum 27,500 words (10% overshoot)

Additionally, the generated theses lacked sufficient citations and did not include a Literaturverzeichnis (bibliography).

## Changes Made

### 1. **Reduced Maximum Word Count Overshoot (10% instead of 15%)**
- **File**: `workers/thesis-generation-worker.ts`
- **Lines**: 1486, 1880
- **Change**: `Math.ceil(targetWordCount * 1.15)` → `Math.ceil(targetWordCount * 1.10)`
- **Impact**: Stricter word count limits to prevent excessive overshoot

### 2. **Improved Thesis Plan Generation with Word Ranges**
- **File**: `workers/thesis-generation-worker.ts`
- **Lines**: 1497-1542
- **Changes**:
  - Added requirement for word count RANGES per chapter (e.g., "2000-2200 words")
  - Added verification step to ensure total planned words = 95-100% of target
  - Added explicit instruction that bibliography is NOT counted in word total
  - Added citation planning (1 citation per 200 words minimum)
  - Added chapter distribution summary in plan output
  - Emphasized STRICT MAX limit with clearer warnings

### 3. **Enhanced Chapter Word Target Extraction**
- **File**: `workers/thesis-generation-worker.ts`
- **Lines**: 1597-1625
- **Changes**:
  - Added support for parsing word ranges (e.g., "2000-2200")
  - Uses the LOWER bound of ranges to be conservative
  - Added logging for chapter planning transparency
  - Improved adjustment logic (10% threshold instead of arbitrary 200 words per chapter)
  - Better validation and error handling

### 4. **Increased Citation Density Requirement (Dynamic)**
- **File**: `workers/thesis-generation-worker.ts`
- **Lines**: 1532 (Plan), 2053 (German prompt)
- **Change**: `1 citation per 300 words` → `1 citation per 200 words` → **`1 citation per 150 words`**
- **Impact**: 
  - For a 10,000-word thesis: 33 citations → 50 citations → **67 citations minimum**
  - For a 25,000-word thesis: **167 citations minimum**
  - Now dynamically calculated: `Math.ceil(targetWordCount / 150)`

### 5. **Reduced Generation Buffer**
- **File**: `workers/thesis-generation-worker.ts`
- **Line**: 2632
- **Change**: `1.25 (25% buffer)` → `1.12 (12% buffer)`
- **Impact**: Less room for the AI to overshoot during generation

### 6. **Added Critical Word Count Management Instructions**
- **File**: `workers/thesis-generation-worker.ts`
- **Lines**: 2021-2036 (German), 2365-2380 (English)
- **Added**:
  ```
  **KRITISCH - WORTANZAHL-MANAGEMENT:**
  - Ziel: ${targetWordCount} Wörter (ohne Literaturverzeichnis)
  - Absolutes Maximum: ${maxWordCount} Wörter (= ${targetWordCount} + 10%)
  - Das Literaturverzeichnis wird NICHT zur Wortanzahl gezählt
  - STOPPE die Hauptkapitel bei ca. ${targetWordCount} Wörtern, BEVOR du das Literaturverzeichnis schreibst
  - Überschreite NIEMALS ${maxWordCount} Wörter im Haupttext (vor dem Literaturverzeichnis)
  - Eine Überschreitung von mehr als 10% ist INAKZEPTABEL und führt zur Ablehnung
  ```

## Expected Outcomes

### For a 25,000-word thesis request:
- **Target**: 25,000 words (main content, excluding bibliography)
- **Maximum**: 27,500 words (10% overshoot)
- **Minimum Citations**: **167 citations** (1 per 150 words)
- **Bibliography**: Must be present and complete with all cited sources
- **Chapter Planning**: Each chapter will have a specific word range target
  - Example for 5 chapters:
    - Chapter 1 (Introduction): 2,500-2,750 words
    - Chapter 2: 5,500-6,000 words
    - Chapter 3: 5,500-6,000 words
    - Chapter 4: 5,500-6,000 words
    - Chapter 5 (Conclusion): 2,500-2,750 words
    - Total: 21,500-23,500 words (conservative planning)
    - Bibliography: ~500-1,000 words (not counted)

## How It Works

1. **Planning Phase** (`generateThesisPlan`):
   - AI creates a detailed plan with word ranges for each chapter
   - Ensures total planned words = 95-100% of target
   - Plans citation distribution (1 per 200 words)

2. **Extraction Phase** (`extractChapterWordTargets`):
   - Parses word ranges from the plan
   - Uses LOWER bound to be conservative
   - Adjusts if total is off by more than 10%

3. **Generation Phase** (`generateChapterContent`):
   - Generates each chapter according to its word target
   - Stops at target word count before bibliography
   - Maximum buffer of 12% instead of 25%

4. **Extension Phase** (`extendThesisContent`):
   - Only extends if below target
   - Respects the 10% maximum overshoot limit

## Testing Recommendations

1. Test with a 25,000-word thesis request
2. Verify final word count is between 25,000-27,500 words (excluding bibliography)
3. Verify bibliography is present and contains all cited sources
4. Verify citation density is at least 1 per 150 words (167+ citations for 25,000 words)
5. Check that chapter word counts match the planned ranges

## Notes

- The bibliography (Literaturverzeichnis) is explicitly excluded from word count calculations
- The system now uses conservative estimates (lower bounds of ranges) to avoid overshooting
- Citation requirements have been increased to ensure proper academic rigor
- All prompts now emphasize the 10% limit as ABSOLUTE MAXIMUM
