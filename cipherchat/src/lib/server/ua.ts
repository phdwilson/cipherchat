// 极简 User-Agent 解析器（无第三方依赖，供 web 与 ws 服务共用）
export interface ParsedUA {
  deviceType: 'phone' | 'tablet' | 'desktop' | 'bot' | 'unknown'
  model: string // 设备型号（能识别出的部分）
  os: string // 操作系统 + 版本
  browser: string // 浏览器 + 版本
  label: string // 拼好的展示名
}

function match(re: RegExp, s: string): string | null {
  const m = s.match(re)
  return m ? m[1] : null
}

export function parseUA(uaRaw: string | undefined | null): ParsedUA {
  const ua = uaRaw || ''
  const unknown: ParsedUA = {
    deviceType: 'unknown',
    model: '未知设备',
    os: '未知系统',
    browser: '未知浏览器',
    label: '未知设备',
  }
  if (!ua) return unknown

  const isBot = /bot|crawler|spider|crawling|curl|wget|python-requests|http-client/i.test(ua)

  // ---- 操作系统 ----
  let os = '未知系统'
  let deviceType: ParsedUA['deviceType'] = 'desktop'
  let model = ''

  if (/iPhone/i.test(ua)) {
    deviceType = 'phone'
    model = 'iPhone'
    const v = match(/iPhone OS (\d+[_.]\d+(?:[_.]\d+)?)/, ua)
    os = v ? `iOS ${v.replace(/_/g, '.')}` : 'iOS'
  } else if (/iPad/i.test(ua)) {
    deviceType = 'tablet'
    model = 'iPad'
    const v = match(/iPad.*?OS (\d+[_.]\d+(?:[_.]\d+)?)/, ua) || match(/CPU OS (\d+[_.]\d+)/, ua)
    os = v ? `iPadOS ${v.replace(/_/g, '.')}` : 'iPadOS'
  } else if (/iPod/i.test(ua)) {
    deviceType = 'phone'
    model = 'iPod touch'
    os = 'iOS'
  } else if (/Android/i.test(ua)) {
    deviceType = /Mobile/i.test(ua) || !/Tablet|Pad/i.test(ua) ? 'phone' : 'tablet'
    const v = match(/Android ([\d.]+)/, ua)
    os = v ? `Android ${v}` : 'Android'
    // 尝试提取品牌型号，如 "Xiaomi M2012K11AC" / "HUAWEI P40"
    const b =
      match(/;\s([^;)]*?(?:Xiaomi|Redmi|HUAWEI|HONOR|OPPO|vivo|OnePlus|realme|meizu|samsung|Pixel)[^;)]*?)\s+(Build|;\s*[\w-]+\))/i, ua) ||
      match(/;\s((?:Xiaomi|Redmi|HUAWEI|HONOR|OPPO|vivo|OnePlus|realme|SAMSUNG|Pixel)[^;/)]*)\s+(Build|\))/i, ua) ||
      match(/Android[^;]*;\s([^;]+?)(?:\s+Build|\))/, ua)
    if (b) {
      const cleaned = b[0].replace(/\s+/g, ' ').trim()
      model = cleaned.length > 40 ? cleaned.slice(0, 40) + '…' : cleaned
    } else {
      model = deviceType === 'tablet' ? 'Android 平板' : 'Android 手机'
    }
  } else if (/Windows NT/.test(ua)) {
    const v = match(/Windows NT ([\d.]+)/, ua)
    const verMap: Record<string, string> = {
      '10.0': 'Windows 10 / 11',
      '6.3': 'Windows 8.1',
      '6.2': 'Windows 8',
      '6.1': 'Windows 7',
    }
    os = verMap[v || ''] || 'Windows'
    model = 'Windows 设备'
  } else if (/Mac OS X|Macintosh/.test(ua)) {
    const v = match(/Mac OS X (\d+[_.]\d+(?:[_.]\d+)?)/, ua)
    os = v ? `macOS ${v.replace(/_/g, '.')}` : 'macOS'
    model = 'Mac'
  } else if (/CrOS/.test(ua)) {
    os = 'ChromeOS'
    model = 'Chromebook'
  } else if (/Linux/.test(ua)) {
    os = 'Linux'
    model = 'Linux 设备'
  }

  // ---- 浏览器 ----
  let browser = '未知浏览器'
  if (/MicroMessenger/i.test(ua)) browser = '微信内置浏览器'
  else if (/QQ\//.test(ua)) browser = 'QQ 内置浏览器'
  else if (/AlipayClient/.test(ua)) browser = '支付宝浏览器'
  else if (/Edge?\//.test(ua) && /Edg\//.test(ua)) {
    const v = match(/Edg\/([\d.]+)/, ua)
    browser = `Microsoft Edge ${v ? v.split('.')[0] : ''}`.trim()
  } else if (/Firefox\//.test(ua)) {
    const v = match(/Firefox\/([\d.]+)/, ua)
    browser = `Firefox ${v ? v.split('.')[0] : ''}`.trim()
  } else if (/OPR\//.test(ua)) {
    const v = match(/OPR\/([\d.]+)/, ua)
    browser = `Opera ${v ? v.split('.')[0] : ''}`.trim()
  } else if (/Chrome\//.test(ua)) {
    const v = match(/Chrome\/([\d.]+)/, ua)
    browser = `Chrome ${v ? v.split('.')[0] : ''}`.trim()
  } else if (/Safari\//.test(ua) && /Version\//.test(ua)) {
    const v = match(/Version\/([\d.]+)/, ua)
    browser = `Safari ${v ? v.split('.')[0] : ''}`.trim()
  } else if (/MSIE|Trident/.test(ua)) browser = 'IE 浏览器'

  if (isBot) deviceType = 'bot'

  const label = `${model} · ${os}`.replace(/^ · |· $/g, '')
  return { deviceType, model, os, browser, label: label || '未知设备' }
}
