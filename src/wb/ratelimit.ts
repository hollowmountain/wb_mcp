/**
 * Token bucket — тот же алгоритм, который WB применяет на своей стороне.
 * Параметры взяты из документации лимитов для персонального токена:
 * https://dev.wildberries.ru/openapi/api-information
 */
export class TokenBucket {
    private tokens: number;
    private lastRefill: number;

    constructor(
        private readonly capacity: number,
        private readonly refillPerSecond: number
    ) {
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    private refill(): void {
        const nowMs = Date.now();
        const elapsed = (nowMs - this.lastRefill) / 1000;
        if (elapsed <= 0) return;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
        this.lastRefill = nowMs;
    }

    /** Ждёт, пока не освободится cost «мест» в ведре. */
    async take(cost = 1): Promise<void> {
        for (;;) {
            this.refill();
            if (this.tokens >= cost) {
                this.tokens -= cost;
                return;
            }
            const deficit = cost - this.tokens;
            const waitMs = Math.ceil((deficit / this.refillPerSecond) * 1000);
            await sleep(Math.max(waitMs, 25));
        }
    }

    /** Списывает штраф без ожидания — например, после 429 от WB. */
    penalise(cost: number): void {
        this.refill();
        this.tokens = Math.max(0, this.tokens - cost);
    }
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
