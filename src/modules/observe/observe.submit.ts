import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { type SimbankWebhookPayload } from '@wlisfes/chat-web-base-schema/observe'

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

/** 发送完成后把结果提交给 Hooks。成功回执由延迟队列调用 submitNow，失败回执走兼容入口。 */
@Injectable()
export class ObserveSubmitService {
    private readonly logger = new Logger(ObserveSubmitService.name)
    private warned = false
    /** HTTP 提交实现；测试时可替换。 */
    public post: typeof fetch = (input, init) => fetch(input, init)

    constructor(private readonly configService: ConfigService) {}

    /** 兼容入口：后台推送，失败只记录日志。 */
    public submit(payload: SimbankWebhookPayload): void {
        void this.submitNow(payload).catch(error => {
            this.logger.error(`发送结果提交失败：msgId=${payload.msgId}，原因=${this.errorMessage(error)}`)
        })
    }

    /** 立即推送，失败时直接抛错，供延迟队列决定重新入队或进入死信。 */
    public async submitNow(payload: SimbankWebhookPayload): Promise<void> {
        const options = this.options()
        if (!options) throw new Error('未配置有效的 Hooks 回执地址')
        await this.postResult(options, payload)
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
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
