# Missevan Backup Call

Railway 主站触发猫耳 `418` 后使用的 Render 备用代理。它只代理当前主站需要的猫耳 JSON/XML 接口，不代理图片、音频、视频或漫播请求。

## 本地运行

```bash
npm install
$env:PROXY_TOKEN="replace-with-long-random-token"
npm run dev
```

默认本地端口是 `6333`，避免和主站 `3000` 冲突：

```text
http://localhost:6333/healthz
```

环境变量：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PORT` | - | Render 注入的监听端口，优先级最高 |
| `LOCAL_PORT` | `6333` | 本地端口 |
| `PROXY_TOKEN` | - | 代理鉴权 token，建议必填 |
| `MISSEVAN_UPSTREAM_ORIGIN` | `https://www.missevan.com` | 猫耳上游 |
| `UPSTREAM_TIMEOUT_MS` | `10000` | 上游请求超时 |

## 代理接口

健康检查不访问猫耳：

```bash
curl -i "http://localhost:6333/healthz"
```

代理请求需要 `x-proxy-token`：

```bash
curl "http://localhost:6333/missevan/sound/getsound?soundid=12649785" `
  -H "x-proxy-token: replace-with-long-random-token"
```

允许的上游路径：

| 路径 | 用途 |
|---|---|
| `/dramaapi/search` | 猫耳搜索 JSON |
| `/sound/getsound` | 声音详情 JSON |
| `/dramaapi/getdramabysound` | 根据声音取剧集 JSON |
| `/dramaapi/getdrama` | 剧集详情 JSON |
| `/reward/user-reward-rank` | 打赏榜 JSON |
| `/reward/drama-reward-detail` | 打赏元数据 JSON |
| `/sound/getdm` | 弹幕 XML/text |

禁止代理 `.jpg/.png/.webp/.mp3/.m4a/.mp4/.m3u8/.ts` 等媒体资源，也不代理 Manbo。

## Render 部署

使用 `render.yaml` 创建 Free Web Service。Render 中必须配置：

```env
PROXY_TOKEN=replace-with-long-random-token
MISSEVAN_UPSTREAM_ORIGIN=https://www.missevan.com
UPSTREAM_TIMEOUT_MS=10000
```

UptimeRobot 只 ping：

```text
https://your-render-service.onrender.com/healthz
```

不要 ping `/missevan/...`，否则会制造无意义猫耳外部请求。

## Railway 后续接入

主站后续接入时建议使用：

```env
MISSEVAN_FALLBACK_BASE_URL=https://your-render-service.onrender.com/missevan
MISSEVAN_FALLBACK_PROXY_TOKEN=replace-with-long-random-token
```

数据流：

```text
正常:
用户 -> Railway 主站 -> 猫耳 API

触发 418 后:
用户 -> Railway 主站 -> Render 备用代理 -> 猫耳 API

禁止:
用户 -> Railway 主站 -> Render 备用代理 -> 图片/音视频/漫播
```

## 免费额度评估

Render Hobby 当前包含 `5GB/月` outbound bandwidth、`750小时/月/workspace` Free instance hours。免费 Web Service 会在 `15分钟` 无入站流量后休眠，下一次 HTTP 请求唤醒约 `1分钟`。

| 使用方式 | 是否可能压进 5GB |
|---|---|
| 只在 Railway 猫耳 `418` 后启用 | 大概率可以 |
| 常态分流小 JSON 请求 | 取决于月请求数 |
| 大量 `/sound/getdm` 弹幕 XML | 可能接近或超过 |
| 代理图片/音频/视频 | 不可行 |

如果使用 UptimeRobot 每 `10分钟` 访问 `/healthz`，单服务常驻一个 31 天月份约 `744小时`，基本贴近 `750小时` 上限。同一 workspace 不建议再保活第二个免费 Web Service。

## 测试

```bash
npm test
```
