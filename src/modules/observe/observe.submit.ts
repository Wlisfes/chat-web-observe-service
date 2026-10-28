import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { type SimbankWebhookPayload } from '@wlisfes/chat-web-base-schema/observe'

/** 提交失败后的重试间隔，毫秒。用完仍失败则放弃，由调用方再次提交。 */
export const OBSERVE_SUBMIT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
/** 单次提交默认超时毫秒数。gateway.feign.timeout 未配置时使用。 */
export const OBSERVE_SUBMIT_DEFAULT_TIMEOUT_MS = 5_000

export interface ObserveSubmitOptions {
    url: string
    timeout: number
}

/**
 * 解析 Nacos `gateway.hooks.simbank`。
 * 绝对地址直接使用；相对路径拼到 `gateway.feign.url`，和网关共用同一请求地址。未配置时不提交。
 */
export function resolveObserveSubmitOptions(gateway: unknown): ObserveSubmitOptions | undefined {
    const record = asRecord(gateway)
    const feign = asRecord(record.feign)
    const raw = text(asRecord(record.hooks).simbank)
    if (!raw) return undefined
    const base = text(feign.url)?.replace(/\/$/, '')
    const url = /^https?:\/\//i.test(raw) ? raw : base ? `${base}${raw.startsWith('/') ? raw : `/${raw}`}` : ''
    if (!url) throw new Error('Nacos gateway.hooks.simbank 是相对路径时，必须配置 gateway.feign.url')
    const timeout = Number(feign.timeout ?? OBSERVE_SUBMIT_DEFAULT_TIMEOUT_MS)
    if (!Number.isInteger(timeout) || timeout < 100) throw new Error('Nacos gateway.feign.timeout 必须是不小于 100 的整数毫秒数')
    return { url, timeout }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 发送完成后把结果提交给 Hooks。Hooks 是开放接口，不签名。提交失败按间隔重试，不抛给发送流程。 */
@Injectable()
export class ObserveSubmitService implements OnApplicationShutdown {
    private readonly logger = new Logger(ObserveSubmitService.name)
    private readonly timers = new Set<NodeJS.Timeout>()
    private warned = false
    /** 重试间隔；测试时可替换。 */
    public retryDelays: number[] = OBSERVE_SUBMIT_RETRY_DELAYS_MS
    /** HTTP 提交实现；测试时可替换。 */
    public post: typeof fetch = (input, init) => fetch(input, init)

    constructor(private readonly configService: ConfigService) {}

    public onApplicationShutdown(): void {
        for (const timer of this.timers) clearTimeout(timer)
        this.timers.clear()
    }

    /** 提交发送结果，不抛错；失败后在后台重试。 */
    public submit(payload: SimbankWebhookPayload): void {
        void this.submitWithRetry(payload, 0)
    }

    private async submitWithRetry(payload: SimbankWebhookPayload, retry: number): Promise<void> {
        const options = this.options()
        if (!options) return
        try {
            await this.postResult(options, payload)
            if (retry > 0) this.logger.log(`发送结果重试提交成功：msgId=${payload.msgId}，第 ${retry} 次重试`)
        } catch (error) {
            const delay = this.retryDelays[retry]
            const reason = error instanceof Error ? error.message : String(error)
            if (delay === undefined) {
                this.logger.error(`发送结果提交失败，已放弃：msgId=${payload.msgId}，原因=${reason}`)
                return
            }
            this.logger.warn(`发送结果提交失败，${delay}ms 后重试：msgId=${payload.msgId}，原因=${reason}`)
            const timer = setTimeout(() => {
                this.timers.delete(timer)
                void this.submitWithRetry(payload, retry + 1)
            }, delay)
            timer.unref?.()
            this.timers.add(timer)
        }
    }

    private async postResult(options: ObserveSubmitOptions, payload: SimbankWebhookPayload): Promise<void> {
        const response = await this.post(options.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(options.timeout)
        })
        if (!response.ok) throw new Error(`Hooks 返回 HTTP ${response.status}`)
    }

    /** 每次读取最新配置，Nacos 修改 gateway.hooks.simbank 后无需重启。 */
    private options(): ObserveSubmitOptions | undefined {
        try {
            const options = resolveObserveSubmitOptions(this.configService.get('gateway'))
            if (!options && !this.warned) {
                this.warned = true
                this.logger.warn('Nacos 未配置 gateway.hooks.simbank，发送结果不提交')
            }
            if (options) this.warned = false
            return options
        } catch (error) {
            this.logger.error(
                `Nacos gateway.hooks.simbank 配置无效，发送结果不提交：${error instanceof Error ? error.message : String(error)}`
            )
            return undefined
        }
    }
}
