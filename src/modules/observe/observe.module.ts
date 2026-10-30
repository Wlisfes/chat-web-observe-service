import { Module } from '@nestjs/common'
import { ObserveController } from '@/modules/observe/observe.controller'
import { ObserveService } from '@/modules/observe/observe.service'
import { ObserveSubmitService } from '@/modules/observe/observe.submit'

/** 模拟发送模块：TCP 接收 Dispatch 请求，按端口排队发送，发送结果提交给 Hooks。 */
@Module({
    controllers: [ObserveController],
    providers: [ObserveSubmitService, ObserveService]
})
export class ObserveModule {}
