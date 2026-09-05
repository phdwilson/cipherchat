'use client'
// v1.8.0 统一错误翻译器：把 网络/HTTP/浏览器权限/加密 各类失败
// 翻译成「出了什么事 + 为什么 + 怎么修」三段式提示，消灭静默失败。
// 设计原则：
//  1. 任何用户可感知的操作失败，都必须带原因与可执行的修复步骤
//  2. 服务端 jsonError 返回的中文 error 优先直接展示（服务端最了解上下文）
//  3. 网络层/浏览器层的英文异常在此翻译，覆盖本项目全部已知错误形态

export interface ErrorExplanation {
  /** 一句话标题（toast 主文案） */
  title: string
  /** 原因说明（toast 描述第一段） */
  reason: string
  /** 修复建议（toast 描述第二段，可执行步骤） */
  fix: string
  /** 原始错误信息（用于日志/诊断，不打扰用户） */
  raw?: string
}

/** 常见 HTTP 状态码 → 语义（与服务端 jsonError 的中文文案配套） */
const HTTP_MEANING: Record<number, { reason: string; fix: string }> = {
  400: { reason: '请求格式不正确，可能是客户端版本与服务端不一致', fix: '刷新页面（Ctrl+F5）强制更新客户端后重试' },
  401: { reason: '会话已过期或失效（默认 7 天有效期）', fix: '重新解锁网盘 / 重新加入频道即可自动建立新会话' },
  403: { reason: '服务器拒绝了本次操作（权限或密钥验证未通过）', fix: '检查密钥/密码是否输入正确；管理员请确认超级密钥' },
  404: { reason: '目标资源不存在，可能已被删除或从未上传成功', fix: '刷新列表确认资源是否还在；上传未完成的文件请重新上传' },
  409: { reason: '数据状态冲突（如文件分片不完整、网盘 ID 被占用）', fix: '按提示重试操作；反复出现请联系管理员运行「一键自检」' },
  413: { reason: '超出大小限制（单文件或网盘配额）', fix: '清理网盘空间，或联系管理员调整 DRIVE_QUOTA_BYTES / MAX_DRIVE_FILE_BYTES' },
  429: { reason: '操作过于频繁，触发了服务器限流保护', fix: '等待 1 分钟后重试；不要同时开多个页面上传' },
  500: { reason: '服务器内部错误（磁盘写入失败、数据库锁定等都可能）', fix: '稍后重试；若持续失败，请管理员在后台执行「一键自检」定位' },
  502: { reason: '网关/反向代理返回错误，后端服务可能未运行', fix: '确认 3000 端口服务已启动；管理员可运行后台「一键自检」' },
  503: { reason: '服务暂不可用（可能正在重启）', fix: '等待几秒后刷新页面重试' },
}

/** 浏览器权限/媒体类异常 → 语义 */
const MEDIA_MEANING: Record<string, { reason: string; fix: string }> = {
  NotAllowedError: {
    reason: '浏览器拒绝了麦克风权限（未授权或被系统策略禁用）',
    fix: '点击地址栏左侧的锁/调音器图标 → 麦克风 → 允许，然后重新录音；手机浏览器请在系统设置中授权',
  },
  PermissionDeniedError: {
    reason: '操作系统层面拒绝了麦克风访问',
    fix: '在系统隐私设置中允许浏览器使用麦克风（Windows：设置 → 隐私 → 麦克风；macOS：系统设置 → 隐私与安全性 → 麦克风）',
  },
  NotFoundError: {
    reason: '未检测到可用的麦克风设备',
    fix: '检查麦克风是否已连接并设为默认设备；插好后刷新页面重试',
  },
  DevicesNotFoundError: { reason: '未检测到可用的麦克风设备', fix: '检查麦克风连接后刷新页面重试' },
  NotReadableError: {
    reason: '麦克风被其他应用占用（如会议软件独占）',
    fix: '关闭正在使用麦克风的其他程序（腾讯会议/Zoom/游戏语音等）后重试',
  },
  TrackStartError: { reason: '麦克风启动失败（设备忙或驱动异常）', fix: '重启浏览器；仍失败请重启电脑后重试' },
  AbortError: { reason: '操作被取消', fix: '无需处理；如非主动取消请重试' },
}

/** 核心：解释任意异常（客户端侧统一入口） */
export function explainError(e: unknown, context?: string): ErrorExplanation {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e)

  // 1) 本项目抛出的带语义错误（服务端 jsonError 的中文文案/自定义 Error）→ 直接透传并补建议
  if (e instanceof Error) {
    // fetch 网络层失败（服务器不可达 / 断网 / DNS）
    if (e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message)) {
      return {
        title: (context ? `${context}：` : '') + '无法连接服务器',
        reason: '请求未能送达服务器（网络中断、服务器未启动、或反向代理未就绪）',
        fix: '① 检查本机网络 ② 确认服务器 3000 端口进程存活 ③ 管理员可在后台「一键自检」中查看服务状态',
        raw,
      }
    }
    // 浏览器媒体权限类
    const media = MEDIA_MEANING[e.name]
    if (media) {
      return { title: (context ? `${context}：` : '') + '麦克风不可用', reason: media.reason, fix: media.fix, raw }
    }
    // 超时
    if (/timeout|timed out/i.test(e.message)) {
      return {
        title: (context ? `${context}：` : '') + '请求超时',
        reason: '服务器响应时间过长（上传大文件属正常；其余情况多为服务卡顿）',
        fix: '大文件请耐心等待进度条完成；其他操作请稍后重试，反复超时请联系管理员自检',
        raw,
      }
    }
    // 其余带 message 的错误（含服务端中文 error）→ 透传 message，附通用建议
    return {
      title: (context ? `${context}：` : '') + (e.message || '操作失败'),
      reason: e.message || '发生了未预期的错误',
      fix: '请按提示处理后重试；若无法解决，请联系管理员在后台运行「一键自检」',
      raw,
    }
  }

  // 2) Response 对象（调用方直接传 res 而非异常时使用）
  if (typeof e === 'object' && e !== null && 'status' in e && 'ok' in (e as object)) {
    const status = Number((e as { status: number }).status)
    const m = HTTP_MEANING[status] || { reason: `服务器返回状态码 ${status}`, fix: '请稍后重试或联系管理员' }
    return { title: (context ? `${context}：` : '') + '请求失败', reason: m.reason, fix: m.fix, raw: `HTTP ${status}` }
  }

  return {
    title: (context ? `${context}：` : '') + '操作失败',
    reason: raw || '发生了未预期的错误',
    fix: '请重试；若持续失败，请联系管理员在后台运行「一键自检」',
    raw,
  }
}

/** 按状态码解释（fetch 到非 2xx 响应时使用） */
export function explainStatus(status: number, serverMsg: string, context?: string): ErrorExplanation {
  const m = HTTP_MEANING[status]
  return {
    title: (context ? `${context}：` : '') + (serverMsg || '请求失败'),
    reason: m?.reason || `服务器返回状态码 ${status}`,
    fix: m?.fix || '请按提示处理后重试；若无法解决，请管理员运行「一键自检」',
    raw: `HTTP ${status}${serverMsg ? `: ${serverMsg}` : ''}`,
  }
}

/** 输出 sonner toast 的描述文本（原因 + 修复方式两段式） */
export function errorToastDescription(ex: ErrorExplanation): string {
  return `原因：${ex.reason}\n处理：${ex.fix}`
}
