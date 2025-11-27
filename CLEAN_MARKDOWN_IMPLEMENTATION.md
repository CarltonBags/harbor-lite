# Clean Markdown Content Implementation

## Overview
We've implemented a new system to store a clean, properly formatted Markdown version of thesis content specifically for exports (DOCX, PDF, etc.). This solves the formatting issues with Pandoc exports.

## What Was Added

### 1. Database Schema Change
- **New Column**: `clean_markdown_content` (TEXT) in the `theses` table
- **Migration File**: `supabase/migrations/20251127_add_clean_markdown_content.sql`
- **Purpose**: Stores a properly formatted Markdown version with explicit headings

### 2. Utility Function
- **File**: `lib/markdown-utils.ts`
- **Function**: `convertToCleanMarkdown(content: string): string`
- **Purpose**: Converts thesis content to clean Markdown by:
  - Detecting implicit headings (e.g., `1. Title`, `**1. Title**`)
  - Converting them to explicit Markdown headings (`#`, `##`, `###`)
  - Fixing list formatting
  - Preserving existing Markdown structure

### 3. Worker Integration
- **File**: `workers/thesis-generation-worker.ts`
- **Change**: Now generates both `latex_content` and `clean_markdown_content` when creating new theses
- **Benefit**: All new theses will have properly formatted content for exports

### 4. Save Endpoint Update
- **File**: `app/api/save-thesis/route.ts`
- **Change**: Now regenerates `clean_markdown_content` whenever user saves changes
- **Benefit**: Both versions stay perfectly in sync

### 5. DOCX Export Update
- **File**: `app/api/export-thesis-doc/route.ts`
- **Change**: Now uses `clean_markdown_content` instead of `latex_content`
- **Fallback**: If `clean_markdown_content` doesn't exist (old theses), it converts `latex_content` on-the-fly

### 6. Migration Script
- **File**: `scripts/migrate-clean-markdown.ts`
- **Purpose**: Converts existing theses to have `clean_markdown_content`
- **Usage**: Run once to migrate all existing theses

## How to Deploy

### Step 1: Run the Database Migrations
```bash
# Apply both migrations to add the new columns
# 1. Add clean_markdown_content to theses table
# 2. Add clean_markdown_content to thesis_versions table
# This can be done through Supabase dashboard or CLI
```

### Step 2: Migrate Existing Theses
```bash
# Run the migration script to convert existing theses
npx tsx scripts/migrate-clean-markdown.ts
```

### Step 3: Deploy the Code
```bash
# Deploy the updated worker and API routes
# New theses will automatically get clean_markdown_content
# DOCX exports will use the new clean format
```

## Benefits

1. **Better DOCX Exports**: Pandoc now receives clean, well-structured Markdown
2. **Consistent Formatting**: Headings are always recognized correctly
3. **Proper TOC**: Table of Contents is generated correctly
4. **No More Hacks**: No need for complex preprocessing or reference documents
5. **Future-Proof**: Easy to add other export formats (PDF, HTML, etc.)

## Technical Details

### Heading Detection Logic
The `convertToCleanMarkdown` function uses the same robust heading detection logic as the LaTeX export:

- **Multi-level headings** (`1.1`, `1.1.1`): Always treated as headings
- **Bold headings** (`**1. Title**`): Always treated as headings
- **Plain headings** (`1. Title`): Only if short (<80 chars) and no ending punctuation

This ensures that actual thesis text (which might start with numbers) is not mistaken for headings.

### Backwards Compatibility
The DOCX export includes a fallback:
```typescript
let content = thesis.clean_markdown_content || thesis.latex_content || ''

// If using fallback, convert on-the-fly
if (!thesis.clean_markdown_content && thesis.latex_content) {
  const { convertToCleanMarkdown } = await import('@/lib/markdown-utils')
  content = convertToCleanMarkdown(content)
}
```

This means:
- Old theses without `clean_markdown_content` will still export correctly
- New theses will use the pre-generated clean version (faster)
- You can run the migration script at any time

## Next Steps

1. **Test the Migration**: Run the migration script on a staging environment first
2. **Verify Exports**: Test DOCX exports with both old and new theses
3. **Monitor**: Check worker logs to ensure clean_markdown_content is being generated
4. **Optional**: Add similar clean content generation for other export formats

## Files Modified/Created

- ✅ `supabase/migrations/20251127_add_clean_markdown_content.sql` (NEW)
- ✅ `supabase/migrations/20251127_add_clean_markdown_to_versions.sql` (NEW)
- ✅ `lib/markdown-utils.ts` (NEW)
- ✅ `scripts/migrate-clean-markdown.ts` (NEW)
- ✅ `workers/thesis-generation-worker.ts` (MODIFIED)
- ✅ `app/api/save-thesis/route.ts` (MODIFIED)
- ✅ `app/api/export-thesis-doc/route.ts` (MODIFIED)

## Synchronization Points

The `clean_markdown_content` is regenerated at these points to ensure it stays in sync with `latex_content`:

1. **Thesis Creation** (worker): When a new thesis is generated
2. **User Saves** (save-thesis API): When user makes manual edits
3. **Version History**: Both versions are stored in thesis_versions table

This ensures the two versions are **always identical in content**, just formatted differently.
