exports.version = 1.5
exports.description = "Prevent disk sleep by periodically sending get_file_list requests to selected frontend directories. Keeps HDD spinning and file listings cached during working hours for faster frontend response."
exports.apiRequired = 10
exports.repo = "hugo529100/hfs-Prevent-disk-sleep"

exports.config = {
    // ============================================
    // === 設定分類選擇器 ===
    // ============================================
    config_tab: {
        type: 'select',
        defaultValue: 'general',
        options: {
            '1. General': 'general',
            '2. Targets': 'targets'
        },
        label: "Configuration Category",
        helperText: "Select a category to view and edit settings.",
        frontend: true
    },

    // ============================================
    // === 1. 一般設定 ===
    // ============================================
    enablePreventDiskSleep: {
        showIf: x => x.config_tab === 'general',
        type: 'boolean',
        defaultValue: false,
        label: 'Enable Prevent Disk Sleep (Master Switch)',
        helperText: 'Master switch to enable/disable disk sleep prevention. When enabled, the plugin will periodically request file lists from configured directories to keep the HDD spinning and file listings cached in memory.',
        xs: 12
    },
    debug: {
        showIf: x => x.config_tab === 'general',
        type: 'boolean',
        defaultValue: false,
        label: 'Debug Mode',
        helperText: 'When enabled, all keep-alive activity (requests, successes, failures, errors) will be written to the server console/log. When disabled, the plugin runs silently.',
        xs: 12
    },

    // ============================================
    // === 2. 目標列表 ===
    // ============================================
    preventDiskSleepTargets: {
        showIf: x => x.config_tab === 'targets',
        type: 'array',
        label: 'Prevent-Disk-Sleep Targets',
        helperText: 'Add directories to keep awake. Each target can have multiple time windows. Targets are always processed one at a time; a fixed 10-second gap is enforced after each file list is fully received, to avoid power spikes on USB / 12V supplies.',
        defaultValue: [],
        fields: {
            enabled: {
                type: 'boolean',
                label: 'Enable this target',
                defaultValue: true,
                xs: 12
            },
            name: {
                type: 'string',
                label: 'Target Name',
                helperText: 'A unique name for this target',
                required: true,
                xs: 12
            },
            vfsPath: {
                type: 'vfs_path',
                label: 'Frontend Directory',
                helperText: 'Select the frontend directory to keep awake',
                folders: true,
                files: false,
                required: true,
                frontend: true,
                xs: 12
            },
            intervalMinutes: {
                type: 'number',
                label: 'Interval (minutes)',
                defaultValue: 3,
                helperText: 'Time between each get_file_list request (1-60 minutes). HDDs typically sleep after 5-10 minutes of inactivity, so 3-5 minutes is a safe default.',
                min: 1,
                max: 60,
                xs: 6
            },
            scheduleWindows: {
                type: 'array',
                label: 'Schedule Windows',
                helperText: 'Define time windows when disk-sleep-prevention should be active. Outside these windows, no requests will be sent. Leave empty to run 24/7.',
                defaultValue: [
                    {
                        enabled: true,
                        startTime: '08:00',
                        endTime: '18:00',
                        mon: true,
                        tue: true,
                        wed: true,
                        thu: true,
                        fri: true,
                        sat: false,
                        sun: false
                    }
                ],
                fields: {
                    enabled: {
                        type: 'boolean',
                        label: 'Enable this window',
                        defaultValue: true,
                        xs: 12
                    },
                    startTime: {
                        type: 'string',
                        label: 'Start Time (HH:MM)',
                        defaultValue: '08:00',
                        helperText: 'Start time in 24-hour format, e.g., 08:00',
                        xs: 6
                    },
                    endTime: {
                        type: 'string',
                        label: 'End Time (HH:MM)',
                        defaultValue: '18:00',
                        helperText: 'End time in 24-hour format, e.g., 18:00. Can span past midnight if end < start.',
                        xs: 6
                    },
                    // === 星期勾選 ===
                    mon: {
                        type: 'boolean',
                        label: 'Monday',
                        defaultValue: true,
                        xs: 3
                    },
                    tue: {
                        type: 'boolean',
                        label: 'Tuesday',
                        defaultValue: true,
                        xs: 3
                    },
                    wed: {
                        type: 'boolean',
                        label: 'Wednesday',
                        defaultValue: true,
                        xs: 3
                    },
                    thu: {
                        type: 'boolean',
                        label: 'Thursday',
                        defaultValue: true,
                        xs: 3
                    },
                    fri: {
                        type: 'boolean',
                        label: 'Friday',
                        defaultValue: true,
                        xs: 3
                    },
                    sat: {
                        type: 'boolean',
                        label: 'Saturday',
                        defaultValue: false,
                        xs: 3
                    },
                    sun: {
                        type: 'boolean',
                        label: 'Sunday',
                        defaultValue: false,
                        xs: 3
                    }
                }
            }
        }
    }
},

