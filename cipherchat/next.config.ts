import type { NextConfig } from "next";

// 安全响应头：全站统一注入（headers() 比 middleware 更可靠，静态与动态路由均覆盖）
const securityHeaders = [
  // CSP：允许内联（Next.js 水合需要）+ data/blob 图片 + WebSocket（relay 信令）+ blob 媒体（屏幕共享/语音回放）
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss:; media-src 'self' blob:;",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // HSTS：两年，含子域，可申请 preload
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    // v1.6.0：类型错误不再放行，构建前必须通过 tsc --noEmit
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
