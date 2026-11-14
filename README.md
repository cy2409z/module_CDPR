# 晨夕敛光 · CDPR

面向 **一加 Ace 6T / 骁龙 8 Gen 5（SM8845 / SM8845P）** 的 KernelSU 模块：日常使用时限制 CPU / GPU 最高频率，压掉瞬时爆发功耗；检测到游戏在前台时解除锁定，把调度权交还系统。

基于 KernelSU 的 WebUI 机制开发，使用 `kernelsu.exec` / `ksu.exec` 桥接读写 sysfs，不依赖额外 APP。

当前版本：**C1.3.1（20261114）**  
作者：**晨阳**

---

## 为什么需要它

骁龙 8 Gen 5 在轻负载场景（滑动列表、打开应用、刷短视频）会频繁冲上最高频，瞬时功耗尖峰带来发热与耗电，而这类场景并不需要满血性能。

本模块做两件事：

1. **日常模式**：把 CPU 中核 / 大核与 GPU 的最高频率压到够用档位，并每轮循环校验底层真实值，被系统或其他模块改写后立即写回。
2. **游戏模式**：前台命中游戏包名列表时，恢复硬件最高频率（读 `cpuinfo_max_freq`），完全交给系统调度，不做任何干预。

---

## 频率档位

| 集群 / 部件                     | 节点                            | 日常模式上限                    | 游戏模式                  |
| --------------------------- | ----------------------------- | ------------------------- | --------------------- |
| 中核集群（policy0，6 × 3.32 GHz）  | `scaling_max_freq`            | **2266 MHz**              | 3321 MHz              |
| 超大核集群（policy6，2 × 3.80 GHz） | `scaling_max_freq`            | **1651 MHz**              | 3801 MHz              |
| GPU（Adreno，`kgsl-3d0`）      | `max_gpuclk` / `max_pwrlevel` | **500 MHz** / pwrlevel 13 | 1225 MHz / pwrlevel 0 |

日常模式的限频会**周期性复核**：每轮循环读取 `scaling_max_freq`、`max_gpuclk`，与目标值不一致就强制写回（必要时先 `chmod 644`），避免被游戏加速器、性能管理器或系统自身覆盖。

---

## 特性

- **前台检测，秒级切换**：`dumpsys window` 同时抓取 `mCurrentFocus`、`mFocusedApp`、`mHoldScreenWindow`、`mTopFullscreenOpaque`，分屏 / 小窗 / 悬浮窗场景同样能命中。
- **内置 224 款游戏包名**：覆盖主流手游及各家渠道服，可在 WebUI 中随时增删。
- **WebUI 面板**：实时查看当前模式、服务 PID、中核 / 超大核 / GPU 的当前频率与上限；设置页可改振动、通知、日志、自动清理阈值与包名列表。
- **守护进程**：`service.sh` 每 30 秒检查 `main.sh` 存活，异常退出自动拉起。
- **安装期冲突扫描**：安装时扫描其他已启用模块的脚本，命中频率 / 调度 / 绑核 / GPU / 性能管理关键字会列出明细，并可用音量键决定是否继续。
- **日志自动截断**：超过阈值后保留后半段，防止长期运行写爆存储。
- **卸载自动还原**：卸载时把所有节点恢复到硬件最高频率并结束进程，不留残留状态。

---

## 兼容性

| 项目       | 要求                                               |
| -------- | ------------------------------------------------ |
| SoC      | `ro.soc.model` = `SM8845` 或 `SM8845P`（不匹配直接中止安装） |
| 架构       | arm64（arm 32 位可用但可能异常）                           |
| Root 管理器 | KernelSU 及其衍生（SukiSU / WebUI X 均已在 C1.3.1 修复并适配） |
| 其他管理器    | Magisk / APatch 可安装，但 WebUI 与部分依赖 KSU 环境的功能不保证可用 |
| 已测机型     | 一加 Ace 6T                                        |

同平台其他机型理论可用（本模块只按 SoC 校验，不做机型绑定），但未实测。

**已知冲突**：旧版 `sd8845_dynamic_perf`、分支版 `CDPR` 需先卸载；`scene_swap_controller` 已在扫描中排除。

---

## 安装

1. 下载最新 Release 中的 zip，**不要解压**。
2. 在 KernelSU / SukiSU 管理器中「安装模块」并选择该 zip。
3. 安装过程会输出 SoC 校验、架构、管理器版本与冲突扫描结果。
   - 若检测到冲突：**音量上键**继续安装，**音量下键**取消，30 秒无操作默认取消。
4. 安装完成后重启。模块在系统启动完成后生效（详见「已知限制」）。

## 卸载

管理器内直接卸载模块并重启即可。卸载脚本会：

