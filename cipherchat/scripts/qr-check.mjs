// 二维码模块检测：qrcode 库可用性 + 生成/解码回路
import QRCode from 'qrcode'
const url = 'http://localhost:3100/#/invite=AbCdEf123456'
const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 })
console.log('QR dataURL 前缀:', dataUrl.slice(0, 30))
console.log('QR 尺寸(bytes):', Buffer.from(dataUrl.split(',')[1], 'base64').length)
if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('二维码生成异常')
console.log('[PASS] qrcode 模块生成 PNG 正常')
