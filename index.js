export default {
    async fetch(request, env, ctx) {
        // 1. 定义 CORS 响应头
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Forwarded-Cookie, Authorization',
            'Access-Control-Expose-Headers': 'X-Set-Cookie, Date, Content-Length, X-Redirect-Count, X-Final-URL',
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

            // 4. 初始化变量
            let currentUrl = parsedTarget.href;
            const maxRedirects = 10;
            let redirectCount = 0;
            let finalResponse = null;
            const allSetCookies = [];
            let clientCookie = request.headers.get('X-Forwarded-Cookie') || '';

            // 5. 重定向跟随循环（手动处理）
            while (redirectCount < maxRedirects) {
                const currentParsed = new URL(currentUrl); // 用于生成 Referer

                // 准备代理请求头
                const proxyHeaders = new Headers();

                // 复制原始请求头（排除敏感头）
                for (const [key, value] of request.headers.entries()) {
                    const lowerKey = key.toLowerCase();
                    if (!['origin', 'host', 'cookie'].includes(lowerKey)) {
                        proxyHeaders.set(key, value);
                    }
                }

                // B. 伪装 Referer 为目标 origin（防 403）
                proxyHeaders.set('Referer', currentParsed.origin + '/');

                // 添加客户端 Cookie（通过 X-Forwarded-Cookie 传入）
                if (clientCookie) {
                    proxyHeaders.set('Cookie', clientCookie);
                }

                // 设置默认 User-Agent（如未提供）
                if (!proxyHeaders.has('User-Agent')) {
                    proxyHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                }

                // 发起请求（手动处理重定向）
                const proxyRequest = new Request(currentUrl, {
                    method: request.method,
                    headers: proxyHeaders,
                    body: (['GET', 'HEAD'].includes(request.method)) ? null : request.body,
                    redirect: 'manual', // 手动控制重定向
                });

                const response = await fetch(proxyRequest);

                // 收集 Set-Cookie（支持多 Cookie）
                const setCookies = response.headers.getSetCookie?.() || [];
                // 兼容旧环境：回退到 get('Set-Cookie')
                if (setCookies.length === 0 && response.headers.has('Set-Cookie')) {
                    const sc = response.headers.get('Set-Cookie');
                    if (sc) setCookies.push(sc);
                }

                if (setCookies.length > 0) {
                    for (const cookie of setCookies) {
                        allSetCookies.push(cookie);
                        // 提取 name=value 部分用于后续 Cookie 拼接
                        const kv = cookie.split(';')[0];
                        if (clientCookie) {
                            clientCookie = `${clientCookie}; ${kv}`;
                        } else {
                            clientCookie = kv;
                        }
                    }
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

            // 复制响应头，但跳过 Set-Cookie 和 Content-Encoding
            for (const [key, value] of finalResponse.headers.entries()) {
                const lowerKey = key.toLowerCase();
                if (lowerKey !== 'set-cookie' && lowerKey !== 'content-encoding') {
                    responseHeaders.set(key, value);
                }
            }

            // 暴露收集到的 Set-Cookie（通过 X-Set-Cookie）
            for (const cookie of allSetCookies) {
                responseHeaders.append('X-Set-Cookie', cookie);
            }

            // 合并 CORS 头
            for (const [k, v] of Object.entries(corsHeaders)) {
                responseHeaders.set(k, v);
            }

            // 添加调试信息（可选）
            if (redirectCount > 0) {
                responseHeaders.set('X-Redirect-Count', redirectCount.toString());
                responseHeaders.set('X-Final-URL', currentUrl);
            }

            // 返回最终响应
            return new Response(finalResponse.body, {
                status: finalResponse.status,
                statusText: finalResponse.statusText,
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