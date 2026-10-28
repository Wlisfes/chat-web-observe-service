import { Controller, Logger, UseFilters } from '@nestjs/common'
import { Public } from '@wlisfes/chat-web-base-schema/auth'
import { RpcExceptionFilter } from '@wlisfes/chat-web-base-schema/filters'
import { MessagePattern, Payload } from '@nestjs/microservices'
import {
    OBSERVE_PATTERN,
    type ObserveEnqueueResult,
    type ObservePingPayload,
    type ObservePingResult,
    type ObserveQueryPayload,
    type ObserveQueryResult,
    type ObserveSubmitPayload,
    type ObserveSubmitResult
} from '@wlisfes/chat-web-base-schema/observe'
import { ObserveService } from '@/modules/observe/observe.service'

/**
 * Observe TCP 入口：只接收 Dispatch 的 RPC 调用，不暴露 HTTP 接口。
 * TCP 请求没有网关身份头，跳过网关身份校验；异常按 RPC 结构返回给调用方。
 */
@Public()
@UseFilters(RpcExceptionFilter)
@Controller()
export class ObserveController {
    private readonly logger = new Logger(ObserveController.name)

    constructor(private readonly observeService: ObserveService) {}

    @MessagePattern(OBSERVE_PATTERN.PING)
    public async fetchObservePing(@Payload() payload: ObservePingPayload): Promise<ObservePingResult> {
        const result = this.observeService.ping(payload)
        this.logger.log(`收到 TCP 连通性检查：from=${result.from}`)
        return result
    }

    @MessagePattern(OBSERVE_PATTERN.SUBMIT)
    public async fetchObserveSubmit(@Payload() payload: ObserveSubmitPayload): Promise<ObserveSubmitResult> {
        const startedAt = performance.now()
        const result = await this.observeService.submit(payload)
        const message = `模拟发送完成：msgId=${result.msgId}，msgKeyId=${payload?.msgKeyId}，simbankKeyId=${payload?.simbankKeyId}，portKeyId=${payload?.portKeyId}，sendStatus=${result.sendStatus}，statusCode=${result.statusCode}，耗时=${Math.round(performance.now() - startedAt)}ms`
        if (result.sendStatus === 'success') this.logger.log(message)
        else this.logger.warn(`${message}，原因=${result.statusMessage}`)
        return result
    }

    @MessagePattern(OBSERVE_PATTERN.ENQUEUE)
    public async fetchObserveEnqueue(@Payload() payload: ObserveSubmitPayload): Promise<ObserveEnqueueResult> {
        const result = await this.observeService.enqueue(payload)
        const message = `短信提交受理：msgId=${result.msgId}，msgKeyId=${payload?.msgKeyId}，portKeyId=${payload?.portKeyId}，sendInterval=${payload?.sendInterval ?? 0}，accepted=${result.accepted}，statusCode=${result.statusCode}`
        if (result.accepted) this.logger.log(`${message}，queueSize=${result.queueSize ?? '-'}`)
        else this.logger.warn(`${message}，原因=${result.statusMessage}`)
        return result
    }

    @MessagePattern(OBSERVE_PATTERN.QUERY)
    public async fetchObserveQuery(@Payload() payload: ObserveQueryPayload): Promise<ObserveQueryResult> {
        const result = await this.observeService.query(payload)
        this.logger.log(
            `查询设备发送状态：msgId=${result.msgId}，found=${result.found}，state=${result.state ?? '-'}${result.result ? `，sendStatus=${result.result.sendStatus}` : ''}`
        )
        return result
    }
}
