const test = require('node:test')
const assert = require('node:assert/strict')
const { ClientProxyFactory, Transport } = require('@nestjs/microservices')
const net = require('node:net')
const { NestFactory } = require('@nestjs/core')
const { firstValueFrom } = require('rxjs')
const { OBSERVE_PATTERN } = require('@wlisfes/chat-web-base-schema/observe')
const { Module } = require('@nestjs/common')
const { ObserveController } = require('../dist/modules/observe/observe.controller')
const { ObserveService } = require('../dist/modules/observe/observe.service')
const { resolveObserveTcpOptions } = require('../dist/modules/observe/observe.constants')
const { resolveObserveSimulateOptions } = require('../dist/modules/observe/observe.simulate')
const { ObserveTcpServer } = require('../dist/modules/observe/observe.server')
const { ObserveSendLedger } = require('../dist/modules/observe/observe.ledger')
const { ObservePortQueue } = require('../dist/modules/observe/observe.queue')

test('TCP 监听地址：环境变量优先，其次 Nacos tcp 节点，最后默认 0.0.0.0:5101', () => {
    assert.deepEqual(resolveObserveTcpOptions(undefined, {}), { host: '0.0.0.0', port: 5101 })
    assert.deepEqual(resolveObserveTcpOptions({ host: '127.0.0.1', port: 6000 }, {}), { host: '127.0.0.1', port: 6000 })
    assert.deepEqual(resolveObserveTcpOptions({ port: 6000 }, { OBSERVE_TCP_PORT: '5103' }), { host: '0.0.0.0', port: 5103 })
    assert.throws(() => resolveObserveTcpOptions({ port: 70000 }, {}), /1-65535/)
})

test('ping 返回服务名称并原样带回调用方', () => {
    const result = new ObserveService({ get: () => undefined }).ping({ from: 'chat-web-dispatch-service', timestamp: '' })
    assert.equal(result.service, 'chat-web-observe-service')
    assert.equal(result.from, 'chat-web-dispatch-service')
    assert.equal(new ObserveService({ get: () => undefined }).ping(undefined).from, 'unknown')
})

function fixtures(overrides = {}) {
    return {
        message: { keyId: 99, msgId: 'm1', simbankKeyId: 3001, portKeyId: 2001, ...overrides.message },
        simbank: { keyId: 3001, status: 'enable', online: 'online', ...overrides.simbank },
        port: {
            keyId: 2001,
            simbankKeyId: 3001,
            status: 'enable',
            insertStatus: 'inserted',
            activateStatus: 'active',
            online: 'online',
            ...overrides.port
        }
    }
}

function repositories(data) {
    return [data.message, data.simbank, data.port].map(row => ({ findOne: async () => (row === null ? null : row) }))
}

function request(overrides = {}) {
    return { msgId: 'm1', msgKeyId: 99, simbankKeyId: 3001, portKeyId: 2001, ...overrides }
}

function service(overrides, simulate = { delayMin: 0, delayMax: 0 }) {
    return new ObserveService({ get: () => simulate }, ...repositories(fixtures(overrides)))
}

test('设备和端口条件都满足时模拟发送成功', async () => {
    const result = await service().submit(request())
    assert.equal(result.sendStatus, 'success')
    assert.equal(result.statusCode, 'OK')
    assert.equal(result.msgId, 'm1')
})

test('发送条件不满足时返回对应失败码', async () => {
    const cases = [
        [{}, request({ portKeyId: undefined }), 'INVALID_PAYLOAD'],
        [{ message: { msgId: 'other' } }, request(), 'MESSAGE_NOT_FOUND'],
        [{ message: { portKeyId: 1 } }, request(), 'MESSAGE_MISMATCH'],
        [{ simbank: { status: 'disable' } }, request(), 'SIMBANK_DISABLED'],
        [{ simbank: { online: 'offline' } }, request(), 'SIMBANK_OFFLINE'],
        [{ port: { simbankKeyId: 1 } }, request(), 'PORT_NOT_FOUND'],
        [{ port: { status: 'disable' } }, request(), 'PORT_DISABLED'],
        [{ port: { insertStatus: 'removed' } }, request(), 'PORT_REMOVED'],
        [{ port: { activateStatus: 'inactive' } }, request(), 'PORT_INACTIVE'],
        [{ port: { online: 'offline' } }, request(), 'PORT_OFFLINE']
    ]
    for (const [overrides, payload, code] of cases) {
        const result = await service(overrides).submit(payload)
        assert.equal(result.sendStatus, 'failed', code)
        assert.equal(result.statusCode, code)
    }
})

test('failureRate 为 1 时全部模拟失败', async () => {
    const result = await service({}, { delayMin: 0, delayMax: 0, failureRate: 1 }).submit(request())
    assert.equal(result.sendStatus, 'failed')
    assert.equal(result.statusCode, 'SIMULATED_FAILURE')
})

test('模拟参数非法时报错', () => {
    assert.deepEqual(resolveObserveSimulateOptions(undefined), { delayMin: 100, delayMax: 500, failureRate: 0 })
    assert.throws(() => resolveObserveSimulateOptions({ delayMin: 10, delayMax: 5 }), /delayMax/)
    assert.throws(() => resolveObserveSimulateOptions({ failureRate: 2 }), /failureRate/)
})

