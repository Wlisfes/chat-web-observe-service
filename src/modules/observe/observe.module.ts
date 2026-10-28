import { Module } from '@nestjs/common'
import { ObserveController } from '@/modules/observe/observe.controller'
import { ObserveService } from '@/modules/observe/observe.service'
import { SimbankWebhookNotifier } from '@/modules/observe/observe.receipt'

/** 模拟发送模块：TCP 接收 Dispatch 请求，按端口排队发送，发送结果通过 Hooks 回执。 */
@Module({
    controllers: [ObserveController],
    providers: [SimbankWebhookNotifier, ObserveService]
})
export class ObserveModule {}
