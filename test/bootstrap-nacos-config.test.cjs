const test = require('node:test')
const assert = require('node:assert/strict')
const { createObserveConfig, validateObserveConfig } = require('../deploy/bootstrap-nacos-config.cjs')

const source = `server:
  port: 5070
gateway:
  feign:
    service_token: "token"
    url: http://chat-web-gateway-service:5000
    timeout: 3000
  principal:
    secret: "secret"
    maxAgeSeconds: 60
redis:
  host: chat-web-redis
`

test('Observe Nacos 配置包含 HTTP 5100、TCP 5101 和 SRM 只读库连接', () => {
    const content = createObserveConfig(source, { OBSERVE_MYSQL_USERNAME: 'chat_web_observe_service', OBSERVE_MYSQL_PASSWORD: 'pass' })
    validateObserveConfig(content)
    assert.match(content, /port: 5100/)
    assert.match(content, /tcp:\n  host: "0.0.0.0"\n  port: 5101/)
    assert.match(content, /username: "chat_web_observe_service"/)
    assert.doesNotMatch(content, /redis:/)
})

test('缺少 TCP 配置时校验失败', () => {
    assert.throws(() => validateObserveConfig('server:\n  port: 5100\n'), /tcp\.port/)
})