exports.init = api => {
    if (typeof console.log.original !== 'function') {
        console.log.original = console.log
    }
    const { exec } = require('child_process')
    const { promisify } = require('util')
    const execAsync = promisify(exec)

    // ============================================================
    // === 常數 ===
    // ============================================================
    // 在上一個 file list 完整接收後才開始計算的固定間隔，
    // 用以避免 USB / 12V 電源因連續磁盤 I/O 而產生瞬時壓降。
    const TARGET_SPACING_MS = 10 * 1000

    // getDay() 對應的星期欄位名稱：0=Sun, 1=Mon, ... 6=Sat
    const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

    // ============================================================
    // === 內部狀態 ===
    // ============================================================
    let masterInterval = null
    let isRunning = false
    const lastRequestTime = {}

    // ============================================================
    // === 日誌輔助函式（全部受 debug 開關保護） ===
    // ============================================================
    const logDebug = (msg) => {
        if (api.getConfig('debug')) api.log(msg)
    }
    const logError = (msg) => {
        if (api.getConfig('debug')) api.log(`[error] ${msg}`)
    }

    // ============================================================
    // === 輔助函式 ===
    // ============================================================
    const parseTimeToMinutes = (timeStr) => {
        if (!timeStr || typeof timeStr !== 'string') return null
        const parts = timeStr.split(':').map(Number)
        if (parts.length !== 2 || parts.some(isNaN)) return null
        const [h, m] = parts
        if (h < 0 || h > 23 || m < 0 || m > 59) return null
        return h * 60 + m
    }

    // 判斷某個 window 在「指定日期」是否啟用（星期勾選）
    // 若完全沒有設定任何星期欄位（舊資料 / 空物件），視為每天啟用。
    const isWindowDayEnabled = (win, date) => {
        const hasAnyDayField = DAY_KEYS.some(k => typeof win[k] === 'boolean')
        if (!hasAnyDayField) return true
        const key = DAY_KEYS[date.getDay()]
        return win[key] !== false
    }

    // 回傳 { inWindow, nextWindowStart }
    const evaluateSchedule = (windows, now = new Date()) => {
        if (!Array.isArray(windows) || windows.length === 0) {
            return { inWindow: true, nextWindowStart: null }
        }

        const currentMinutes = now.getHours() * 60 + now.getMinutes()
        let inWindow = false
        let nextStartCandidate = null

        for (const win of windows) {
            if (!win || win.enabled === false) continue
            const start = parseTimeToMinutes(win.startTime)
            const end = parseTimeToMinutes(win.endTime)
            if (start === null || end === null) continue

            const todayEnabled = isWindowDayEnabled(win, now)

            if (end > start) {
                if (todayEnabled && currentMinutes >= start && currentMinutes < end) {
                    inWindow = true
                    break
                }
            } else if (end < start) {
                // 跨午夜時段：需同時考慮「今天」與「昨天」的星期啟用狀態
                // 例：22:00-06:00，週五啟用 → 週五 22:00~24:00 與週六 00:00~06:00 都算
                const yesterday = new Date(now)
                yesterday.setDate(yesterday.getDate() - 1)
                const yesterdayEnabled = isWindowDayEnabled(win, yesterday)

                const inEveningPart = currentMinutes >= start && todayEnabled
                const inMorningPart = currentMinutes < end && yesterdayEnabled
                if (inEveningPart || inMorningPart) {
                    inWindow = true
                    break
                }
            } else {
                // start === end，視為全天；仍需符合星期
                if (todayEnabled) {
                    inWindow = true
                    break
                }
            }
        }

        if (!inWindow) {
            // 找出下一個符合「星期 + 時間」的窗口起始時間，最多往後找 8 天
            outer:
            for (let offset = 0; offset <= 8; offset++) {
                const probe = new Date(now)
                probe.setDate(probe.getDate() + offset)
                probe.setHours(0, 0, 0, 0)

                for (const win of windows) {
                    if (!win || win.enabled === false) continue
                    const start = parseTimeToMinutes(win.startTime)
                    if (start === null) continue
                    if (!isWindowDayEnabled(win, probe)) continue

                    const candidate = new Date(probe)
                    candidate.setMinutes(start)
                    if (candidate.getTime() <= now.getTime()) continue
                    if (nextStartCandidate === null || candidate.getTime() < nextStartCandidate) {
                        nextStartCandidate = candidate.getTime()
                    }
                    if (offset === 0) break outer
                }
            }
        }

        return { inWindow, nextWindowStart: nextStartCandidate }
    }

    // ============================================================
    // === HFS API 呼叫（本機 loopback，無需重試） ===
    // ============================================================
    // 只有在「完整回應本文」接收並解析完畢後才會 resolve。
    const requestFileList = async (vfsPath) => {
        const encodedPath = encodeURIComponent(vfsPath)
        const url = `http://127.0.0.1:${api.port || 80}/~/api/get_file_list?uri=${encodedPath}`
        const { stdout } = await execAsync(
            `curl -s --connect-timeout 10 --max-time 60 "${url}"`,
            { maxBuffer: 10 * 1024 * 1024, windowsHide: true, timeout: 65000 }
        )
        if (!stdout || !stdout.trim()) throw new Error('Empty response')
        const json = JSON.parse(stdout)
        return { success: true, count: Array.isArray(json.list) ? json.list.length : 0 }
    }

    // ============================================================
    // === 單一目標處理 ===
    // ============================================================
    // 回傳 true 表示請求已送出且完整接收，false 表示未發送。
    const processTarget = async (target) => {
        if (!target || target.enabled === false) return false
        if (!target.vfsPath) return false

        const now = new Date()
        const schedule = evaluateSchedule(target.scheduleWindows, now)

        if (!schedule.inWindow) {
            logDebug(`[disk-sleep] [${target.name}] Outside schedule window, skipping`)
            return false
        }

        const intervalMin = Math.max(1, Math.min(60, target.intervalMinutes || 3))
        const intervalMs = intervalMin * 60 * 1000
        const lastTime = lastRequestTime[target.name] || 0
        const elapsed = Date.now() - lastTime
        if (elapsed < intervalMs) {
            logDebug(`[disk-sleep] [${target.name}] Not due yet (${Math.floor(elapsed / 1000)}s / ${intervalMin}min)`)
            return false
        }

        try {
            logDebug(`[disk-sleep] [${target.name}] Requesting file list: ${target.vfsPath}`)
            const result = await requestFileList(target.vfsPath)
            // 下一個目標的 10 秒間隔，從「這一刻」（即完整回應已收到）開始計算。
            lastRequestTime[target.name] = Date.now()
            logDebug(`[disk-sleep] [${target.name}] OK — ${result.count} items`)
            return true
        } catch (err) {
            logError(`[disk-sleep] [${target.name}] Failed: ${err.message}`)
            lastRequestTime[target.name] = Date.now()
            return true
        }
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

    // ============================================================
    // === Tick 迴圈 ===
    // ============================================================
    const tick = async () => {
        if (isRunning) return
        if (!api.getConfig('enablePreventDiskSleep')) return
        isRunning = true
        try {
            const targets = api.getConfig('preventDiskSleepTargets') || []
            let lastCompletedAt = 0   // 上一個目標 file list 完整接收完成的時間
            let fired = false

            for (const target of targets) {
                if (!api.getConfig('enablePreventDiskSleep')) break

                // 僅在前一個目標確實發送過請求時才強制間隔。
                // 間隔由上一個目標「完整接收完成」的時刻開始計算。
                if (fired && lastCompletedAt > 0) {
                    const waitMs = TARGET_SPACING_MS - (Date.now() - lastCompletedAt)
                    if (waitMs > 0) {
                        logDebug(`[disk-sleep] Waiting ${waitMs}ms before next target`)
                        await sleep(waitMs)
                        if (!api.getConfig('enablePreventDiskSleep')) break
                    }
                }

                try {
                    const didSend = await processTarget(target)
                    if (didSend) {
                        fired = true
                        lastCompletedAt = Date.now()
                    }
                } catch (e) {
                    logError(`[disk-sleep] Target ${target?.name} error: ${e.message}`)
                }
            }
        } catch (err) {
            logError(`[disk-sleep] Tick failed: ${err.message}`)
        } finally {
            isRunning = false
        }
    }

    // ============================================================
    // === 計時器管理 ===
    // ============================================================
    const startMasterTicker = () => {
        stopMasterTicker()
        // 30 秒一次 tick — 成本低，且對分鐘級間隔已足夠精確。
        logDebug(`[disk-sleep] Master ticker started (30000ms)`)
        masterInterval = api.setInterval(() => { tick().catch(() => {}) }, 30000)
        setTimeout(() => { tick().catch(() => {}) }, 2000)
    }

    const stopMasterTicker = () => {
        if (masterInterval) {
            clearInterval(masterInterval)
            masterInterval = null
            logDebug(`[disk-sleep] Master ticker stopped`)
        }
    }

    const restart = () => {
        if (!api.getConfig('enablePreventDiskSleep')) {
            stopMasterTicker()
            return
        }
        startMasterTicker()
    }

    // ============================================================
    // === 初始化 ===
    // ============================================================
    if (api.getConfig('enablePreventDiskSleep')) {
        startMasterTicker()
    }

    return {
        unload() {
            stopMasterTicker()
        },

        customRest: {
            async getStatus() {
                const targets = api.getConfig('preventDiskSleepTargets') || []
                const now = new Date()
                return {
                    version: exports.version,
                    enabled: api.getConfig('enablePreventDiskSleep') || false,
                    debug: api.getConfig('debug') || false,
                    isRunning,
                    targetSpacingMs: TARGET_SPACING_MS,
                    targets: targets.map(t => {
                        const sched = evaluateSchedule(t.scheduleWindows, now)
                        const lastTime = lastRequestTime[t.name] || 0
                        return {
                            name: t.name,
                            enabled: t.enabled !== false,
                            vfsPath: t.vfsPath,
                            intervalMinutes: t.intervalMinutes || 3,
                            inWindow: sched.inWindow,
                            nextWindowStart: sched.nextWindowStart
                                ? new Date(sched.nextWindowStart).toISOString()
                                : null,
                            lastRequestAt: lastTime > 0
                                ? new Date(lastTime).toISOString()
                                : null,
                            secondsSinceLastRequest: lastTime > 0
                                ? Math.floor((Date.now() - lastTime) / 1000)
                                : null
                        }
                    })
                }
            },

            async manualTick({ targetName } = {}) {
                if (!api.getConfig('enablePreventDiskSleep')) {
                    return { error: 'Prevent Disk Sleep is disabled' }
                }
                const targets = api.getConfig('preventDiskSleepTargets') || []
                if (targetName) {
                    const target = targets.find(t => t.name === targetName)
                    if (!target) return { error: `Target not found: ${targetName}` }
                    try {
                        const result = await requestFileList(target.vfsPath)
                        lastRequestTime[target.name] = Date.now()
                        logDebug(`[disk-sleep] [${target.name}] Manual tick OK — ${result.count} items`)
                        return { success: true, target: target.name, count: result.count }
                    } catch (err) {
                        logError(`[disk-sleep] [${target.name}] Manual tick failed: ${err.message}`)
                        return { success: false, target: target.name, error: err.message }
                    }
                }
                await tick()
                return { success: true, message: 'Manual tick completed' }
            },

            async testTarget({ targetName }) {
                const targets = api.getConfig('preventDiskSleepTargets') || []
                const target = targets.find(t => t.name === targetName)
                if (!target) return { error: `Target not found: ${targetName}` }
                if (!target.vfsPath) return { error: 'No vfsPath configured' }
                try {
                    const result = await requestFileList(target.vfsPath)
                    logDebug(`[disk-sleep] [${target.name}] Test OK — ${result.count} items`)
                    return { success: true, target: target.name, items: result.count }
                } catch (err) {
                    logError(`[disk-sleep] [${target.name}] Test failed: ${err.message}`)
                    return { success: false, target: target.name, error: err.message }
                }
            },

            async restart() {
                restart()
                logDebug(`[disk-sleep] REST restart requested`)
                return { message: 'Ticker restarted', enabled: api.getConfig('enablePreventDiskSleep') || false }
            }
        }
    }
}