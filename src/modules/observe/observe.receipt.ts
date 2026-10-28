import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
    OBSERVE_RECEIPT_SIGNATURE_HEADER,
    OBSERVE_RECEIPT_TIMESTAMP_HEADER,
    signObserveReceipt,
    type ObserveReceiptPayload
} from '@wlisfes/chat-web-base-schema/observe'

/** 回执推送失败后的重试间隔，毫秒；用完仍失败时放弃，由 Dispatch 回执超时检查按短信ID查询补偿。 */
export const OBSERVE_RECEIPT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
/** 单次推送默认超时毫秒数。 */
export const OBSERVE_RECEIPT_DEFAULT_TIMEOUT_MS = 5_000

export interface ObserveHooksOptions {
    url: string
    secret: string
    timeout: number
}

/** 解析 Nacos `hooks` 节点；未配置 url 或 secret 时返回 undefined，表示不推送回执。 */
export function resolveObserveHooksOptions(config: unknown): ObserveHooksOptions | undefined {
    const record = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
    const url = typeof record.url === 'string' ? record.url.trim() : ''
    const secret = typeof record.secret === 'string' ? record.secret.trim() : ''
    if (!url || !secret) return undefined
    const timeout = Number(record.timeout ?? OBSERVE_RECEIPT_DEFAULT_TIMEOUT_MS)
    if (!Number.isInteger(timeout) || timeout < 100) throw new Error('Nacos hooks.timeout 必须是不小于 100 的整数毫秒数')
    return { url, secret, timeout }
}

/**
 * 发送完成后把结果推送给 Hooks，由 Hooks 转发到回执队列、Dispatch 写回发送记录。Observe 不写库。
 * 推送失败按退避间隔重试；重试用完或进程重启丢失的回执，由 Dispatch 回执超时检查按短信ID查询补偿。
 */
@Injectable()
export class ObserveReceiptNotifier implements OnApplicationShutdown {
    private readonly logger = new Logger(ObserveReceiptNotifier.name)
    private readonly timers = new Set<NodeJS.Timeout>()
    private warned = false
    /** 重试间隔；测试时可替换。 */
    public retryDelays: number[] = OBSERVE_RECEIPT_RETRY_DELAYS_MS
    /** HTTP 推送实现；测试时可替换。 */
    public post: typeof fetch = (input, init) => fetch(input, init)

    constructor(private readonly configService: ConfigService) {}

    public onApplicationShutdown(): void {
        for (const timer of this.timers) clearTimeout(timer)
        this.timers.clear()
    }

    /** 推送回执，不抛错；首次失败后在后台重试。 */
    public notify(receipt: ObserveReceiptPayload): void {
        void this.attempt(receipt, 0)
    }

    private async attempt(receipt: ObserveReceiptPayload, retry: number): Promise<void> {
        const options = this.options()
        if (!options) return
        try {
            await this.send(options, receipt)
            if (retry > 0) this.logger.log(`回执重试推送成功：msgId=${receipt.msgId}，第 ${retry} 次重试`)
        } catch (error) {
            const delay = this.retryDelays[retry]
            const reason = error instanceof Error ? error.message : String(error)
            if (delay === undefined) {
                this.logger.error(`回执推送失败，已放弃，等待 Dispatch 超时查询补偿：msgId=${receipt.msgId}，原因=${reason}`)
                return
            }
            this.logger.warn(`回执推送失败，${delay}ms 后重试：msgId=${receipt.msgId}，原因=${reason}`)
            const timer = setTimeout(() => {
                this.timers.delete(timer)
                void this.attempt(receipt, retry + 1)
            }, delay)
            timer.unref?.()
            this.timers.add(timer)
        }
    }

    private async send(options: ObserveHooksOptions, receipt: ObserveReceiptPayload): Promise<void> {
        const body = JSON.stringify(receipt)
        const timestamp = String(Date.now())
        const response = await this.post(options.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                [OBSERVE_RECEIPT_TIMESTAMP_HEADER]: timestamp,
                [OBSERVE_RECEIPT_SIGNATURE_HEADER]: signObserveReceipt(options.secret, timestamp, body)
            },
            body,
            signal: AbortSignal.timeout(options.timeout)
        })
        if (!response.ok) throw new Error(`Hooks 返回 HTTP ${response.status}`)
    }

    /** 每次读取最新配置，Nacos 修改 hooks 后无需重启。 */
    private options(): ObserveHooksOptions | undefined {
        try {
            const options = resolveObserveHooksOptions(this.configService.get('hooks'))
            if (!options && !this.warned) {
                this.warned = true
                this.logger.warn('Nacos 未配置 hooks.url 或 hooks.secret，发送结果不推送回执，Dispatch 只能通过超时查询获取结果')
            }
            if (options) this.warned = false
            return options
        } catch (error) {
            this.logger.error(`Nacos hooks 配置无效，回执未推送：${error instanceof Error ? error.message : String(error)}`)
            return undefined
        }
    }
}
