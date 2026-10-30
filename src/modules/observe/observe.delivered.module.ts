import { Global, Module } from '@nestjs/common'
import { RabbitmqModule } from '@wlisfes/chat-web-base-schema/rabbitmq'
import { OBSERVE_RABBITMQ_VHOST, setupObserveDeliveredTopology } from '@/modules/observe/observe.delivered.topology'

/** Observe 送达回执队列连接模块；复用共享 RabbitMQ 运行时并声明延迟队列。 */
@Global()
@Module({
    imports: [RabbitmqModule.forRoot({ vhost: OBSERVE_RABBITMQ_VHOST, setup: setupObserveDeliveredTopology })],
    exports: [RabbitmqModule]
})
export class ObserveRabbitmqModule {}
