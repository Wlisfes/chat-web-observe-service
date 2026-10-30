const test = require('node:test')
const assert = require('node:assert/strict')
const {
    randomObserveDeliveredDelay,
    OBSERVE_DELIVERED_MAX_ATTEMPTS,
    ObserveDeliveredQueueService
} = require('../dist/modules/observe/observe.delivered.queue')
const {
    setupObserveDeliveredTopology,
    observeDeliveredDelayQueue,
    observeDeliveredDelays,
    OBSERVE_DELIVERED_QUEUE,
    OBSERVE_DELIVERED_DEAD_QUEUE,
    OBSERVE_DELIVERED_EXCHANGE,
    OBSERVE_DELIVERED_DEAD_EXCHANGE,
    OBSERVE_DELIVERED_ROUTING_KEY,
    OBSERVE_DELIVERED_DELAY_MIN_MS,
    OBSERVE_DELIVERED_DELAY_MAX_MS
} = require('../dist/modules/observe/observe.delivered.topology')

const receipt = {
    msgId: 'm1',
    msgKeyId: 1,
    simbankKeyId: 2,
    portKeyId: 3,
    sendStatus: 'success',
    statusCode: 'OK',
    statusMessage: '',
    sendTime: '2026-10-30T10:00:00.000Z'
}

test('送达延迟随机范围按整秒包含 1 秒和 30 秒边界', () => {
    assert.equal(
        randomObserveDeliveredDelay(() => 0),
        OBSERVE_DELIVERED_DELAY_MIN_MS
    )
    assert.equal(
        randomObserveDeliveredDelay(() => 0.999999),
        OBSERVE_DELIVERED_DELAY_MAX_MS
    )
    assert.equal(
        randomObserveDeliveredDelay(() => 0.5),
        16_000
    )
    assert.equal(observeDeliveredDelays().length, 30)
})

test('回执拓扑声明送达队列、死信队列和 TTL 延迟队列', async () => {
    const calls = []
    const channel = {
        assertExchange: async (...args) => calls.push(['assertExchange', ...args]),
        assertQueue: async (...args) => calls.push(['assertQueue', ...args]),
        bindQueue: async (...args) => calls.push(['bindQueue', ...args])
    }
    await setupObserveDeliveredTopology(channel)
    assert.ok(calls.some(call => call[0] === 'assertExchange' && call[1] === OBSERVE_DELIVERED_EXCHANGE))
    assert.ok(calls.some(call => call[0] === 'assertExchange' && call[1] === OBSERVE_DELIVERED_DEAD_EXCHANGE))
    const queue = calls.find(call => call[0] === 'assertQueue' && call[1] === OBSERVE_DELIVERED_QUEUE)
    assert.deepEqual(queue[2], {
        durable: true,
        deadLetterExchange: OBSERVE_DELIVERED_DEAD_EXCHANGE,
        deadLetterRoutingKey: 'observe.delivered.dead'
    })
    assert.ok(
        calls.some(call => call[0] === 'bindQueue' && call[1] === OBSERVE_DELIVERED_QUEUE && call[3] === OBSERVE_DELIVERED_ROUTING_KEY)
    )
    assert.ok(calls.some(call => call[0] === 'assertQueue' && call[1] === OBSERVE_DELIVERED_DEAD_QUEUE))
    const delayQueue = calls.find(call => call[0] === 'assertQueue' && call[1] === observeDeliveredDelayQueue(1_000))
    assert.deepEqual(delayQueue[2], {
        durable: true,
        messageTtl: 1_000,
        deadLetterExchange: OBSERVE_DELIVERED_EXCHANGE,
        deadLetterRoutingKey: 'observe.delivered'
    })
    assert.equal(calls.filter(call => call[0] === 'assertQueue' && String(call[1]).includes('.delay.')).length, 30)
    assert.equal(
        calls.some(call => String(call[1]).includes('observe.receipt')),
        false
    )
})

test('成功回执进入延迟队列，失败回执立即推送', async () => {
    const published = []
    const submitted = []
    const service = new ObserveDeliveredQueueService(
        { publish: async (...args) => published.push(args), consume: async () => undefined },
        { submitNow: async payload => submitted.push(payload) }
    )
    service.randomDelay = () => 5_000
    await service.enqueueSuccess(receipt)
    assert.equal(published.length, 1)
    assert.equal(published[0][0], '')
    assert.equal(published[0][1], 'chat.observe.delivered.delay.5000')
    assert.equal(published[0][2], receipt)
    assert.equal(published[0][3].messageId, 'm1')
    assert.equal(published[0][3].headers, undefined)
    await service.enqueueSuccess({ ...receipt, sendStatus: 'failed' })
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].sendStatus, 'failed')
})

test('消费者立即推送，失败后重新进入延迟队列，耗尽后进入死信', async () => {
    const published = []
    let handler
    const service = new ObserveDeliveredQueueService(
        {
            publish: async (...args) => published.push(args),
            consume: async (queue, callback) => {
                assert.equal(queue, OBSERVE_DELIVERED_QUEUE)
                handler = callback
            }
        },
        {
            submitNow: async payload => {
                if (payload.attempts) throw new Error('payload leaked attempts')
                throw new Error('hooks down')
            }
        }
    )
    service.randomDelay = () => 2_000
    await service.onApplicationBootstrap()
    assert.equal(await handler(receipt), 'ack')
    assert.equal(published[0][0], '')
    assert.equal(published[0][1], 'chat.observe.delivered.delay.2000')
    assert.equal(published[0][2].attempts, 1)
    assert.equal(published[0][2].msgId, 'm1')
    assert.equal('attempts' in published[0][2] && published[0][2].sendStatus, 'success')
    assert.deepEqual(published[0][3].headers, { 'x-observe-delivered-attempts': 1 })

    published.length = 0
    assert.equal(await handler({ ...receipt, attempts: OBSERVE_DELIVERED_MAX_ATTEMPTS - 1 }), 'ack')
    assert.equal(published[0][0], OBSERVE_DELIVERED_DEAD_EXCHANGE)
    assert.equal(published[0][1], 'observe.delivered.dead')
    assert.equal(published[0][2].attempts, OBSERVE_DELIVERED_MAX_ATTEMPTS)
    assert.equal(published[0][2].sendStatus, 'success')
})
