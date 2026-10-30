import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { type SimbankWebhookPayload } from '@wlisfes/chat-web-base-schema/observe'
import { RabbitmqService } from '@wlisfes/chat-web-base-schema/rabbitmq'
import { ObserveSubmitService } from '@/modules/observe/observe.submit'
import * as topology from '@/modules/observe/observe.delivered.topology'

/** 推送失败后重新进入延迟队列，最多尝试 5 次。 */
export const OBSERVE_DELIVERED_MAX_ATTEMPTS = 5

/** 生成 1-30 秒的随机延迟，结果对齐到已声明的延迟队列。 */
export function randomObserveDeliveredDelay(random: () => number = Math.random): number {
    const steps =
        (topology.OBSERVE_DELIVERED_DELAY_MAX_MS - topology.OBSERVE_DELIVERED_DELAY_MIN_MS) / topology.OBSERVE_DELIVERED_DELAY_STEP_MS + 1
    const index = Math.min(steps - 1, Math.floor(random() * steps))
    return topology.OBSERVE_DELIVERED_DELAY_MIN_MS + index * topology.OBSERVE_DELIVERED_DELAY_STEP_MS
}

type DeliveredReceipt = SimbankWebhookPayload & { attempts?: number }

/**
 * 送达回执写入 RabbitMQ 延迟队列，TTL 到期后投递到 observe.delivered。
 * 消费者不再等待，收到后把 sendStatus=delivered 推送到 Hooks。
 */
@Injectable()
export class ObserveDeliveredQueueService implements OnApplicationBootstrap {
    private readonly logger = new Logger(ObserveDeliveredQueueService.name)

    constructor(
        private readonly rabbitmqService: RabbitmqService,
        private readonly submitService: ObserveSubmitService
    ) {}

    public async onApplicationBootstrap(): Promise<void> {
        await this.rabbitmqService.consume<DeliveredReceipt>(topology.OBSERVE_DELIVERED_QUEUE, async receipt => {
            const webhook = this.webhookPayload(receipt)
            try {
                await this.submitService.submitNow(webhook)
                this.logger.log(`送达回执已推送到 Hooks：msgId=${receipt?.msgId}`)
                return 'ack'
            } catch (error) {
                const attempts = Number(receipt?.attempts ?? 0) + 1
                const reason = error instanceof Error ? error.message : String(error)
                if (attempts < OBSERVE_DELIVERED_MAX_ATTEMPTS) {
                    await this.publishDelayed({ ...webhook, attempts })
                    this.logger.warn(`送达回执推送失败，重新进入延迟队列：msgId=${receipt?.msgId}，attempt=${attempts}，原因=${reason}`)
                } else {
                    await this.rabbitmqService.publish(
                        topology.OBSERVE_DELIVERED_DEAD_EXCHANGE,
                        topology.OBSERVE_DELIVERED_DEAD_ROUTING_KEY,
                        { ...webhook, attempts },
                        {
                            messageId: receipt?.msgId,
                            headers: { 'x-observe-delivered-attempts': attempts }
                        }
                    )
                    this.logger.error(`送达回执推送失败，进入死信：msgId=${receipt?.msgId}，attempt=${attempts}，原因=${reason}`)
                }
                return 'ack'
            }
        })
        this.logger.log(`已订阅送达回执队列：${topology.OBSERVE_DELIVERED_QUEUE}`)
    }

    /**
     * 发送成功立即推送 success；送达回执改成 delivered 后进入 MQ 延迟队列。
     * 失败回执不进入延迟队列，仍立即推送。
     */
    public async enqueueSuccess(receipt: SimbankWebhookPayload): Promise<void> {
        if (receipt.sendStatus !== 'success') {
            await this.submitService.submitNow(receipt)
            return
        }
        this.submitService.submit(receipt)
        const delay = await this.publishDelayed({
            ...receipt,
            sendStatus: 'delivered',
            statusMessage: '模拟设备已送达'
        })
        this.logger.log(`送达回执已进入延迟队列：msgId=${receipt.msgId}，delay=${delay}ms`)
    }

    /** 测试可替换，必须返回已声明的延迟梯度。 */
    public randomDelay: () => number = () => randomObserveDeliveredDelay()

    private webhookPayload(receipt: DeliveredReceipt): SimbankWebhookPayload {
        const { attempts: _attempts, ...webhook } = receipt
        return webhook
    }

    private async publishDelayed(receipt: DeliveredReceipt): Promise<number> {
        const delay = this.randomDelay()
        if (
            !Number.isInteger(delay) ||
            delay < topology.OBSERVE_DELIVERED_DELAY_MIN_MS ||
            delay > topology.OBSERVE_DELIVERED_DELAY_MAX_MS ||
            (delay - topology.OBSERVE_DELIVERED_DELAY_MIN_MS) % topology.OBSERVE_DELIVERED_DELAY_STEP_MS !== 0
        ) {
            throw new Error(
                `送达延迟必须是 ${topology.OBSERVE_DELIVERED_DELAY_MIN_MS}-${topology.OBSERVE_DELIVERED_DELAY_MAX_MS} 毫秒、步长 ${topology.OBSERVE_DELIVERED_DELAY_STEP_MS} 的整数`
            )
        }
        await this.rabbitmqService.publish('', topology.observeDeliveredDelayQueue(delay), receipt, {
            messageId: receipt.msgId,
            ...(receipt.attempts ? { headers: { 'x-observe-delivered-attempts': receipt.attempts } } : {})
        })
        return delay
    }
}
