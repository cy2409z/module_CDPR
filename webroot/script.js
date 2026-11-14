/* ============================================================
   晨夕敛光 · WebUI 界面脚本
   - 通过 KernelSU execShell 读取 sysfs / 模块文件，写入配置与包名列表
   - 无 KSU 时主页显示异常状态，不回退 mock 数据
   - 包含主题、页面切换、刷新动效、仪表盘动画、自动刷新、设置交互
   ============================================================ */

(() => {
    "use strict";

    /* ==================== 常量与工具 ==================== */
    const THEME_KEY = "chenxi.theme";
    const SETTINGS_KEY = "chenxi.settings.v1";
    const PACKAGES_KEY = "chenxi.packages.v1";
    const RING_CIRCUMFERENCE = 2 * Math.PI * 52;
    const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
    const DARK_QUERY = window.matchMedia("(prefers-color-scheme: dark)");

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    const safeStorage = {
        get(key) {
            try {
                return window.localStorage.getItem(key);
            } catch (error) {
                return null;
            }
        },
        set(key, value) {
            try {
                window.localStorage.setItem(key, value);
            } catch (error) {
                /* 本地存储不可用时静默降级 */
            }
        }
    };

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    /* ==================== 后端接口 ====================
       通过 KernelSU 注入的 kernelsu.exec / ksu.exec 执行 shell。
       兼容两种 API：新版 Promise 式与旧版回调式。
       ==================================================== */
    const MODULE_DIR = "/data/adb/modules/module_CDPR";
    const STATE_FILE = MODULE_DIR + "/current_state";
    const GAMES_FILE = MODULE_DIR + "/res/packages.txt";
    const CONFIG_FILE = MODULE_DIR + "/res/config.conf";
    const PID_FILE = MODULE_DIR + "/res/module.pid";
    const CONFIG_HELPER = MODULE_DIR + "/scripts/config_helper.sh";

    const SYSFS = {
        midMax: "/sys/devices/system/cpu/cpufreq/policy0/scaling_max_freq",
        midCur: "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq",
        bigMax: "/sys/devices/system/cpu/cpufreq/policy6/scaling_max_freq",
        bigCur: "/sys/devices/system/cpu/cpufreq/policy6/scaling_cur_freq",
        gpuMax: "/sys/class/kgsl/kgsl-3d0/max_gpuclk",
        gpuCur: "/sys/class/kgsl/kgsl-3d0/gpuclk"
    };

    function hasRoot() {
        return (
            (typeof kernelsu !== "undefined" && typeof kernelsu.exec === "function") ||
            (typeof ksu !== "undefined" && typeof ksu.exec === "function")
        );
    }

    // 仅用于排查：区分宿主是 SukiSU 的 ksuEngine 还是 WebUI X。
    function detectEngine() {
        try {
            if (typeof ksu !== "undefined" && typeof ksu.mmrl === "function" && ksu.mmrl()) {
                return "WebUI X";
            }
        } catch (error) {
            /* 探测失败按原生引擎处理 */
        }
        if (typeof kernelsu !== "undefined") {
            return "kernelsu";
        }
        if (typeof ksu !== "undefined") {
            return "ksuEngine";
        }
        return "无 root 接口";
    }

    let callbackSeq = 0;

    // timeoutMs <= 0 表示不设超时（写入类不可重放操作不套超时）。
    // 宿主可能完全不回调：SukiSU 新版把 exec 改成协程，页面未就绪或协程被取消时静默丢弃命令，
    // 因此读操作必须能超时返回，否则调用方的 refreshing 锁永远不会释放。
    function execShell(cmd, timeoutMs = 0) {
        return new Promise((resolve) => {
            let settled = false;
            let timer = 0;
            let cbName = "";

            const finish = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    window.clearTimeout(timer);
                }
                if (cbName) {
                    delete window[cbName];
                    cbName = "";
                }
                resolve(result);
            };

            if (timeoutMs > 0) {
                timer = window.setTimeout(
                    () => finish({ code: 1, out: "", err: "timeout" }),
                    timeoutMs
                );
            }

            try {
                if (typeof kernelsu !== "undefined" && typeof kernelsu.exec === "function") {
                    kernelsu
                        .exec(cmd)
                        .then((r) =>
                            finish({
                                code: r?.errno || 0,
                                out: r?.stdout || "",
                                err: r?.stderr || ""
                            })
                        )
                        .catch((error) =>
                            finish({ code: 1, out: "", err: error?.message || "exec_failed" })
                        );
                    return;
                }
                if (typeof ksu !== "undefined" && typeof ksu.exec === "function") {
                    callbackSeq += 1;
                    cbName = "_cb_" + Date.now() + "_" + callbackSeq;
                    window[cbName] = (errno, stdout, stderr) =>
                        finish({ code: errno || 0, out: stdout || "", err: stderr || "" });
                    ksu.exec(cmd, "{}", cbName);
                    return;
                }
                finish({ code: 1, out: "", err: "No root interface" });
            } catch (error) {
                finish({ code: 1, out: "", err: error.message });
            }
        });
    }

    // 一次 exec 读多个文件：SukiSU 的 exec 是并发协程，首屏一次发 9 个请求容易撞上回调丢失，
    // 合并成一条命令后只剩 1 次桥接。分段标记带随机后缀，避免文件内容恰好以标记开头导致错位；
    // 每段前先 echo 一个空行，防止上一个文件末尾无换行时把标记粘到内容后面。
    async function readFiles(paths, timeoutMs = 0) {
        const marker = "__cx" + Math.random().toString(36).slice(2, 10) + "__";
        const cmd = paths
            .map((path) => `echo ''; echo '${marker}${path}'; cat '${path}' 2>/dev/null`)
            .join("; ");
        const result = await execShell(cmd, timeoutMs);

        const sections = {};
        let current = null;
        (result.out || "").split("\n").forEach((line) => {
            if (line.startsWith(marker)) {
                current = line.slice(marker.length).trim();
                sections[current] = [];
                return;
            }
            if (current !== null) {
                sections[current].push(line);
            }
        });

        const files = {};
        paths.forEach((path) => {
            files[path] = (sections[path] || []).join("\n").trim();
        });

        return { files, code: result.code, err: result.err };
    }

    function toCpuMhz(khzValue) {
        const n = Number.parseInt(khzValue, 10);
        if (!Number.isFinite(n)) {
            return null;
        }
        return Math.round(n / 1000); // kHz -> MHz
    }

    function toGpuMhz(hzValue) {
        const n = Number.parseInt(hzValue, 10);
        if (!Number.isFinite(n)) {
            return null;
        }
        return Math.round(n / 1000000); // Hz -> MHz
    }

    function calcPercent(cur, max) {
        if (cur === null || max === null || max <= 0) {
            return 0;
        }
        return clamp(Math.round((cur / max) * 100), 0, 100);
    }

    function buildFreq(curMhz, maxMhz, unit) {
        return {
            percent: calcPercent(curMhz, maxMhz),
            cur: curMhz,
            max: maxMhz,
            unit
        };
    }

    function errorSnapshot() {
        // 无 root 或读取失败的统一降级快照。
        return {
            service: { running: false, pid: "—" },
            games: { count: 0 },
            mode: { ...MODE_PRESETS.error },
            cpu: {
                mid: { percent: 0, cur: null, max: null, unit: "GHz" },
                big: { percent: 0, cur: null, max: null, unit: "GHz" }
            },
            gpu: { percent: 0, cur: null, max: null, unit: "MHz" }
        };
    }

    function parseConfig(content) {
        const config = {};
        String(content || "")
            .split("\n")
            .forEach((line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) {
                    return;
                }
                const eq = trimmed.indexOf("=");
                if (eq > 0) {
                    config[trimmed.slice(0, eq).trim()] = trimmed
                        .slice(eq + 1)
                        .trim();
                }
            });
        return config;
    }

    function utf8ToBase64(str) {
        // TextEncoder 处理多字节字符（注释可能含中文），分块拼接避免栈溢出。
        const bytes = new TextEncoder().encode(str);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(
                null,
                bytes.subarray(i, i + CHUNK)
            );
        }
        return btoa(binary);
    }

    async function safeWriteFile(path, text) {
        // base64 旁路防命令注入：字符集 [A-Za-z0-9+/=] 全在单引号安全集内。
        const b64 = utf8ToBase64(text);
        const r = await execShell(`echo '${b64}' | base64 -d > '${path}'`);
        if (r.code !== 0) {
            throw new Error(r.err || "write_failed");
        }
    }

    /* ==================== 快照数据结构 ====================
       fetchSnapshot 返回结构固定如下：
       {
         service: { running, pid },
         games:   { count },
         mode:    { id: "daily" | "game" | "error", name, desc, badge },
         cpu:     { mid: { percent, cur, max, unit }, big: { ... } },
         gpu:     { percent, cur, max, unit }
       }
       cur / max 使用 MHz，由界面格式化为 GHz / MHz。
       ==================================================== */
    const MODE_PRESETS = {
        daily: {
            id: "daily",
            name: "日常模式",
            desc: "限频生效",
            badge: "生效中"
        },
        game: {
            id: "game",
            name: "游戏模式",
            desc: "限频已解除",
            badge: "已解除"
        },
        error: {
            id: "error",
            name: "读取失败",
            desc: "未检测到运行状态",
            badge: "异常"
        }
    };

    function verifyPidAlive(pid, timeoutMs = 0) {
        // const pidStr = String(pid);
        return new Promise((resolve) => {
            execShell(`kill -0 '${pid}' 2>/dev/null && echo ok || echo dead`, timeoutMs).then(
                (r) => {
                    resolve((r.out || "").includes("ok"));
                }
            );
        });
    }

    const dataSource = {
        async fetchSnapshot(options = {}) {
            // 无 root 视为异常状态，不回退 mock，清晰提示未挂载。
            if (!hasRoot()) {
                return errorSnapshot();
            }

            // 首屏包含创建 root shell 的开销，超时放宽。
            const timeoutMs = options.initial ? 8000 : 5000;

            try {
                const { files, code, err } = await readFiles(
                    [
                        STATE_FILE,
                        PID_FILE,
                        GAMES_FILE,
                        SYSFS.midMax,
                        SYSFS.midCur,
                        SYSFS.bigMax,
                        SYSFS.bigCur,
                        SYSFS.gpuMax,
                        SYSFS.gpuCur
                    ],
                    timeoutMs
                );

                // 宿主丢回调不会抛异常，只能靠返回的 code/err 判断。
                const timedOut = code !== 0 && err === "timeout";

                // 模式判定：只看 current_state 文件内容。
                const state = files[STATE_FILE];
                let mode;
                if (state === "game") {
                    mode = MODE_PRESETS.game;
                } else if (state) {
                    mode = MODE_PRESETS.daily;
                } else {
                    mode = MODE_PRESETS.error;
                }

                // PID：读文件后 kill -0 二次校验进程存活。
                const pidNum = Number.parseInt(files[PID_FILE], 10);
                let service = { running: false, pid: "—" };
                if (Number.isFinite(pidNum) && pidNum > 0) {
                    const alive = await verifyPidAlive(pidNum, timeoutMs);
                    service = alive
                        ? { running: true, pid: pidNum }
                        : { running: false, pid: "—" };
                }

                return {
                    service,
                    games: { count: countPackages(files[GAMES_FILE]) },
                    mode,
                    timedOut,
                    cpu: {
                        mid: buildFreq(
                            toCpuMhz(files[SYSFS.midCur]),
                            toCpuMhz(files[SYSFS.midMax]),
                            "GHz"
                        ),
                        big: buildFreq(
                            toCpuMhz(files[SYSFS.bigCur]),
                            toCpuMhz(files[SYSFS.bigMax]),
                            "GHz"
                        )
                    },
                    gpu: buildFreq(
                        toGpuMhz(files[SYSFS.gpuCur]),
                        toGpuMhz(files[SYSFS.gpuMax]),
                        "MHz"
                    )
                };
            } catch (error) {
                console.error("fetchSnapshot 失败", error);
                return errorSnapshot();
            }
        }
    };

    /* ==================== 包名列表数据源 ====================
       与主界面一致，先用本地模拟数据
       文本格式：每行一个包名，# 开头为注释。
       ==================================================== */
    function buildMockPackageText() {
        const prefixes = [
            "com.tencent.tmgp",
            "com.tencent",
            "com.netease",
            "com.miHoYo",
            "com.HoYoverse",
            "com.hermes",
            "com.genuine",
            "com.ztgame"
        ];
        const slugs = [
            "dwrg", "qqspeed", "bh3", "my", "jkccz",
            "xinlong", "na", "sgame", "hkrpg", "ys",
            "wzry", "cbjl", "al", "hykd", "mrfz",
            "ssjj", "qjnn", "xyls", "gzlj", "dqmc"
        ];

        const names = [];
        outer: for (let step = 0; step < slugs.length; step += 1) {
            for (let p = 0; p < prefixes.length; p += 1) {
                names.push(`${prefixes[p]}.${slugs[(p + step) % slugs.length]}`);
                if (names.length >= 153) {
                    break outer;
                }
            }
        }
        return names.join("\n");
    }

    function countPackages(text) {
        return String(text || "")
            .split("\n")
            .filter((line) => {
                const trimmed = line.trim();
                return trimmed.length > 0 && !trimmed.startsWith("#");
            }).length;
    }

    const packageStore = {
        async fetchPackages() {
            if (!hasRoot()) {
                // 无 root 降级：优先 localStorage，再 mock，便于开发预览。
                const cached = safeStorage.get(PACKAGES_KEY);
                return cached !== null ? cached : buildMockPackageText();
            }
            const r = await execShell(`cat '${GAMES_FILE}' 2>/dev/null`, 5000);
            // 即使为空也返回空串，由 UI 显示空列表（不回退 mock 以免混淆真实状态）。
            return r.out || "";
        },
        async savePackages(text) {
            if (!hasRoot()) {
                safeStorage.set(PACKAGES_KEY, text);
                return;
            }
            // base64 旁路写文件；守护进程自动监控文件变化重载，无需额外命令。
            await safeWriteFile(GAMES_FILE, text);
        }
    };

    /* ==================== 数字与频率格式化 ==================== */
    const numberFrames = new WeakMap();

    function animateNumber(element, target, { from = null, duration = 780 } = {}) {
        if (!element) {
            return;
        }

        const previous = Number.parseInt(element.textContent.replace(/[^\d-]/g, ""), 10);
        const startValue = from !== null ? from : Number.isFinite(previous) ? previous : 0;
        const endValue = Math.round(target);

        if (numberFrames.has(element)) {
            cancelAnimationFrame(numberFrames.get(element));
            numberFrames.delete(element);
        }

        if (REDUCED_MOTION.matches || duration <= 0) {
            element.textContent = String(endValue);
            return;
        }

        const startedAt = performance.now();

        function frame(now) {
            const progress = Math.min(1, (now - startedAt) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            element.textContent = String(Math.round(startValue + (endValue - startValue) * eased));

            if (progress < 1) {
                numberFrames.set(element, requestAnimationFrame(frame));
            } else {
                numberFrames.delete(element);
                element.textContent = String(endValue);
            }
        }

        numberFrames.set(element, requestAnimationFrame(frame));
    }

    function formatFrequency(value, unit) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return "—";
        }
        if (unit === "GHz") {
            return (numeric / 1000).toFixed(2);
        }
        return String(Math.round(numeric));
    }

    function renderFrequencyLine(element, data) {
        if (!element) {
            return;
        }

        const unit = data.unit || "MHz";
        const current = formatFrequency(data.cur, unit);
        const maximum = formatFrequency(data.max, unit);

        $(".freq-cur", element).textContent = current;
        $(".freq-max", element).textContent = maximum;
        $(".freq-unit", element).textContent = unit;
        element.setAttribute(
            "aria-label",
            `当前频率 ${current} ${unit}，最大频率 ${maximum} ${unit}`
        );
    }

    function setGauge(ring, percent, { animate = true } = {}) {
        if (!ring) {
            return;
        }

        const safePercent = clamp(Number(percent) || 0, 0, 100);
        const offset = RING_CIRCUMFERENCE * (1 - safePercent / 100);

        ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);

        if (!animate) {
            ring.style.transition = "none";
            ring.style.strokeDashoffset = String(offset);
            window.requestAnimationFrame(() => {
                ring.style.transition = "";
            });
            return;
        }

        ring.style.strokeDashoffset = String(offset);
    }

    /* ==================== 渲染快照 ==================== */
    function renderSnapshot(snapshot, { initial = false, silent = false } = {}) {
        const pidValue = $("#pidValue");
        const gameCount = $("#gameCount");
        const settingsGameCount = $("#settingsGameCount");

        pidValue.textContent = snapshot.service?.pid ?? "—";

        // 服务状态跟随 PID 校验结果：运行中 / 未运行。
        const serviceCard = $("#serviceCard");
        const serviceTitle = $("#serviceStatusTitle");
        const serviceRunning = Boolean(snapshot.service?.running);
        if (serviceTitle) {
            serviceTitle.textContent = serviceRunning
                ? "服务运行中"
                : "服务未运行";
        }
        if (serviceCard) {
            serviceCard.classList.toggle("is-stopped", !serviceRunning);
            serviceCard.setAttribute(
                "aria-label",
                `${serviceRunning ? "服务运行中" : "服务未运行"}，PID ${
                    snapshot.service?.pid ?? "—"
                }`
            );
        }
        if (settingsGameCount) {
            settingsGameCount.textContent = String(snapshot.games?.count ?? "—");
        }
        // silent 时缩短数字动画，减少 5 秒一刷的视觉抖动。
        const countDuration = initial ? 900 : silent ? 300 : 600;
        animateNumber(gameCount, snapshot.games?.count ?? 0, {
            from: initial ? 0 : null,
            duration: countDuration
        });

        const mode = snapshot.mode || MODE_PRESETS.daily;
        const modeBanner = $("#modeBanner");
        const modeName = $("#modeName");
        const modeDesc = $("#modeDesc");
        const modeBadgeText = $("#modeBadgeText");

        modeBanner.dataset.mode = mode.id;
        modeBanner.setAttribute(
            "aria-label",
            `当前模式：${mode.name}，${mode.desc}`
        );
        modeName.textContent = mode.name;
        modeDesc.textContent = mode.desc;
        modeBadgeText.textContent = mode.badge;

        const cpu = snapshot.cpu || {};
        const gpu = snapshot.gpu || {};
        const channels = [
            {
                key: "mid",
                data: cpu.mid,
                ring: $("#midRing"),
                percent: $("#midPercent"),
                freq: $("#midFreq"),
                title: $("#midGaugeLabel"),
                label: "中核"
            },
            {
                key: "big",
                data: cpu.big,
                ring: $("#bigRing"),
                percent: $("#bigPercent"),
                freq: $("#bigFreq"),
                title: $("#bigGaugeLabel"),
                label: "大核"
            },
            {
                key: "gpu",
                data: gpu,
                ring: $("#gpuRing"),
                percent: $("#gpuPercent"),
                freq: $("#gpuFreq"),
                title: $("#gpuGaugeLabel"),
                label: "GPU"
            }
        ];

        channels.forEach((channel) => {
            const data = channel.data || {};
            const percent = clamp(Number(data.percent) || 0, 0, 100);

            const percentDuration = initial ? 900 : silent ? 320 : 620;
            setGauge(channel.ring, percent, { animate: !REDUCED_MOTION.matches });
            animateNumber(channel.percent, percent, {
                from: initial ? 0 : null,
                duration: percentDuration
            });

            if (channel.title) {
                channel.title.textContent = `${channel.label}占用 ${percent}%`;
            }

            renderFrequencyLine(channel.freq, data);
        });

        const lastUpdate = $("#lastUpdate");
        const now = new Date();
        const timeText = now.toLocaleTimeString("zh-CN", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
        // 超时是宿主静默丢回调的唯一可见迹象，顺带打出当前 WebUI 引擎便于排查。
        lastUpdate.textContent = snapshot.timedOut
            ? `读取超时 ${timeText} · ${detectEngine()}`
            : `更新于 ${timeText}`;
    }

    /* ==================== 刷新流程 ==================== */
    let refreshing = false;

    async function refreshData({ initial = false, silent = false } = {}) {
        if (refreshing) {
            return;
        }

        const button = $("#refreshBtn");
        const label = $("#refreshLabel");

        refreshing = true;

        if (!initial && !silent) {
            button.disabled = true;
            button.classList.add("is-refreshing");
            button.setAttribute("aria-busy", "true");
            label.textContent = "刷新中";
            haptic(8);
            await wait(560);
        }

        try {
            const snapshot = await dataSource.fetchSnapshot({ initial });
            renderSnapshot(snapshot, { initial, silent });

            if (!initial && !silent) {
                showToast("数据已刷新");
            }
        } catch (error) {
            console.error("读取频率数据失败", error);
            renderSnapshot(errorSnapshot(), { initial: false, silent });
            if (!silent) {
                showToast("读取失败，请稍后再试");
            }
        } finally {
            refreshing = false;

            if (!initial && !silent) {
                button.disabled = false;
                button.classList.remove("is-refreshing");
                button.removeAttribute("aria-busy");
                label.textContent = "刷新数据";
            }
        }
    }

    /* ==================== 自动刷新 ==================== */
    const AUTO_INTERVAL = 5000;
    let autoTimer = 0;

    function isHomeActive() {
        return $("#page-home")?.classList.contains("is-active") === true;
    }

    function startAutoRefresh() {
        if (autoTimer) {
            return;
        }
        autoTimer = window.setInterval(() => {
            // 隐藏或非主页跳过本轮，避免无谓 shell 调用。
            if (document.hidden || !isHomeActive()) {
                return;
            }
            refreshData({ silent: true });
        }, AUTO_INTERVAL);
    }

    function stopAutoRefresh() {
        if (autoTimer) {
            window.clearInterval(autoTimer);
            autoTimer = 0;
        }
    }

    /* ==================== 主题 ==================== */
    let themePreference = "auto";
    const themeMeta = document.querySelector('meta[name="theme-color"]');

    function resolveTheme(preference) {
        if (preference === "auto") {
            return DARK_QUERY.matches ? "dark" : "light";
        }
        return preference;
    }

    function paintTheme(preference, { persist = false } = {}) {
        themePreference = preference;

        if (preference === "auto") {
            document.documentElement.removeAttribute("data-theme");
        } else {
            document.documentElement.setAttribute("data-theme", preference);
        }

        $$("[data-theme-choice]").forEach((button) => {
            const active = button.dataset.themeChoice === preference;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });

        const resolved = resolveTheme(preference);
        if (themeMeta) {
            themeMeta.setAttribute("content", resolved === "dark" ? "#0f172a" : "#f5f7fa");
        }

        if (persist) {
            safeStorage.set(THEME_KEY, preference);
        }
    }

    function initTheme() {
        const stored = safeStorage.get(THEME_KEY);
        const preference = stored === "light" || stored === "dark" ? stored : "auto";
        paintTheme(preference);

        $$("[data-theme-choice]").forEach((button) => {
            button.addEventListener("click", () => {
                paintTheme(button.dataset.themeChoice, { persist: true });
                haptic(6);
            });
        });

        const onSystemThemeChange = () => {
            if (themePreference === "auto") {
                paintTheme("auto");
            }
        };

        if (typeof DARK_QUERY.addEventListener === "function") {
            DARK_QUERY.addEventListener("change", onSystemThemeChange);
        } else if (typeof DARK_QUERY.addListener === "function") {
            DARK_QUERY.addListener(onSystemThemeChange);
        }
    }

    /* ==================== 页面切换 ==================== */
    function switchPage(pageName, { feedback = true } = {}) {
        const target = $(`#page-${pageName}`);
        if (!target) {
            return;
        }

        $$(".page").forEach((page) => {
            page.classList.toggle("is-active", page === target);
        });

        // 子页面（如包名列表）隐藏底部导航，返回时恢复。
        document.body.classList.toggle("subpage-active", target.classList.contains("page-sub"));

        $$(".tab").forEach((tab) => {
            const active = tab.dataset.page === pageName;
            tab.classList.toggle("is-active", active);
            if (active) {
                tab.setAttribute("aria-current", "page");
            } else {
                tab.removeAttribute("aria-current");
            }
        });

        if (feedback) {
            haptic(5);
        }
        window.scrollTo({
            top: 0,
            behavior: REDUCED_MOTION.matches ? "auto" : "smooth"
        });
    }

    function initNavigation() {
        $$(".tab").forEach((tab) => {
            tab.addEventListener("click", () => switchPage(tab.dataset.page));
        });
    }

    /* ==================== 按钮波纹 ==================== */
    function spawnRipple(element, event) {
        const rect = element.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 2.2;
        const ripple = document.createElement("span");

        ripple.className = "ripple";
        ripple.style.width = `${size}px`;
        ripple.style.height = `${size}px`;
        ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
        ripple.style.top = `${event.clientY - rect.top - size / 2}px`;

        element.appendChild(ripple);
        window.setTimeout(() => ripple.remove(), 680);
    }

    function initRipples() {
        document.addEventListener("pointerdown", (event) => {
            const button = event.target.closest(".btn");
            if (!button || button.disabled) {
                return;
            }
            spawnRipple(button, event);
        });
    }

    /* ==================== 提示与触感 ==================== */
    let toastTimer = 0;

    function showToast(message) {
        const toast = $("#toast");
        const messageToggle = $("#messageToggle");

        if (!toast || (messageToggle && !messageToggle.checked)) {
            return;
        }

        toast.textContent = message;
        toast.classList.add("is-visible");

        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
            toast.classList.remove("is-visible");
        }, 1900);
    }

    function haptic(duration = 6) {
        const vibrateToggle = $("#vibrateToggle");
        if (vibrateToggle && !vibrateToggle.checked) {
            return;
        }
        if (typeof navigator.vibrate === "function") {
            navigator.vibrate(duration);
        }
    }

    /* ==================== 设置页交互 ==================== */
    const DEFAULT_SETTINGS = {
        vibrate: true,
        message: true,
        log: true,
        autoClean: true,
        cleanSize: 1024
    };

    async function readStoredSettings() {
        if (!hasRoot()) {
            // 无 root 保留原 localStorage 行为，便于开发预览。
            const raw = safeStorage.get(SETTINGS_KEY);
            if (!raw) {
                return { ...DEFAULT_SETTINGS };
            }
            try {
                const parsed = JSON.parse(raw) || {};
                return {
                    ...DEFAULT_SETTINGS,
                    ...parsed,
                    cleanSize: Number.isFinite(Number(parsed.cleanSize))
                        ? Number(parsed.cleanSize)
                        : DEFAULT_SETTINGS.cleanSize
                };
            } catch (error) {
                return { ...DEFAULT_SETTINGS };
            }
        }

        try {
            const r = await execShell(`cat '${CONFIG_FILE}' 2>/dev/null`, 5000);
            const cfg = parseConfig(r.out);
            const maxSize = Number.parseInt(cfg.MAX_SIZE || "0", 10) || 0;
            return {
                vibrate: cfg.VIBRATE !== "0",
                message: cfg.MESSAGE !== "0",
                log: cfg.WRITE_LOG !== "0",
                autoClean: maxSize > 0,
                cleanSize: maxSize
            };
        } catch (error) {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function updateDependentFields() {
        const logToggle = $("#logToggle");
        const autoCleanToggle = $("#autoCleanToggle");
        const autoCleanRow = autoCleanToggle?.closest(".setting-row");
        const cleanSizeRow = $("#cleanSizeRow");
        const cleanSize = $("#cleanSize");

        const logEnabled = Boolean(logToggle?.checked);
        const autoCleanEnabled = logEnabled && Boolean(autoCleanToggle?.checked);

        if (autoCleanToggle) {
            autoCleanToggle.disabled = !logEnabled;
        }
        if (autoCleanRow) {
            autoCleanRow.classList.toggle("is-disabled", !logEnabled);
        }

        if (cleanSizeRow) {
            cleanSizeRow.classList.toggle("is-disabled", !autoCleanEnabled);
        }
        if (cleanSize) {
            cleanSize.disabled = !autoCleanEnabled;
        }
    }

    function applySettings(settings) {
        const vibrateToggle = $("#vibrateToggle");
        const messageToggle = $("#messageToggle");
        const logToggle = $("#logToggle");
        const autoCleanToggle = $("#autoCleanToggle");
        const cleanSize = $("#cleanSize");

        if (vibrateToggle) vibrateToggle.checked = settings.vibrate !== false;
        if (messageToggle) messageToggle.checked = settings.message !== false;
        if (logToggle) logToggle.checked = settings.log !== false;
        if (autoCleanToggle) autoCleanToggle.checked = settings.autoClean !== false;
        if (cleanSize) cleanSize.value = String(settings.cleanSize ?? DEFAULT_SETTINGS.cleanSize);

        updateDependentFields();
    }

    async function saveSettings(settings) {
        const writeLog = settings.log ? "1" : "0";
        const vibrate = settings.vibrate ? "1" : "0";
        const message = settings.message ? "1" : "0";
        const maxSize =
            settings.log && settings.autoClean && settings.cleanSize > 0
                ? String(settings.cleanSize)
                : "0";

        const button = $("#saveSettings");
        if (button) {
            button.disabled = true;
        }

        try {
            if (!hasRoot()) {
                safeStorage.set(SETTINGS_KEY, JSON.stringify(settings));
                haptic(10);
                showToast("设置已保存（本地预览）");
                return;
            }

            const cmds = [
                `sh '${CONFIG_HELPER}' set WRITE_LOG ${writeLog}`,
                `sh '${CONFIG_HELPER}' set MAX_SIZE ${maxSize}`,
                `sh '${CONFIG_HELPER}' set VIBRATE ${vibrate}`,
                `sh '${CONFIG_HELPER}' set MESSAGE ${message}`
            ];

            // 串行写入，避免文件锁竞争。
            for (const cmd of cmds) {
                const r = await execShell(cmd);
                if (r.code !== 0) {
                    haptic(10);
                    showToast("保存失败：" + (r.err || "未知错误"));
                    return;
                }
            }
            haptic(10);
            showToast("设置已保存");
        } catch (error) {
            console.error("保存设置失败", error);
            showToast("保存失败，请稍后再试");
        } finally {
            if (button) {
                button.disabled = false;
            }
        }
    }

    async function initSettings() {
        // 先绑定事件（不依赖远程数据），避免 await 期间用户操作无响应。
        const logToggle = $("#logToggle");
        const autoCleanToggle = $("#autoCleanToggle");

        if (logToggle) {
            logToggle.addEventListener("change", updateDependentFields);
        }
        if (autoCleanToggle) {
            autoCleanToggle.addEventListener("change", updateDependentFields);
        }

        $$(".row-link").forEach((row) => {
            row.addEventListener("click", () => {
                const action = row.dataset.action;
                haptic(6);

                // 包名列表：进入子页面，其余保持占位提示。
                if (action === "packages") {
                    switchPage("packages");
                    return;
                }
                showToast("配置文件编辑将在后端接入后开放");
            });
        });

        const saveButton = $("#saveSettings");
        if (saveButton) {
            saveButton.addEventListener("click", () => {
                const settings = {
                    vibrate: $("#vibrateToggle")?.checked !== false,
                    message: $("#messageToggle")?.checked !== false,
                    log: $("#logToggle")?.checked !== false,
                    autoClean: $("#autoCleanToggle")?.checked !== false,
                    cleanSize: Number.parseInt($("#cleanSize")?.value, 10) || 0
                };
                saveSettings(settings);
            });
        }

        // 再异步加载配置并应用。
        try {
            applySettings(await readStoredSettings());
        } catch (error) {
            applySettings({ ...DEFAULT_SETTINGS });
        }
    }

    /* ==================== 包名列表子页面 ==================== */
    // 合法包名：字母 / 数字 / 下划线，用点分段，不得以点开头结尾或连续出现。
    const PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

    function syncGameCounts(count) {
        // 同步主页大数字与设置页行数量，保证各页面计数一致。
        const settingsGameCount = $("#settingsGameCount");
        if (settingsGameCount) {
            settingsGameCount.textContent = String(count);
        }
        animateNumber($("#gameCount"), count, { duration: 480 });
    }

    function updatePkgCount(text, { animate = true } = {}) {
        const count = countPackages(text);
        const counter = $("#pkgCount");

        if (counter) {
            if (animate && !REDUCED_MOTION.matches) {
                animateNumber(counter, count, { duration: 420 });
            } else {
                counter.textContent = String(count);
            }
        }
        return count;
    }

    function initPackages() {
        const editor = $("#pkgEditor");
        if (!editor) {
            return;
        }

        let savedText = ""; // 最近一次保存（或首次加载）的内容，用于判断是否有未保存修改。

        const renderText = (text, { animate = true } = {}) => {
            editor.value = text;
            savedText = text;
            const count = updatePkgCount(text, { animate });
            syncGameCounts(count);
        };

        // 快速添加：校验 → 去重 → 追加到编辑区末尾。
        const quickAdd = () => {
            const input = $("#pkgQuickInput");
            if (!input) {
                return;
            }

            const name = input.value.trim();
            if (!name) {
                showToast("请输入包名");
                input.focus();
                return;
            }
            if (!PACKAGE_NAME_RE.test(name)) {
                showToast("包名格式不正确，例如 com.xxx.game");
                input.focus();
                return;
            }

            const exists = editor.value.split("\n").some((line) => line.trim() === name);
            if (exists) {
                showToast("该包名已在列表中");
                return;
            }

            const trimmedValue = editor.value.replace(/\s+$/, "");
            editor.value = trimmedValue ? `${trimmedValue}\n${name}` : name;
            input.value = "";
            updatePkgCount(editor.value);
            haptic(6);
            showToast(`已添加 ${name}`);
            editor.scrollTop = editor.scrollHeight;
        };

        // 保存：写入 packages.txt，守护进程自动监控重载。
        const saveAndReload = async () => {
            const button = $("#pkgSaveBtn");
            button.disabled = true;
            try {
                await packageStore.savePackages(editor.value);
                savedText = editor.value;
                syncGameCounts(countPackages(editor.value));
                haptic(10);
                showToast("已保存");
            } catch (error) {
                console.error("保存包名列表失败", error);
                showToast("保存失败，请稍后再试");
            } finally {
                button.disabled = false;
            }
        };

        // 重新加载：放弃未保存的修改，恢复到最近保存的内容。
        const reload = async () => {
            const button = $("#pkgReloadBtn");
            button.disabled = true;
            try {
                const text = await packageStore.fetchPackages();
                renderText(text);
                haptic(6);
                showToast("已重新加载");
            } catch (error) {
                console.error("读取包名列表失败", error);
                showToast("读取失败，请稍后再试");
            } finally {
                button.disabled = false;
            }
        };

        $("#pkgAddBtn")?.addEventListener("click", quickAdd);
        $("#pkgQuickInput")?.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                quickAdd();
            }
        });
        $("#pkgSaveBtn")?.addEventListener("click", saveAndReload);
        $("#pkgReloadBtn")?.addEventListener("click", reload);
        editor.addEventListener("input", () => updatePkgCount(editor.value));

        // 返回设置页；有未保存修改时先提示确认。
        $("#pkgBackBtn")?.addEventListener("click", () => {
            if (editor.value !== savedText) {
                showToast("有未保存的修改，请先保存或重新加载");
                return;
            }
            haptic(5);
            switchPage("settings");
        });

        // 首次进入填充数据。
        packageStore.fetchPackages().then((text) => renderText(text, { animate: false }))
            .catch(() => renderText(buildMockPackageText(), { animate: false }));
    }

    /* ==================== 初始化 ==================== */
    function init() {
        const params = new URLSearchParams(window.location.search);

        const staticMode = document.documentElement.classList.contains("no-motion")
            || params.has("static");

        initTheme();
        // 支持 ?theme=light / dark / auto 直接预览主题，不写入本地偏好。
        const themeOverride = params.get("theme");
        if (themeOverride === "light" || themeOverride === "dark" || themeOverride === "auto") {
            paintTheme(themeOverride);
        }

        initNavigation();
        initRipples();
        initSettings();
        initPackages();

        const refreshButton = $("#refreshBtn");
        if (refreshButton) {
            refreshButton.addEventListener("click", () => refreshData({ initial: false }));
        }

        // 首屏立即渲染，随后进入自动刷新流程。
        refreshData({ initial: true });

        // 自动刷新（?static=1 时关闭，与静态预览语义一致）。
        if (!staticMode) {
            startAutoRefresh();
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) {
                    stopAutoRefresh();
                } else {
                    startAutoRefresh();
                }
            });
        }

        // 支持 ?page=settings / ?page=about / ?page=packages 直接打开指定页面。
        const requestedPage = params.get("page");
        if (requestedPage && $(`#page-${requestedPage}`)) {
            switchPage(requestedPage, { feedback: false });
        }

        // 便于后续接入后端时复用。
        window.ChenxiUI = {
            refresh: () => refreshData({ initial: false }),
            switchPage,
            setMode(modeId) {
                const preset = MODE_PRESETS[modeId];
                if (!preset) {
                    return;
                }
                const snapshot = errorSnapshot();
                snapshot.mode = { ...preset };
                renderSnapshot(snapshot);
            },
            dataSource
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();
