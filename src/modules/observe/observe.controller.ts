import { Controller, Logger, UseFilters } from '@nestjs/common'
import { Public } from '@wlisfes/chat-web-base-schema/auth'
import { RpcExceptionFilter } from '@wlisfes/chat-web-base-schema/filters'
import { MessagePattern, Payload } from '@nestjs/microservices'
import { OBSERVE_PATTERN, type ObservePingPayload, type ObservePingResult } from '@wlisfes/chat-web-base-schema/observe'
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
}
