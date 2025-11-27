# BullMQ Job Queue Architecture

## Overview
The thesis generation system now uses BullMQ with Redis for job queue management, enabling concurrent processing of multiple thesis generation requests.

## Architecture

### Components

1. **Producer (Next.js API)**
   - File: `app/api/start-thesis-generation/route.ts`
   - Adds jobs to the Redis queue via BullMQ
   - Returns immediately with job ID

2. **Queue Configuration**
   - File: `lib/queue.ts`
   - Manages Redis connection
   - Exports `thesisQueue` for producers
   - Exports `ThesisGenerationJob` type

3. **Consumer (Worker Service)**
   - File: `workers/thesis-generation-worker.ts`
   - Processes jobs from the queue
   - Runs as a separate long-running process
   - **Concurrency: 3** (can process 3 theses simultaneously)

## Benefits

### 1. Concurrent Processing
- The worker can now process up to **3 thesis generation jobs concurrently**
- Previously: One thesis at a time (blocking)
- Now: Multiple theses can be generated in parallel

### 2. Reliability
- Jobs are persisted in Redis
- Automatic retry on failure (3 attempts with exponential backoff)
- Jobs survive worker restarts

### 3. Scalability
- Easy to add more worker instances
- Horizontal scaling by running multiple worker processes
- Load balancing handled automatically by BullMQ

### 4. Monitoring
- Job progress tracking
- Failed job retention for debugging
- Comprehensive logging

## Configuration

### Environment Variables
Add to `.env.local`:
```bash
REDIS_URL=redis://localhost:6379
# Or for production (e.g., Upstash, Redis Cloud):
# REDIS_URL=rediss://default:password@host:port
```

### Worker Concurrency
Adjust in `workers/thesis-generation-worker.ts`:
```typescript
concurrency: 3, // Change this number to process more/fewer jobs concurrently
```

### Job Options
Configured in `lib/queue.ts`:
- **Attempts**: 3 retries on failure
- **Backoff**: Exponential (2s, 4s, 8s)
- **Retention**: 
  - Completed jobs: Last 100, kept for 24 hours
  - Failed jobs: Last 500 (for debugging)

## Deployment

### Local Development
1. Install Redis:
   ```bash
   brew install redis  # macOS
   # or
   docker run -p 6379:6379 redis  # Docker
   ```

2. Start Redis:
   ```bash
   redis-server
   ```

3. Start the worker:
   ```bash
   npm run dev  # or ts-node workers/thesis-generation-worker.ts
   ```

### Production (Render/Railway/etc.)
1. **Add Redis service** (e.g., Upstash, Redis Cloud, or Render Redis)
2. **Set `REDIS_URL`** environment variable
3. **Deploy worker** as a separate service (not serverless)
4. **Deploy Next.js app** as usual

## Migration from HTTP-based Worker

### Before (HTTP)
```
Next.js API → HTTP POST → Worker Service
- Blocking
- No retry
- Single request at a time
```

### After (BullMQ)
```
Next.js API → Redis Queue → Worker Service
- Non-blocking
- Automatic retry
- Concurrent processing (3 jobs)
```

## Monitoring Jobs

### Check Queue Status
You can add a monitoring endpoint or use BullMQ Board:
```bash
npm install @bull-board/api @bull-board/express
```

### View Job Progress
Jobs update progress:
- 10%: Job started
- 100%: Job completed

## Troubleshooting

### Worker not processing jobs
1. Check Redis connection: `redis-cli ping`
2. Check worker logs for errors
3. Verify `REDIS_URL` is correct

### Jobs failing
1. Check worker logs for error details
2. Failed jobs are retained in Redis
3. Review `metadata.error` in thesis table

### Too many concurrent jobs
Reduce concurrency in worker configuration if experiencing:
- Memory issues
- API rate limits
- Database connection limits

## Next Steps

1. **Add monitoring dashboard** (BullMQ Board)
2. **Implement job cancellation** endpoint
3. **Add metrics** (job duration, success rate)
4. **Scale workers** based on queue depth
