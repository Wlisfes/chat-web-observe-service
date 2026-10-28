import type { ObserveEnqueueResult, ObserveMessageState, ObserveSubmitResult } from '@wlisfes/chat-web-base-schema/observe'

/** 设备侧发送记录保留时长：覆盖 MQ 重投和回执超时检查窗口，过期后按未收到处理。 */
export const OBSERVE_LEDGER_TTL_MS = 24 * 60 * 60 * 1000
/** 设备侧发送记录上限，超出时淘汰最早写入的记录，避免内存无限增长。 */
export const OBSERVE_LEDGER_MAX_SIZE = 100_000

/** 一条短信在设备侧的记录。 */
export interface LedgerEntry {
    /** 受理中、排队中为 queued，发送中为 sending，有结果后为 settled。 */
    state: ObserveMessageState
    /** 受理结果：同一短信ID重复提交共用这一次受理。 */
    admission: Promise<ObserveEnqueueResult>
    /** 发送结果：受理被拒绝时为拒绝原因。 */
    done: Promise<ObserveSubmitResult>
    result?: ObserveSubmitResult
    /** 是否已进入端口发送队列；发送条件不满足被拒绝时为空。 */
    accepted?: boolean
    expiredAt: number
    resolve: (result: ObserveSubmitResult) => void
}

/**
 * 模拟设备侧按短信ID记录的受理和发送状态，相当于真实设备的发送日志。
 *
 * - 同一条短信重复提交时不再重复受理和发送，直接返回第一次的受理结果；
 * - Dispatch 重投或回执超时时按短信ID查询，排队中、发送中的短信不再重复提交，已发送的直接使用设备结果；
 * - 只保存在本实例内存，Observe 重启后清空；生产接入真实设备时由设备侧按短信ID去重。
 */
export class ObserveSendLedger {
    private readonly entries = new Map<string, LedgerEntry>()

    constructor(
        private readonly ttlMs = OBSERVE_LEDGER_TTL_MS,
        private readonly maxSize = OBSERVE_LEDGER_MAX_SIZE,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * 同一短信ID只受理一次；并发或重复提交共用同一次受理结果。
     * 受理函数抛错或端口队列已满（retryable=true）时删除记录，允许稍后或换端口重新提交。
     */
    public async admit(
        msgId: string,
        admit: (entry: LedgerEntry) => Promise<{ admission: ObserveEnqueueResult; retryable?: boolean }>
    ): Promise<ObserveEnqueueResult> {
        const existing = this.get(msgId)
        if (existing) return existing.admission
        let resolve!: (result: ObserveSubmitResult) => void
        const done = new Promise<ObserveSubmitResult>(callback => (resolve = callback))
        const entry = { state: 'queued', done, expiredAt: this.now() + this.ttlMs } as LedgerEntry
        entry.resolve = result => {
            entry.state = 'settled'
            entry.result = result
            resolve(result)
        }
        const admission = admit(entry).then(
            ({ admission, retryable }) => {
                if (retryable && this.entries.get(msgId) === entry) this.entries.delete(msgId)
                return admission
            },
            error => {
                if (this.entries.get(msgId) === entry) this.entries.delete(msgId)
                throw error
            }
        )
        entry.admission = admission
        this.set(msgId, entry)
        return admission
    }

    /** 查询短信ID的设备侧记录，不等待发送完成；没有记录时返回 undefined。 */
    public get(msgId: string): LedgerEntry | undefined {
        const entry = this.entries.get(msgId)
        if (!entry) return undefined
        if (entry.expiredAt <= this.now()) {
            this.entries.delete(msgId)
            return undefined
        }
        return entry
    }

    public get size(): number {
        return this.entries.size
    }

    private set(msgId: string, entry: LedgerEntry): void {
        this.entries.set(msgId, entry)
        // Map 按写入顺序迭代，超出上限时淘汰最早的记录。
        while (this.entries.size > this.maxSize) {
            const oldest = this.entries.keys().next().value
            if (oldest === undefined) break
            this.entries.delete(oldest)
        }
    }
}
