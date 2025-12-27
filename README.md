# Cloudflare Worker 通用 CORS 代理  

**版本：** 1.2  
**最后更新：** 2025年12月27日  

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
| **安全过滤**      | 仅允许 HTTP/HTTPS 协议，过滤危险请求头（Host/Origin）        |
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

### 安全加固（生产环境必需）  

在 `wrangler.toml` 中添加以下限制：  

```toml
# 仅允许特定来源调用（替换 your-app.com）
routes = [
  { pattern = "your-worker-subdomain.workers.dev", custom_domain = true }
]

# 限制目标域名（可选但强烈推荐）
[vars]
ALLOWED_TARGETS = ["api.example.com", "data.trusted-domain.org"]
```

> **重要**：公开代理可能被滥用！建议结合 [Cloudflare Access](https://www.cloudflare.com/products/zero-trust/access/) 添加身份验证。

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
| `403`  | 目标服务器拒绝（可能需额外头） | 尝试添加 `User-Agent` 或 `Authorization`  |

---

## 7. 限制与注意事项  

### ⚠️ 重要限制  

- **不支持流式响应**：大文件下载可能失败（Cloudflare Worker 限制）  
- **Cookie 作用域**：  
  - 代理不会自动设置浏览器 Cookie（需客户端手动处理 `X-Set-Cookie`）  
  - 仅支持第一方 Cookie，第三方 Cookie 可能被浏览器拦截  
- **协议限制**：仅支持 `http`/`https`，**不支持** `ftp`/`ws`/`file` 等协议  
- **超时限制**：Cloudflare Worker 默认 100 秒超时（[企业计划](https://www.cloudflare.com/plans/developer-platform/) 可延长）  

### 🛡️ 安全建议  

1. **限制目标域名**：在代码中添加白名单（修改 `ALLOWED_TARGETS` 逻辑）  

   ```javascript
   const ALLOWED_TARGETS = ['api.example.com', 'data.trusted.org'];
   if (!ALLOWED_TARGETS.some(domain => parsedTarget.hostname.endsWith(domain))) {
     return new Response('Target domain not allowed', { status: 403 });
   }
   ```

2. **添加调用频率限制**：使用 [Cloudflare Rate Limiting](https://developers.cloudflare.com/fundamentals/get-started/setup/rate-limiting/)  

3. **隐藏 Worker URL**：通过自定义域名访问（避免被公开扫描滥用）  

---

## 8. 贡献与反馈  

- **报告问题**：[创建 GitHub Issue](https://github.com/The-cute-cat/Cloudflare-Worker-CORS/issues)（提供 Worker 日志和复现步骤）  
- **功能请求**：欢迎提交 PR（需包含单元测试）  
- **紧急漏洞**：qwerty6u7i8o9p0@163.com  

> **免责声明**：本代理仅用于合法场景。滥用可能导致 Cloudflare 账号被封禁。请遵守目标服务器的 `robots.txt` 和服务条款。

---

**附录：完整 Worker 代码**  
[点击此处获取最新代码](https://github.com/The-cute-cat/Cloudflare-Worker-CORS)  

> 部署前请务必阅读 [Cloudflare 服务条款](https://www.cloudflare.com/terms/) 和 [Acceptable Use Policy](https://www.cloudflare.com/website-terms/)。