test('同一短信ID重复提交只发送一次，返回第一次的结果', async () => {
    let checks = 0
    const data = fixtures()
    const repos = [data.message, data.simbank, data.port].map(row => ({ findOne: async () => (checks++, row) }))
    const observe = new ObserveService({ get: () => ({ delayMin: 20, delayMax: 20 }) }, ...repos)
    const [first, concurrent] = await Promise.all([observe.submit(request()), observe.submit(request())])
    const again = await observe.submit(request())
    assert.equal(checks, 3, '只查询一次发送记录、设备和端口')
    assert.deepEqual(concurrent, first)
    assert.deepEqual(again, first)
})

test('查询设备发送状态立即返回：未收到过 found=false，排队/发送中返回 state，发送完成返回结果', async () => {
    const observe = service({}, { delayMin: 30, delayMax: 30 })
    assert.deepEqual(await observe.query({ msgId: 'm1' }), { msgId: 'm1', found: false })
    const admission = await observe.enqueue(request())
    assert.equal(admission.accepted, true)
    assert.equal(admission.statusCode, 'QUEUED')
    const pending = await observe.query({ msgId: 'm1' })
    assert.equal(pending.found, true)
    assert.ok(['queued', 'sending'].includes(pending.state))
    assert.equal(pending.result, undefined)
    const sent = await observe.submit(request())
    const settled = await observe.query({ msgId: 'm1' })
    assert.equal(settled.state, 'settled')
    assert.deepEqual(settled.result, sent)
    assert.deepEqual(await observe.query({ msgId: '' }), { msgId: '', found: false })
})

test('异步提交：发送条件不满足时拒绝受理，查询返回失败结果', async () => {
    const observe = service({ port: { online: 'offline' } })
    const admission = await observe.enqueue(request())
    assert.equal(admission.accepted, false)
    assert.equal(admission.statusCode, 'PORT_OFFLINE')
    const queried = await observe.query({ msgId: 'm1' })
    assert.equal(queried.state, 'settled')
    assert.equal(queried.result.statusCode, 'PORT_OFFLINE')
})

test('异步提交：发送完成后推送回执，带发送记录和端口定位', async () => {
    const receipts = []
    const data = fixtures()
    const observe = new ObserveService({ get: () => ({ delayMin: 0, delayMax: 0 }) }, ...repositories(data), undefined, {
        enqueueSuccess: async payload => receipts.push(payload)
    })
    await observe.submit(request())
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].msgId, 'm1')
    assert.equal(receipts[0].msgKeyId, 99)
    assert.equal(receipts[0].portKeyId, 2001)
    assert.equal(receipts[0].sendStatus, 'success')
})

test('端口队列已满时拒绝为 PORT_BUSY，换端口或稍后可重新提交同一短信', async () => {
    const config = { get: key => (key === 'queue' ? { maxSize: 1 } : { delayMin: 30, delayMax: 30 }) }
    const rows = { 1: 'm1', 2: 'm2', 3: 'm3' }
    const messageRepo = {
        findOne: async ({ where }) => ({ keyId: where.keyId, msgId: rows[where.keyId], simbankKeyId: 3001, portKeyId: 2001 })
    }
    const [, simbankRepo, portRepo] = repositories(fixtures())
    const observe = new ObserveService(config, messageRepo, simbankRepo, portRepo)
    const first = await observe.enqueue(request({ msgId: 'm1', msgKeyId: 1 }))
    // 第一条立即开始发送，离开排队；第二条排队；第三条超出上限。
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await observe.enqueue(request({ msgId: 'm2', msgKeyId: 2 }))
    const third = await observe.enqueue(request({ msgId: 'm3', msgKeyId: 3 }))
    assert.equal(first.accepted, true)
    assert.equal(second.accepted, true)
    assert.equal(third.accepted, false)
    assert.equal(third.statusCode, 'PORT_BUSY')
    assert.deepEqual(await observe.query({ msgId: 'm3' }), { msgId: 'm3', found: false }, '端口忙不记入设备发送记录')
})

test('端口队列：同一端口串行并按发送间隔发送，不同端口并行', async () => {
    let now = 0
    const sleeps = []
    const order = []
    const queue = new ObservePortQueue(
        () => undefined,
        () => now,
        async ms => {
            sleeps.push(ms)
            now += ms
        }
    )
    const job = (id, sendInterval) => ({ msgId: id, sendInterval, send: async () => order.push(id) })
    queue.push(1, job('a', 3000), 10)
    queue.push(1, job('b', 3000), 10)
    queue.push(2, job('c', 3000), 10)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(order.sort(), ['a', 'b', 'c'])
    assert.deepEqual(sleeps, [3000], '同一端口第二条等待 3000ms，第一条和其他端口不等待')
    assert.equal(queue.push(3, job('d', 0), 0), undefined, '超过上限拒绝')
})