- 将 `policy0` / `policy6` 恢复到 3321 MHz / 3801 MHz
- 将 GPU 恢复到 1225 MHz / pwrlevel 0
- 结束 `main.sh` 与守护进程

---

## 使用

### WebUI

在支持 WebUI 的管理器中打开模块卡片即可。

- **主页**：当前模式（日常 / 游戏）、服务运行状态与 PID、中核 / 大核 / GPU 频率仪表、手动刷新
- **设置**：主题（跟随系统 / 浅色 / 深色）、振动提示、信息提示、写入日志、自动清理与阈值、包名列表入口
- **关于**：版本、适配平台、构建信息

页面数据全部来自真实 sysfs 与模块文件，无 root 环境会明确显示「异常」而不是填充假数据。

### 配置文件

路径：`/data/adb/modules/module_CDPR/res/config.conf`

```ini
# 是否自动清理日志 0:不启用 >0:日志大小(单位B)
MAX_SIZE=10240

# 是否写入日志 0:不写入 1:写入
WRITE_LOG=1

# 是否振动 0:不振动 1:振动
VIBRATE=0

# 是否发送通知 0:不发送 1:发送
MESSAGE=0
```

只改等号后的值，**不要留空格**，否则可能不生效。修改后在 WebUI 中保存或重启生效。

### 游戏列表

路径：`/data/adb/modules/module_CDPR/res/packages.txt`

每行一个包名，`#` 开头为注释，前台命中任意一行即解除限频。WebUI 的「包名列表」页支持快速添加与整体编辑，保存后守护进程自动重载。

```
com.tencent.tmgp.sgame
com.miHoYo.Yuanshen
com.miHoYo.hkrpg
```

### 运行日志

`/data/adb/modules/module_CDPR/运行日志.log`，记录模式切换与异常。`MAX_SIZE=0` 关闭自动清理。

---

## 目录结构

```
├── customize.sh            # 安装脚本：SoC/架构/管理器校验、冲突扫描、解压与授权
├── service.sh              # 守护进程：等 boot_completed、拉起 main.sh、每 30s 守护、日志轮转
├── main.sh                 # 核心循环：前台检测 + 日常/游戏模式切换
├── post-fs-data.sh         # 启动早期关键文件完整性检查
├── uninstall.sh            # 卸载还原频率并结束进程
├── module.prop
├── res/
│   ├── config.conf         # 用户配置
│   └── packages.txt        # 游戏包名列表
├── scripts/
│   ├── config_helper.sh    # 配置读写（get / set）
│   ├── check_frequency.sh  # 终端实时频率监控
│   ├── logger.sh           # 日志写入
│   └── notify.sh           # 振动与通知
└── webroot/                # WebUI（index.html / style.css / script.js / icon.png）
```

想直接看频率，可在终端执行：

```sh
sh /data/adb/modules/module_CDPR/scripts/check_frequency.sh
```

---

## 常见问题

**Q：切到游戏仍然卡？**  
先确认游戏包名在 `packages.txt` 中（渠道服包名不同，例如 `com.levelinfinite.sgameGlobal.midaspay`），再看 WebUI 主页是否已显示「游戏模式」。

**Q：日常模式下频率被改回去了？**  
这是预期行为——模块每轮循环都会复核并写回。如果频率在两次循环之间被反复篡改，说明有其他频率控制模块在抢写，建议按安装时的冲突报告清理。

**Q：WebUI 显示「读取失败 / 异常」？**  
多为宿主未注入 `exec`：确认使用的是 KernelSU 系管理器，并已在管理器中启用该模块的 WebUI。C1.3.1 已修复 SukiSU 系 WebUI 异常。

**Q：振动 / 通知没有反应？**  
默认 `VIBRATE=0`、`MESSAGE=0`，在 WebUI 设置页或 `config.conf` 中开启。

---

## 已知限制

- 限频在**系统启动完成后**才生效，开机初期不做限制。
- 前台判定基于 `dumpsys window` 的窗口字段，冷启动瞬间或特殊分屏布局下可能有数秒延迟。
- 只做 max 频率限制，不修改 governor、`sched_boost`、cpuset 等调度参数，但仍不推荐使用可能与系统调度冲突的性能模块。

---

## 更新日志

### C1.3.1（20261114）

- 修复 SukiSU 系管理器 WebUI 异常的问题
- 重构多处代码，优化效率并减少开销
- 重构 WebUI 界面和后端逻辑
- 尝试修复部分已知问题

---

## 许可

本项目采用 **Mozilla Public License 2.0（MPL-2.0）**。  
使用、修改、再分发请遵守该许可证条款；修改后的源文件需以相同许可证公开。

---

作者：晨阳
