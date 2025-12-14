/**
 * BullMQ Queue Configuration
 * Manages the thesis generation job queue
 * 
 * REDIS OPTIMIZATION: Uses lazy connection to reduce command overhead
 * in serverless environments (Next.js API routes)
 */

import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '@/lib/env'

// Queue name constant
export const THESIS_QUEUE_NAME = 'thesis-generation'

// Create Redis connection with LAZY CONNECT
// This prevents connection overhead on module import
// Connection only happens when first command is sent
const useTLS = env.REDIS_URL.startsWith('rediss://')

const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false, // Skip PING on connect - saves commands
    lazyConnect: true, // CRITICAL: Don't connect until needed
    tls: useTLS ? {
        rejectUnauthorized: false, // Upstash uses self-signed certs
    } : undefined,
    retryStrategy: (times) => {
        // Faster backoff for serverless - don't wait too long
        const delay = Math.min(times * 100, 1000)
        return delay
    },
    // Disconnect quickly after idle - serverless functions are short-lived
    disconnectTimeout: 2000,
})

// Export the queue instance for producers (Next.js API routes)
export const thesisQueue = new Queue(THESIS_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
        attempts: 2, // Reduced from 3 - saves retry overhead
        backoff: {
            type: 'fixed', // Changed from exponential - simpler, fewer state updates
            delay: 5000,
        },
        removeOnComplete: true, // Immediately remove completed jobs - saves storage/commands
        removeOnFail: {
            count: 50, // Reduced from 500 - we don't need that many failed jobs
        },
    },
})

// Job data interface
export interface ThesisGenerationJob {
    thesisId: string
    thesisData: {
        title: string
        topic: string
        field: string
        thesisType: string
        researchQuestion: string
        citationStyle: string
        targetLength: number
        lengthUnit: string
        outline: any[]
        fileSearchStoreId: string
        language: string
        mandatorySources: string[] // Array of source titles/DOIs that must be cited
    }
}
