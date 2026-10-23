/**
 * Cloudflare Worker 通用 CORS 代理
 * 支持重定向跟随和 Cookie 隧道传输
 * 完整浏览器伪装（绕过反爬检测）
 */

/**
 * 解析目标域名白名单（来自环境变量 ALLOWED_TARGETS）
 * 支持两种写法：["api.example.com", "example.org"] 或 "api.example.com,example.org"
 * 未配置 / 空值 / 空数组 ⇒ 返回空数组 ⇒ 不限制目标域名（默认，保留通用性）
 */
function parseAllowedTargets(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    return list
        .map(item => String(item).trim().toLowerCase())
        .map(item => item.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')) // 允许误写成完整 URL
        .map(item => item.replace(/\/.*$/, ''))                  // 去掉路径
        .map(item => item.replace(/:\d+$/, ''))                  // 去掉端口
        .filter(Boolean);
}

/**
 * 判断目标主机是否命中白名单（含子域名）
 */
function isTargetAllowed(hostname, allowedTargets) {
    if (allowedTargets.length === 0) return true;
    const host = hostname.toLowerCase();
    return allowedTargets.some(domain => host === domain || host.endsWith('.' + domain));
}

export default {
    async fetch(request, env, ctx) {
        // 1. 定义 CORS 响应头
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
            'Access-Control-Allow-Headers': 'Content-Type, X-Forwarded-Cookie, Authorization, Accept, Accept-Language, Accept-Encoding, Cache-Control, Pragma',
            'Access-Control-Expose-Headers': 'X-Set-Cookie, Date, Content-Length, X-Redirect-Count, X-Final-URL, Content-Type',
            'Access-Control-Max-Age': '86400',
        };

        // 2. 处理预检请求 (OPTIONS)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        const url = new URL(request.url);
        const target = url.searchParams.get('url');

        // 2.5 递归调用检测：比对解析后的 hostname，而不是对整个 URL 字符串做 includes，
        // 否则目标 URL 的 query/path 里恰好含本代理域名时会被误判。
        const selfHost = url.hostname.toLowerCase();
        if (target) {
            let recurseProbe = null;
            try {
                recurseProbe = new URL(target);
            } catch (err) {
                // 非法 URL 交给下面的 400 分支处理
            }
            if (recurseProbe && recurseProbe.hostname.toLowerCase() === selfHost) {
                return new Response('Detected Recursive Proxy Loop', {
                    status: 403,
                    headers: corsHeaders
                });
            }
        }

        // 3. 检查目标 URL 参数
        if (!target) {
            return new Response('Missing ?url= parameter in proxy request.', {
                status: 400,
                headers: corsHeaders
            });
        }

        try {
            let parsedTarget;
            try {
                parsedTarget = new URL(target);
            } catch (err) {
                return new Response('Invalid URL format.', {
                    status: 400,
                    headers: corsHeaders
                });
            }

            // 基础安全检查
            if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
                return new Response('Only HTTP/HTTPS URLs are allowed.', {
                    status: 400,
                    headers: corsHeaders
                });
            }

            // 目标域名白名单：默认不限制，仅在配置了 ALLOWED_TARGETS 时生效
            const allowedTargets = parseAllowedTargets(env && env.ALLOWED_TARGETS);

            // 4. 初始化变量
            let currentUrl = parsedTarget.href;
            const maxRedirects = 10;
            let redirectCount = 0;
            let finalResponse = null;
            const allSetCookies = [];

            // Cookie 按源（origin）隔离：某个源只会收到它自己下发/客户端指定给它的 Cookie，
            // 跨域重定向时不会把上一站的凭证带给新域名。
            const cookieJar = new Map();
            const initialCookie = request.headers.get('X-Forwarded-Cookie') || '';
            if (initialCookie) {
                cookieJar.set(parsedTarget.origin, initialCookie);
            }

            // 请求体只读一次：流被 body 消费后无法在重定向循环中复用
            const hasBody = !['GET', 'HEAD'].includes(request.method);
            const requestBody = hasBody ? await request.arrayBuffer() : null;

            // 5. 重定向跟随循环（手动处理）
            while (redirectCount < maxRedirects) {
                const currentParsed = new URL(currentUrl);

                // 白名单逐跳校验：初始目标与每一跳重定向都要检查，
                // 否则白名单内的域名只要 302 到任意站点即可绕过限制。
                if (!isTargetAllowed(currentParsed.hostname, allowedTargets)) {
                    return new Response(`Target domain not allowed: ${currentParsed.hostname}`, {
                        status: 403,
                        headers: {
                            ...corsHeaders,
                            'Content-Type': 'text/plain;charset=UTF-8'
                        }
                    });
                }

                // 准备代理请求头 - 完整浏览器伪装
                const proxyHeaders = new Headers();

                // ✅ 设置完整的浏览器请求头
                proxyHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
                proxyHeaders.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7');
                proxyHeaders.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
                // 不手动设置 Accept-Encoding：由 Workers 运行时自动协商并透明解压，
                // 否则上游返回压缩体、而响应头里的 content-encoding 被丢弃，客户端会拿到乱码或挂死。
                proxyHeaders.set('Cache-Control', 'max-age=0');
                proxyHeaders.set('Sec-Ch-Ua', '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"');
                proxyHeaders.set('Sec-Ch-Ua-Mobile', '?0');
                proxyHeaders.set('Sec-Ch-Ua-Platform', '"Windows"');
                proxyHeaders.set('Sec-Fetch-Dest', 'document');
                proxyHeaders.set('Sec-Fetch-Mode', 'navigate');
                proxyHeaders.set('Sec-Fetch-Site', 'same-origin');
                proxyHeaders.set('Sec-Fetch-User', '?1');
                proxyHeaders.set('Upgrade-Insecure-Requests', '1');

                // ✅ 伪装 Referer 为目标站根路径（防防盗链，Origin 则被丢弃）
                // Host 由 new Request(url) 的 URL 自动决定，无需也无法手动设置
                proxyHeaders.set('Referer', currentParsed.origin + '/');

                // 复制客户端自定义请求头（排除敏感头）
                const skipHeaders = [
                    // 由本代理统一重写的头
                    'origin', 'host', 'cookie', 'user-agent', 'accept', 'accept-language',
                    'accept-encoding', 'referer', 'connection',
                    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
                    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
                    'upgrade-insecure-requests',
                    // 隧道专用头，不应泄漏给上游
                    'x-forwarded-cookie',
                    // 客户端身份/来源 IP 相关头，不透传给上游。
                    // 注意：cf-ray / cf-visitor / cf-ew-via / cf-worker / cdn-loop 由边缘为
                    // 每个子请求重新生成，这里只是尽力而为，实际可能仍会出现在上游请求里。
                    'x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip',
                    'cf-connecting-ip', 'cf-worker', 'cf-ray', 'cf-visitor', 'cf-ew-via',
                    'cdn-loop',
                ];
                for (const [key, value] of request.headers.entries()) {
                    const lowerKey = key.toLowerCase();
                    if (!skipHeaders.includes(lowerKey)) {
                        proxyHeaders.set(key, value);
                    }
                }

                // 添加该源自己的 Cookie（来自 X-Forwarded-Cookie 或前序同源响应）
                const hopCookie = cookieJar.get(currentParsed.origin);
                if (hopCookie) {
                    proxyHeaders.set('Cookie', hopCookie);
                }

                // 发起请求（手动处理重定向）
                const proxyRequest = new Request(currentUrl, {
                    method: request.method,
                    headers: proxyHeaders,
                    body: requestBody,
                    redirect: 'manual',
                });

                const response = await fetch(proxyRequest);

                // 收集 Set-Cookie（支持多 Cookie）
                const setCookies = response.headers.getSetCookie?.() || [];
                if (setCookies.length === 0 && response.headers.has('Set-Cookie')) {
                    const sc = response.headers.get('Set-Cookie');
                    if (sc) setCookies.push(sc);
                }

                if (setCookies.length > 0) {
                    for (const cookie of setCookies) {
                        allSetCookies.push(cookie);
                    }
                    // 只回写给下发这些 Cookie 的那个源
                    const jar = cookieJar.get(currentParsed.origin) || '';
                    const added = setCookies.map(cookie => cookie.split(';')[0]).filter(Boolean).join('; ');
                    cookieJar.set(currentParsed.origin, jar ? `${jar}; ${added}` : added);
                }

                // 检查是否为重定向
                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('Location');
                    if (!location) {
                        finalResponse = response;
                        break;
                    }

                    try {
                        const redirectUrl = new URL(location, currentUrl);
                        // Cookie 已按源存放在 cookieJar 中，跨域跳转时新域名取不到上一站的 Cookie，
                        // 因此这里无需特殊处理，正常推进即可。
                        currentUrl = redirectUrl.href;
                        redirectCount++;
                        continue;
                    } catch (err) {
                        console.error('Failed to parse redirect URL:', err);
                        finalResponse = response;
                        break;
                    }
                } else {
                    finalResponse = response;
                    break;
                }
            }

            // 超过最大重定向次数
            if (redirectCount >= maxRedirects) {
                return new Response('Too many redirects', {
                    status: 508,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': 'text/plain'
                    }
                });
            }

            // 构建最终响应头
            const responseHeaders = new Headers();

            // 复制响应头，但跳过某些头
            // - access-control-*：CORS 头统一由本代理重写，否则上游的
            //   access-control-allow-credentials: true 会与 ACAO:* 组成非法组合，浏览器直接拒绝。
            // - content-length：有 body 时交给运行时按实际字节数计算，避免压缩/解压后长度不符；
            //   HEAD 没有 body，运行时无从重算，保留上游值以便客户端"先探大小"。
            const skipResponseHeaders = ['set-cookie', 'content-encoding', 'transfer-encoding'];
            const keepContentLength = request.method === 'HEAD';
            for (const [key, value] of finalResponse?.headers.entries()) {
                const lowerKey = key.toLowerCase();
                if (skipResponseHeaders.includes(lowerKey) || lowerKey.startsWith('access-control-')) {
                    continue;
                }
                if (lowerKey === 'content-length' && !keepContentLength) {
                    continue;
                }
                responseHeaders.set(key, value);
            }

            // 暴露收集到的 Set-Cookie（通过 X-Set-Cookie）
            for (const cookie of allSetCookies) {
                responseHeaders.append('X-Set-Cookie', cookie);
            }

            // 合并 CORS 头
            for (const [k, v] of Object.entries(corsHeaders)) {
                responseHeaders.set(k, v);
            }

            // 添加调试信息
            if (redirectCount > 0) {
                responseHeaders.set('X-Redirect-Count', redirectCount.toString());
                responseHeaders.set('X-Final-URL', currentUrl);
            }

            // 返回最终响应
            return new Response(finalResponse?.body, {
                status: finalResponse?.status,
                statusText: finalResponse?.statusText,
                headers: responseHeaders,
            });

        } catch (err) {
            console.error('Proxy error:', err);
            return new Response(`Proxy execution error: ${err.message}`, {
                status: 500,
                headers: corsHeaders
            });
        }
    },
};