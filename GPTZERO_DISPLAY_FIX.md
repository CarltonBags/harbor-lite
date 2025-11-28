# GPTZero Display Fix

## Problem
The GPTZero modal was always showing "Kein ZeroGPT-Ergebnis verfügbar" (No ZeroGPT result available) even after:
1. Automatic generation with GPTZero check
2. Manual GPTZero check via button

## Root Cause
The GPTZero result was not being saved to the thesis metadata in the database.

## Solution

### 1. Updated Worker to Save GPTZero Result

**Modified `ensureHumanLikeContent` function** to return both content and result:
```typescript
async function ensureHumanLikeContent(content: string, thesisData: ThesisData): Promise<{
  content: string
  zeroGptResult: {
    isHumanWritten: number
    isGptGenerated: number
    wordsCount?: number
    checkedAt: string
    feedbackMessage?: string
  } | null
}>
```

**Updated the call site** to destructure and store the result:
```typescript
const result = await ensureHumanLikeContent(thesisContent, thesisData)
thesisContent = result.content
zeroGptResult = result.zeroGptResult
```

**Added to metadata** when saving thesis:
```typescript
// Add ZeroGPT result if available
if (zeroGptResult) {
  updateData.metadata.zeroGptResult = zeroGptResult
  console.log('[PROCESS] Saving ZeroGPT result to metadata:', zeroGptResult)
}
```

### 2. Improved Manual Check Handler

**Added success message to chat** after manual check:
```typescript
const successMessage: ChatMessage = {
  id: Date.now().toString(),
  role: 'assistant',
  content: `✓ ZeroGPT-Check abgeschlossen:\n\n**Menschlich geschrieben:** ${data.result.isHumanWritten}%\n**KI-generiert:** ${data.result.isGptGenerated}%\n\nDas Ergebnis wurde gespeichert.`,
  timestamp: new Date(),
}
setChatMessages(prev => [...prev, successMessage])
```

**Replaced alert with chat message** for errors:
```typescript
const errorChatMessage: ChatMessage = {
  id: Date.now().toString(),
  role: 'assistant',
  content: `❌ Fehler beim ZeroGPT-Check: ${errorMessage}`,
  timestamp: new Date(),
}
setChatMessages(prev => [...prev, errorChatMessage])
```

## How It Works Now

### During Thesis Generation:
1. Content is generated (Step 7)
2. **GPTZero check runs automatically** (Step 7.4)
   - Checks content
   - Rewrites flagged sentences if score < 70%
   - Returns final content + GPTZero result
3. Humanization pass (Step 7.5)
4. **Result is saved to `thesis.metadata.zeroGptResult`**

### Manual Check:
1. User clicks "ZeroGPT" button
2. API checks content
3. Result is saved to `thesis.metadata.zeroGptResult`
4. Thesis data is reloaded
5. Success message appears in chat
6. Modal shows the result

## Data Structure

The GPTZero result is stored in the thesis metadata as:
```typescript
{
  metadata: {
    zeroGptResult: {
      isHumanWritten: 73,        // Percentage
      isGptGenerated: 27,        // Percentage
      wordsCount: 8542,          // Optional
      checkedAt: "2025-11-28T10:15:00.000Z",
      feedbackMessage: ""        // Optional
    }
  }
}
```

## UI Display

The modal checks for `thesis?.metadata?.zeroGptResult` and displays:
- ✅ If available: Shows percentages, word count, check date
- ❌ If not available: Shows "Kein ZeroGPT-Ergebnis verfügbar" with check button

## Testing

To verify the fix works:
1. Generate a new thesis → Check modal shows result
2. Click "ZeroGPT" button → Result updates in modal
3. Reload page → Result persists

## Benefits

1. **Automatic checking** during generation
2. **Persistent results** saved to database
3. **Better UX** with chat messages instead of alerts
4. **Transparency** - users can see their AI detection score
