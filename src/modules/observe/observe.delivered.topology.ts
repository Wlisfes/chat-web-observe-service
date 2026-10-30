import type { ConfirmChannel } from 'amqplib'

/** Observe 回执队列所在的 RabbitMQ 虚拟主机，与 Hooks、Dispatch 一致。 */
export const OBSERVE_RABBITMQ_VHOST = '/chat-sms'
/** 送达回执交换机：延迟队列到期后转入这里，再由 Observe 消费。 */
export const OBSERVE_DELIVERED_EXCHANGE = 'chat.observe.delivered.exchange'
/** 送达回执队列：只接收延迟到期的消息，消费时立即推送 Hooks。 */
export const OBSERVE_DELIVERED_QUEUE = 'chat.observe.delivered'
export const OBSERVE_DELIVERED_ROUTING_KEY = 'observe.delivered'
/** 推送重试耗尽后进入死信。 */
export const OBSERVE_DELIVERED_DEAD_EXCHANGE = 'chat.observe.delivered.dead.exchange'
export const OBSERVE_DELIVERED_DEAD_QUEUE = 'chat.observe.delivered.dead'
export const OBSERVE_DELIVERED_DEAD_ROUTING_KEY = 'observe.delivered.dead'
/** 成功回执在 MQ 延迟队列中等待的范围，按整秒对齐。 */
export const OBSERVE_DELIVERED_DELAY_MIN_MS = 1_000
export const OBSERVE_DELIVERED_DELAY_MAX_MS = 30_000
export const OBSERVE_DELIVERED_DELAY_STEP_MS = 1_000

/** 每个整秒一个 TTL 延迟队列；到期后经死信转入送达队列。 */
export function observeDeliveredDelayQueue(delay: number): string {
    return `chat.observe.delivered.delay.${delay}`
}

/** 1 秒到 30 秒的延迟梯度。 */
export function observeDeliveredDelays(): number[] {
    const delays: number[] = []
    for (let delay = OBSERVE_DELIVERED_DELAY_MIN_MS; delay <= OBSERVE_DELIVERED_DELAY_MAX_MS; delay += OBSERVE_DELIVERED_DELAY_STEP_MS) {
        delays.push(delay)
    }
    return delays
}

/**
 * 声明送达回执拓扑；每次 RabbitMQ 重连都会幂等执行。
 *
 * - 30 个延迟队列按 TTL 持有成功回执，到期后死信到 observe.delivered；
 * - 消费队列不再等待，推送失败耗尽后进入死信。
 */
export async function setupObserveDeliveredTopology(channel: ConfirmChannel): Promise<void> {
    await channel.assertExchange(OBSERVE_DELIVERED_EXCHANGE, 'direct', { durable: true })
    await channel.assertExchange(OBSERVE_DELIVERED_DEAD_EXCHANGE, 'direct', { durable: true })
    await channel.assertQueue(OBSERVE_DELIVERED_DEAD_QUEUE, { durable: true })
    await channel.bindQueue(OBSERVE_DELIVERED_DEAD_QUEUE, OBSERVE_DELIVERED_DEAD_EXCHANGE, OBSERVE_DELIVERED_DEAD_ROUTING_KEY)
    await channel.assertQueue(OBSERVE_DELIVERED_QUEUE, {
        durable: true,
        deadLetterExchange: OBSERVE_DELIVERED_DEAD_EXCHANGE,
        deadLetterRoutingKey: OBSERVE_DELIVERED_DEAD_ROUTING_KEY
    })
    await channel.bindQueue(OBSERVE_DELIVERED_QUEUE, OBSERVE_DELIVERED_EXCHANGE, OBSERVE_DELIVERED_ROUTING_KEY)
    for (const delay of observeDeliveredDelays()) {
        await channel.assertQueue(observeDeliveredDelayQueue(delay), {
            durable: true,
            messageTtl: delay,
            deadLetterExchange: OBSERVE_DELIVERED_EXCHANGE,
            deadLetterRoutingKey: OBSERVE_DELIVERED_ROUTING_KEY
        })
    }
}
