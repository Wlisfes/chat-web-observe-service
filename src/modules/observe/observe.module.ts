import { Module } from '@nestjs/common'
import { ObserveController } from '@/modules/observe/observe.controller'
import { ObserveService } from '@/modules/observe/observe.service'

/** 模拟发送模块：TCP 接收 Dispatch 请求。 */
@Module({
    controllers: [ObserveController],
    providers: [ObserveService]
})
export class ObserveModule {}
