import { Module } from '@nestjs/common'
import { ObserveController } from '@/modules/observe/observe.controller'
import { ObserveDeliveredQueueService } from '@/modules/observe/observe.delivered.queue'
import { ObserveRabbitmqModule } from '@/modules/observe/observe.delivered.module'
import { ObserveService } from '@/modules/observe/observe.service'
import { ObserveSubmitService } from '@/modules/observe/observe.submit'

/** 模拟发送模块：TCP 接收 Dispatch 请求，按端口排队发送，发送成功立即推送，送达回执进入 MQ 延迟队列，到期后推送 Hooks。 */
@Module({
    imports: [ObserveRabbitmqModule],
    controllers: [ObserveController],
    providers: [ObserveSubmitService, ObserveDeliveredQueueService, ObserveService],
    exports: [ObserveDeliveredQueueService, ObserveSubmitService]
})
export class ObserveModule {}
