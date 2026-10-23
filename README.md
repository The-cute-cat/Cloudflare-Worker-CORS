# Cloudflare Worker 通用 CORS 代理  

**版本：** 1.3  
**最后更新：** 2026年10月24日  

---

## 1. 概述  

这是一个部署在 [Cloudflare Workers](https://workers.cloudflare.com/) 上的 **通用 CORS 代理服务**，专为解决以下跨域问题设计：  

- ✅ 绕过目标服务器的 CORS 限制  
- ✅ 支持自动跟随重定向（最多 10 次）  
- ✅ 透传 Cookie 实现身份认证  
- ✅ 伪装 Referer 绕过防盗链（403 Forbidden）  
- ✅ 暴露关键响应头给客户端  

> **适用场景**：前端应用需要安全地访问第三方 API/资源，且目标服务器未配置 CORS 或设置了严格防盗链策略。

---

## 2. 核心功能特性  

| 功能              | 说明                                                         |
| ----------------- | ------------------------------------------------------------ |
| **CORS 完全支持** | 自动注入标准 CORS 响应头，允许所有域访问 (`Access-Control-Allow-Origin: *`) |
| **智能重定向**    | 手动处理 3xx 重定向，最多跟随 10 次，记录最终 URL 和重定向次数 |
| **Cookie 隧道**   | 通过 `X-Forwarded-Cookie` 和 `X-Set-Cookie` 头实现跨域 Cookie 透传 |
| **Referer 伪装**  | 自动将 Referer 设置为目标域名的根路径，绕过防盗链            |
| **安全过滤**      | 仅允许 HTTP/HTTPS 协议，过滤危险请求头（Host/Origin/Cookie/身份 IP 头），剥离上游 `access-control-*` |
| **目标白名单**    | 可选，由环境变量 `ALLOWED_TARGETS` 控制，**默认不限制**任意目标域名 |
| **调试信息**      | 暴露 `X-Redirect-Count` 和 `X-Final-URL` 便于问题排查        |

---

## 3. 部署指南  

### 前置条件  

- [Cloudflare 账号](https://dash.cloudflare.com/)（免费计划可用）  
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（Cloudflare Worker 官方工具）  

### 部署步骤  

```bash
# 1. 安装 Wrangler
npm install -g wrangler

# 2. 登录 Cloudflare
wrangler login

# 3. 创建新项目
wrangler init cors-proxy
cd cors-proxy

# 4. 替换 src/index.js 内容为本代理代码

# 5. 部署到 Cloudflare
wrangler deploy
```

### 博客教程

https://blog.csdn.net/The_cute_cat/article/details/155246143

### 安全加固（可选）  

#### 目标域名白名单（默认关闭）

代码已内置白名单逻辑，由环境变量 `ALLOWED_TARGETS` 驱动。**不配置、配置为空字符串或空数组时不做任何限制**，代理保持通用；一旦配置，只有命中白名单的目标域名才会被转发，其余返回 `403 Target domain not allowed`。

在 `wrangler.toml` 中配置：

```toml
[vars]
# 写法一：数组
ALLOWED_TARGETS = ["api.example.com", "data.trusted-domain.org"]
# 写法二：逗号分隔字符串（等价）
# ALLOWED_TARGETS = "api.example.com,data.trusted-domain.org"
```

也可以直接在 Dashboard → Workers → 你的 Worker → **Settings → Variables** 中新增该变量，改完即时生效，无需改代码。

匹配规则：

- 大小写不敏感；可写成完整 URL 或带端口（`https://api.example.com:443/` 会被自动归一化为 `api.example.com`）；
- **子域名自动包含**：配置 `example.com` 时 `api.example.com`、`a.b.example.com` 均放行；
- 不做后缀模糊匹配：配置 `example.com` 时 `evilexample.com` 会被拒绝；
- **重定向逐跳校验**：初始目标与每一跳 3xx 的落点都要命中白名单，否则返回 `403`。因此若目标站点会跳到 CDN 域名（如 `github.com` → `objects.githubusercontent.com`），需要把该域名一并加入。

#### 自定义域名

公开的 `*.workers.dev` 地址容易被扫描滥用，建议绑定自定义域名后使用：

```toml
routes = [
  { pattern = "your-worker-subdomain.workers.dev", custom_domain = true }
]
```

> **重要**：公开代理可能被滥用！建议结合 [Cloudflare Access](https://www.cloudflare.com/products/zero-trust/access/) 与 [Rate Limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/) 进一步收紧。

---

## 4. 客户端调用方法  

### 基本请求格式  

```
GET https://your-worker-subdomain.workers.dev?url=<目标URL编码>
```

### 关键请求头  

| 头字段               | 作用                                        | 示例值                         |
| -------------------- | ------------------------------------------- | ------------------------------ |
| `X-Forwarded-Cookie` | **必需**：传递客户端 Cookie（解决跨域认证） | `session_id=abc123; token=xyz` |
| `Authorization`      | 透传到目标服务器（如 Bearer Token）         | `Bearer <your_token>`          |
| `Content-Type`       | 仅当请求含 body 时需要（POST/PUT）          | `application/json`             |

### 响应头说明  

| 头字段             | 作用                                               |
| ------------------ | -------------------------------------------------- |
| `X-Set-Cookie`     | 代理收集的所有 `Set-Cookie` 值（客户端需手动存储） |
| `X-Redirect-Count` | 重定向次数（仅当发生重定向时存在）                 |
| `X-Final-URL`      | 最终请求的 URL（用于调试重定向链）                 |
| `Access-Control-*` | 标准 CORS 头（允许前端读取响应）                   |

---

## 5. 使用示例  

### 前端 JavaScript 调用  

```javascript
// 封装代理请求函数
async function proxyFetch(targetUrl, options = {}) {
  const workerUrl = new URL('https://your-worker-subdomain.workers.dev');
  workerUrl.searchParams.append('url', encodeURIComponent(targetUrl));
  
  const headers = new Headers(options.headers || {});
  // 传递当前页面的 Cookie（需服务端支持）
  if (document.cookie) {
    headers.set('X-Forwarded-Cookie', document.cookie);
  }
  
  const response = await fetch(workerUrl, {
    ...options,
    headers
  });
  
  // 处理代理返回的 Cookie
  const proxyCookies = response.headers.get('X-Set-Cookie');
  if (proxyCookies) {
    // 注意：浏览器禁止前端直接设置跨域 Cookie
    // 需将 Cookie 存储在本地，后续请求通过 X-Forwarded-Cookie 传回
    localStorage.setItem('proxyCookies', proxyCookies);
  }
  
  return response;
}

// 调用示例
const apiResponse = await proxyFetch('https://api.example.com/data', {
  headers: {
    'Authorization': 'Bearer <your_token>'
  }
});

const data = await apiResponse.json();
console.log('API Response:', data);
```

### cURL 测试命令  

```bash
curl "https://your-worker-subdomain.workers.dev?url=https://httpbin.org/cookies/set?name=value" \
  -H "X-Forwarded-Cookie: test_cookie=initial" \
  -v
```

**预期响应头包含**：  

```
< X-Set-Cookie: name=value; Path=/
< X-Redirect-Count: 1
< X-Final-URL: https://httpbin.org/cookies
```

---

## 6. 错误处理与状态码  

| 状态码 | 错误原因                       | 解决方案                                  |
| ------ | ------------------------------ | ----------------------------------------- |
| `400`  | 缺少 `?url=` 参数              | 检查请求 URL 是否包含 `url` 查询参数      |
| `400`  | URL 格式无效                   | 确保 URL 经过 `encodeURIComponent` 编码   |
| `400`  | 非 HTTP/HTTPS 协议             | 仅允许 `http://` 或 `https://` 开头的 URL |
| `508`  | 超过最大重定向次数 (10)        | 检查目标 URL 重定向链是否异常             |
| `500`  | 代理内部错误                   | 查看 Cloudflare Worker 日志获取详情       |
| `403`  | 目标域名不在 `ALLOWED_TARGETS` 白名单内 | 把目标域名加入白名单，或清空该变量以取消限制 |
| `403`  | 目标 URL 中包含本代理域名（递归调用） | 不要在 `url` 参数里嵌套本代理自身 |
| `403`  | 目标服务器拒绝（可能需额外头） | 尝试添加 `User-Agent` 或 `Authorization`  |

---

## 7. 限制与注意事项  

### ⚠️ 重要限制  

- **流式与大文件**：响应体以流的形式透传，SSE / 长连接流式输出正常，大文件（实测 10MB）可完整下载；真正的限制是 Worker 的 CPU 时间与单请求超时，而不是 body 大小
- **不支持 Range 分段下载**：上游的 `Content-Range` 会透传，但 `Content-Length` 被剥离后由运行时重新计算，断点续传 / 视频拖动的行为取决于上游与客户端，不建议依赖
- **目标可达性取决于出口 IP**：代理出口是 Cloudflare 的 IP 段，目标站点若封禁 Cloudflare 或做反爬（403/412/503），本代理同样访问不到
- **客户端 IP 会暴露给上游**：`CF-Connecting-IP` 等由边缘注入，Worker 侧过滤无法保证完全剥离，敏感场景不要把它当匿名通道
- **Cookie 作用域**：  
  - 代理不会自动设置浏览器 Cookie（需客户端手动处理 `X-Set-Cookie`）  
  - 仅在**同源重定向**链内延续 Cookie，跨域跳转时不会把上一站的 Cookie 带给新域名  
  - 仅支持第一方 Cookie，第三方 Cookie 可能被浏览器拦截  
- **协议限制**：仅支持 `http`/`https`，**不支持** `ftp`/`ws`/`file` 等协议  
- **超时限制**：Cloudflare Worker 默认 100 秒超时（[企业计划](https://www.cloudflare.com/plans/developer-platform/) 可延长）  

### 🛡️ 安全建议  

1. **限制目标域名**：配置环境变量 `ALLOWED_TARGETS`（用法见 [3. 安全加固](#安全加固可选)）。代码内置该逻辑，**默认不限制**，需要时再开启  

2. **添加调用频率限制**：使用 [Cloudflare Rate Limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/)  

3. **隐藏 Worker URL**：通过自定义域名访问（避免被公开扫描滥用）  

---

## 8. 贡献与反馈  

- **报告问题**：[创建 GitHub Issue](https://github.com/The-cute-cat/Cloudflare-Worker-CORS/issues)（提供 Worker 日志和复现步骤）  
- **功能请求**：欢迎提交 PR（需包含单元测试）  
- **紧急漏洞**：issue@hopecat.dpdns.org  

> **免责声明**：本代理仅用于合法场景。滥用可能导致 Cloudflare 账号被封禁。请遵守目标服务器的 `robots.txt` 和服务条款。

---

**附录：完整 Worker 代码**  
[点击此处获取最新代码](https://codeload.github.com/The-cute-cat/Cloudflare-Worker-CORS/zip/refs/heads/master)  

> 部署前请务必阅读 [Cloudflare 服务条款](https://www.cloudflare.com/terms/) 和 [Acceptable Use Policy](https://www.cloudflare.com/website-terms/)。
