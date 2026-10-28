/** 端口发送队列中的一条短信。 */
export interface ObservePortJob {
    msgId: string
    /** 与上一条短信的最小间隔毫秒数：取提交时的通道发送间隔。 */
    sendInterval: number
    send: () => Promise<void>
}

interface PortLane {
    jobs: ObservePortJob[]
    running: boolean
    /** 上一条短信发送完成的时间；端口还没发送过时为空，第一条不等待。 */
    lastSentAt?: number
}

/**
 * 按端口串行发送的队列：模拟一张 SIM 卡同一时间只能发一条短信。
 *
 * - 每个端口一个队列，端口之间并行；同一端口两条短信之间至少间隔 sendInterval 毫秒（从上一条发送完成算起）；
 * - 队列满时拒绝新短信，由 Dispatch 换端口提交，避免单个端口积压；
 * - 队列只在本实例内存，Observe 重启后丢失的短信由 Dispatch 回执超时检查补偿。
 */
export class ObservePortQueue {
    private readonly lanes = new Map<number, PortLane>()

    constructor(
        private readonly onError: (job: ObservePortJob, error: unknown) => void = () => undefined,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
    ) {}

    /** 加入端口队列，返回加入后排队中的短信数；队列已满返回 undefined。 */
    public push(portKeyId: number, job: ObservePortJob, maxSize: number): number | undefined {
        const lane = this.lanes.get(portKeyId) ?? { jobs: [], running: false }
        if (lane.jobs.length >= maxSize) return undefined
        lane.jobs.push(job)
        this.lanes.set(portKeyId, lane)
        if (!lane.running) void this.drain(portKeyId, lane)
        return lane.jobs.length
    }

    /** 端口排队中的短信数（不含正在发送的一条）。 */
    public size(portKeyId: number): number {
        return this.lanes.get(portKeyId)?.jobs.length ?? 0
    }

    private async drain(portKeyId: number, lane: PortLane): Promise<void> {
        lane.running = true
        try {
            while (lane.jobs.length > 0) {
                const job = lane.jobs[0]
                const wait = lane.lastSentAt === undefined ? 0 : lane.lastSentAt + Math.max(0, job.sendInterval) - this.now()
                if (wait > 0) await this.sleep(wait)
                lane.jobs.shift()
                try {
                    await job.send()
                } catch (error) {
                    this.onError(job, error)
                }
                lane.lastSentAt = this.now()
            }
        } finally {
            lane.running = false
            // 空闲端口保留到间隔结束，避免下一条短信绕过发送间隔；之后清理，避免端口记录无限增长。
            const idle = lane.jobs.length === 0
            if (idle) {
                const keep = setTimeout(
                    () => {
                        if (!lane.running && lane.jobs.length === 0 && this.lanes.get(portKeyId) === lane) this.lanes.delete(portKeyId)
                    },
                    10 * 60 * 1000
                )
                keep.unref?.()
            }
        }
    }
}
