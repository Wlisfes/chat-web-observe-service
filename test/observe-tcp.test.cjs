const test = require('node:test')
const assert = require('node:assert/strict')
const { ClientProxyFactory, Transport } = require('@nestjs/microservices')
const net = require('node:net')
const { NestFactory } = require('@nestjs/core')
const { firstValueFrom } = require('rxjs')
const { OBSERVE_PATTERN } = require('@wlisfes/chat-web-base-schema/observe')
const { ObserveModule } = require('../dist/modules/observe/observe.module')
const { ObserveService } = require('../dist/modules/observe/observe.service')
const { resolveObserveTcpOptions } = require('../dist/modules/observe/observe.constants')
const { ObserveTcpServer } = require('../dist/modules/observe/observe.server')

test('TCP 监听地址：环境变量优先，其次 Nacos tcp 节点，最后默认 0.0.0.0:5101', () => {
    assert.deepEqual(resolveObserveTcpOptions(undefined, {}), { host: '0.0.0.0', port: 5101 })
    assert.deepEqual(resolveObserveTcpOptions({ host: '127.0.0.1', port: 6000 }, {}), { host: '127.0.0.1', port: 6000 })
    assert.deepEqual(resolveObserveTcpOptions({ port: 6000 }, { OBSERVE_TCP_PORT: '5103' }), { host: '0.0.0.0', port: 5103 })
    assert.throws(() => resolveObserveTcpOptions({ port: 70000 }, {}), /1-65535/)
})

test('ping 返回服务名称并原样带回调用方', () => {
    const result = new ObserveService().ping({ from: 'chat-web-dispatch-service', timestamp: '' })
    assert.equal(result.service, 'chat-web-observe-service')
    assert.equal(result.from, 'chat-web-dispatch-service')
    assert.equal(new ObserveService().ping(undefined).from, 'unknown')
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
    const app = await NestFactory.createMicroservice(ObserveModule, {
        strategy: new ObserveTcpServer({ host: '127.0.0.1', port }),
        logger: false
    })
    await app.listen()
    const client = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: '127.0.0.1', port } })
    try {
        const result = await firstValueFrom(client.send(OBSERVE_PATTERN.PING, { from: 'test', timestamp: new Date().toISOString() }))
        assert.equal(result.service, 'chat-web-observe-service')
        assert.equal(result.from, 'test')
    } finally {
        await client.close()
        await app.close()
    }
})
