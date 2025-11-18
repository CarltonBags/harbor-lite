# StudyFucker - AI Scientific Thesis Writer

An AI-powered application for writing scientific theses with LaTeX support.

## Tech Stack

- **Next.js 14** - React framework with App Router
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **Lucide React** - Icons
- **WebContainer API** - LaTeX compilation environment

## Getting Started

### Install Dependencies

```bash
npm install
# or
pnpm install
# or
yarn install
```

### Run Development Server

```bash
npm run dev
# or
pnpm dev
# or
yarn dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Project Structure

```
studyfucker/
├── app/
│   ├── layout.tsx      # Root layout
│   ├── page.tsx         # Main thesis writer interface
│   └── globals.css      # Global styles
├── lib/
│   ├── types/          # TypeScript type definitions
│   ├── webcontainer.ts # WebContainer utilities
│   └── env.ts          # Environment variables
├── package.json
├── tsconfig.json
├── tailwind.config.ts
└── next.config.js
```

## Features

- AI-powered thesis content generation
- LaTeX document structure and compilation
- Real-time thesis preview
- Chat interface for iterative refinement
- PDF export (coming soon)

## Environment Variables

Required environment variables:
- `OPENAI_KEY` - OpenAI API key for AI features
- `GEMINI_KEY` - Google Gemini API key for content generation
- Supabase configuration (if using database features)
