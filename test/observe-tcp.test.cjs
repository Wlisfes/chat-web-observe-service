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
    } finally {
        await client.close()
        await app.close()
    }
})
