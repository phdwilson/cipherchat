import { io } from 'socket.io-client'
// 直连 relay（生产部署时由 Next 代理 XTransformPort；本地测试直连 3003）
const sock = io('http://127.0.0.1:3003', { transports: ['websocket'], timeout: 8000, path: '/' })
const t = setTimeout(() => { console.log('TIMEOUT waiting connect'); process.exit(1) }, 10000)
sock.on('connect', () => { console.log('CONNECTED', sock.id); clearTimeout(t); sock.disconnect(); process.exit(0) })
sock.on('connect_error', (e) => { console.log('ERR', e.message); process.exit(1) })