test('设备发送记录按有效期和上限淘汰，受理抛错或端口忙时不记录', async () => {
    let now = 1000
    const ledger = new ObserveSendLedger(100, 2, () => now)
    const accepted = id => async () => ({ admission: { msgId: id, accepted: true, statusCode: 'QUEUED', statusMessage: '', time: '' } })
    await ledger.admit('a', accepted('a'))
    await ledger.admit('b', accepted('b'))
    await ledger.admit('c', accepted('c'))
    assert.equal(ledger.size, 2)
    assert.equal(ledger.get('a'), undefined, '超出上限淘汰最早的记录')
    now += 100
    assert.equal(ledger.get('b'), undefined, '过期后按未收到处理')
    await assert.rejects(() => ledger.admit('d', async () => Promise.reject(new Error('boom'))), /boom/)
    assert.equal(ledger.get('d'), undefined)
    await ledger.admit('e', async () => ({ admission: { msgId: 'e', accepted: false, statusCode: 'PORT_BUSY' }, retryable: true }))
    assert.equal(ledger.get('e'), undefined)
})

test('提交发送结果：共用网关地址，立即提交失败时抛错，未配置 gateway.hooks.simbank 时不提交', async () => {
    const { ObserveSubmitService, resolveObserveSubmitOptions } = require('../dist/modules/observe/observe.submit')
    assert.equal(resolveObserveSubmitOptions(undefined), undefined)
    assert.equal(
        resolveObserveSubmitOptions({ feign: { url: 'https://chat-web.lisfes.cn' }, hooks: { simbank: '/api/observe/simbank/webhook' } })
            .url,
        'https://chat-web.lisfes.cn/api/observe/simbank/webhook'
    )
    assert.equal(
        resolveObserveSubmitOptions({ hooks: { simbank: 'https://chat-web.lisfes.cn/api/observe/simbank/webhook' } }).url,
        'https://chat-web.lisfes.cn/api/observe/simbank/webhook'
    )
    assert.throws(() => resolveObserveSubmitOptions({ hooks: { simbank: '/api/observe/simbank/webhook' } }), /gateway\.feign\.url/)
    assert.throws(() => resolveObserveSubmitOptions({ feign: { timeout: 1 }, hooks: { simbank: 'http://x' } }), /gateway\.feign\.timeout/)
    const calls = []
    const notifier = new ObserveSubmitService({
        get: () => ({ feign: { url: 'https://chat-web.lisfes.cn', timeout: 3000 }, hooks: { simbank: '/api/observe/simbank/webhook' } })
    })

    notifier.post = async (url, init) => {
        calls.push({ url, init })
        return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 503 }
    }
    const payload = {
        msgId: 'm1',
        sendStatus: 'success',
        statusCode: 'OK',
        statusMessage: '',
        sendTime: '',
        msgKeyId: 1,
        simbankKeyId: 2,
        portKeyId: 3
    }
    await assert.rejects(() => notifier.submitNow(payload), /Hooks 返回 HTTP 503/)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' })
    assert.equal(calls[0].url, 'https://chat-web.lisfes.cn/api/observe/simbank/webhook')
    assert.equal(JSON.parse(calls[0].init.body).msgId, 'm1')
    let posted = 0
    const disabled = new ObserveSubmitService({ get: () => undefined })
    disabled.post = async () => (posted++, { ok: true })
    await assert.rejects(() => disabled.submitNow({ msgId: 'm1' }), /Hooks 回执地址/)
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(posted, 0)
})

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer().listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            server.close(() => resolve(port))
        })
        server.on('error', reject)
    })
}

test('TCP 客户端可以调用 observe.ping 并收到响应', async () => {
    const port = await freePort()
    const service = new ObserveService({ get: () => ({ delayMin: 0, delayMax: 0 }) }, ...repositories(fixtures()))
    class TestModule {}
    Module({ controllers: [ObserveController], providers: [{ provide: ObserveService, useValue: service }] })(TestModule)
    const app = await NestFactory.createMicroservice(TestModule, {
        strategy: new ObserveTcpServer({ host: '127.0.0.1', port }),
        logger: false
    })
    await app.listen()
    const client = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: '127.0.0.1', port } })
    try {
        const result = await firstValueFrom(client.send(OBSERVE_PATTERN.PING, { from: 'test', timestamp: new Date().toISOString() }))
        assert.equal(result.service, 'chat-web-observe-service')
        assert.equal(result.from, 'test')
        const sent = await firstValueFrom(client.send(OBSERVE_PATTERN.SUBMIT, request()))
        assert.equal(sent.sendStatus, 'success')
        assert.equal(sent.statusCode, 'OK')
        const queried = await firstValueFrom(client.send(OBSERVE_PATTERN.QUERY, { msgId: 'm1' }))
        assert.equal(queried.found, true)
        assert.deepEqual(queried.result, sent)
        const accepted = await firstValueFrom(client.send(OBSERVE_PATTERN.ENQUEUE, request()))
        assert.equal(accepted.accepted, true, '已受理过的短信重复提交返回第一次的受理结果')
    } finally {
        await client.close()
        await app.close()
    }
})
