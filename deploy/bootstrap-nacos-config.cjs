'use strict'

/** 部署前准备 Observe Nacos 配置。已有配置只校验，不覆盖人工修改；Observe 只走 TCP，不追加网关路由。 */

function required(name, environment = process.env) {
    const value = environment[name]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少环境变量：${name}`)
    return value.trim()
}

function scalar(value) {
    return JSON.stringify(value)
}

function getBaseUrl(environment = process.env) {
    const server = required('NACOS_SERVER', environment)
    return (/^https?:\/\//i.test(server) ? server : `http://${server}`).replace(/\/$/, '')
}

async function getNacosAccessToken(environment = process.env) {
    const username = environment.NACOS_USERNAME?.trim()
    const password = environment.NACOS_PASSWORD
    if (!username || password === undefined) return undefined
    const response = await fetch(`${getBaseUrl(environment)}/nacos/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password })
    })
    if (!response.ok) throw new Error(`Nacos 鉴权失败：HTTP ${response.status}`)
    const result = await response.json()
    if (typeof result.accessToken !== 'string' || !result.accessToken.trim()) throw new Error('Nacos 鉴权响应缺少 accessToken')
    return result.accessToken
}

async function configUrl(dataId, environment = process.env) {
    const parameters = new URLSearchParams({
        dataId,
        group: environment.NACOS_CONFIG_GROUP?.trim() || 'DEFAULT_GROUP',
        tenant: environment.NACOS_NAMESPACE?.trim() || 'public'
    })
    const accessToken = await getNacosAccessToken(environment)
    if (accessToken) parameters.set('accessToken', accessToken)
    return `${getBaseUrl(environment)}/nacos/v1/cs/configs?${parameters}`
}

async function readConfig(dataId, environment = process.env) {
    const response = await fetch(await configUrl(dataId, environment))
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`读取 Nacos 配置失败：${dataId} HTTP ${response.status}`)
    const content = await response.text()
    return content.trim() ? content.replace(/\r\n?/g, '\n') : undefined
}

async function writeConfig(dataId, content, environment = process.env) {
    const response = await fetch(await configUrl(dataId, environment), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ content })
    })
    if (!response.ok) throw new Error(`写入 Nacos 配置失败：${dataId} HTTP ${response.status}`)
}

function topLevelBlock(content, name) {
    const lines = content.replace(/\r\n?/g, '\n').split('\n')
    const start = lines.findIndex(line => line === `${name}:`)
    if (start < 0) return undefined
    let end = lines.findIndex((line, index) => index > start && line.trim() && !line.startsWith(' ') && !line.startsWith('#'))
    if (end < 0) end = lines.length
    return lines.slice(start, end).join('\n').trimEnd()
}

function createObserveConfig(source, environment = process.env) {
    const gateway = topLevelBlock(source, 'gateway')
    if (!gateway) throw new Error('来源 Nacos 配置缺少 gateway，无法生成 Observe 配置')
    return `# 服务监听配置。
server:
  # 容器内 HTTP 监听端口：健康检查和 Swagger。
  port: 5100

# TCP 监听配置：Dispatch 通过 Docker 网络调用 chat-web-observe-service:5101。
tcp:
  host: "0.0.0.0"
  port: 5101

# 模拟发送参数：设备耗时区间（毫秒）和随机失败比例（0-1）；修改后立即生效。
simulate:
  delayMin: 100
  delayMax: 500
  failureRate: 0

# 端口发送队列：每个端口最多排队的短信数，超过时 Dispatch 换端口提交。
queue:
  maxSize: 100

# 服务间调用与网关身份上下文验签配置；从现有服务复制，必须与 Gateway 保持一致。
# gateway.hooks.simbank 拼到 gateway.feign.url 后面，回执和网关共用同一请求地址。
${withSimbankWebhook(gateway)}

# Observe 只读 SRM 设备短信记录、设备和端口；账号只授权这三张表的 SELECT。
database:
  chat-web-srm:
    host: ${scalar(environment.OBSERVE_MYSQL_HOST?.trim() || 'mysql')}
    port: ${Number(environment.OBSERVE_MYSQL_PORT || 3306)}
    database: "chat-web-srm"
    username: ${scalar(required('OBSERVE_MYSQL_USERNAME', environment))}
    password: ${scalar(required('OBSERVE_MYSQL_PASSWORD', environment))}
    charset: "utf8mb4"
    timezone: "+08:00"
`
}

function withSimbankWebhook(gateway) {
    if (/^\s+hooks:/m.test(gateway) && /simbank:/.test(gateway)) return gateway
    return `${gateway.trimEnd()}\n  hooks:\n    simbank: /api/observe/simbank/webhook\n`
}

function validateObserveConfig(content) {
    if (!/^\s+port:\s*5100\s*$/m.test(content)) throw new Error('Observe Nacos 配置缺少 server.port: 5100')
    if (!/^tcp:/m.test(content) || !/^\s+port:\s*5101\s*$/m.test(content)) throw new Error('Observe Nacos 配置缺少 tcp.port: 5101')
    if (!content.includes('chat-web-srm:')) throw new Error('Observe Nacos 配置缺少 database.chat-web-srm')
    if (!content.includes('service_token:') || !content.includes('secret:')) throw new Error('Observe Nacos 配置缺少网关凭据')
    return content
}

async function ensureObserveConfig(environment = process.env) {
    const dataId = environment.NACOS_CONFIG_DATA_ID?.trim() || 'chat-web-observe-service.yaml'
    const existing = await readConfig(dataId, environment)
    if (existing) {
        validateObserveConfig(existing)
        return false
    }
    const source = await readConfig('chat-web-srm-service.yaml', environment)
    if (!source) throw new Error('未找到 chat-web-srm-service.yaml，无法复制网关配置')
    await writeConfig(dataId, validateObserveConfig(createObserveConfig(source, environment)), environment)
    return true
}

async function main() {
    const created = await ensureObserveConfig()
    process.stdout.write(created ? 'Observe Nacos 配置已创建\n' : 'Observe Nacos 配置已存在且校验通过\n')
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
    })
}

module.exports = { createObserveConfig, validateObserveConfig }