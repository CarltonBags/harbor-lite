/**
 * BullMQ Queue Configuration
 * Manages the thesis generation job queue
 */

import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '@/lib/env'

// Queue name constant
export const THESIS_QUEUE_NAME = 'thesis-generation'

// Create Redis connection
// In serverless environments, this connection will be created per-request
// In the worker (long-running process), it stays open
const useTLS = env.REDIS_URL.startsWith('rediss://')

const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: useTLS ? {
        rejectUnauthorized: false, // Upstash uses self-signed certs
    } : undefined,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000)
        return delay
    },
})

// Export the queue instance for producers (Next.js API routes)
export const thesisQueue = new Queue(THESIS_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000,
        },
        removeOnComplete: {
            count: 100, // Keep last 100 completed jobs
            age: 24 * 3600, // Keep for 24 hours
        },
        removeOnFail: {
            count: 500, // Keep last 500 failed jobs for debugging
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
    }
}
