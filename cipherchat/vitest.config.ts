// vitest 配置：v1.8.1 新增
// 背景：build 产物 .next/standalone 里带着 src 源码副本（Next standalone 输出包含编译源），
// 此前 vitest 无配置文件会把它一并当测试文件跑 —— 陈旧副本的测试结果会污染真实结果。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
  },
})
