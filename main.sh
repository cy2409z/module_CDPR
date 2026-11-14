#!/system/bin/sh
#晨夕敛光动态限频后台服务
MODDIR=${0%/*}
STATE_FILE="$MODDIR/current_state"
GAME_LIST_FILE="$MODDIR/res/packages.txt"
PIDFILE="$MODDIR/res/module.pid"

#写入当前进程 PID
echo $$ > "$PIDFILE"

#定义大核簇频率调度绝对路径
P0_DIR="/sys/devices/system/cpu/cpufreq/policy0"
#定义超大核大核簇频率调度绝对路径
P6_DIR="/sys/devices/system/cpu/cpufreq/policy6"
#定义GPU频率调度绝对路径
GPU_DIR="/sys/class/kgsl/kgsl-3d0"

apply_normal_mode() {
    #状态通知只发一次
    if [ "$(cat "$STATE_FILE" 2>/dev/null)" != "normal" ]; then
        echo "normal" > "$STATE_FILE"
        sh "$MODDIR/scripts/notify.sh" "晨夕敛光 - 骁龙8Gen5限频" "日常限频已开启"
        sh "$MODDIR/scripts/logger.sh" "切换至日常模式"
    fi

    #每次都检查底层真实数据是否被系统篡改
    # 检查大核
    if [ -d "$P0_DIR" ]; then
        local current_p0=$(cat "$P0_DIR/scaling_max_freq" 2>/dev/null)
        if [ "$current_p0" != "2266000" ]; then
            chmod 644 "$P0_DIR/scaling_max_freq" 2>/dev/null
            echo 2266000 > "$P0_DIR/scaling_max_freq" 2>/dev/null
        fi
    fi
    # 检查超大核
    if [ -d "$P6_DIR" ]; then
        local current_p6=$(cat "$P6_DIR/scaling_max_freq" 2>/dev/null)
        if [ "$current_p6" != "1651000" ]; then
            chmod 644 "$P6_DIR/scaling_max_freq" 2>/dev/null
            echo 1651000 > "$P6_DIR/scaling_max_freq" 2>/dev/null
        fi
    fi

    # 检查 GPU
    if [ -d "$GPU_DIR" ]; then
        local current_gpu=$(cat "$GPU_DIR/max_gpuclk" 2>/dev/null)
        if [ "$current_gpu" != "500000000" ]; then
            chmod 644 "$GPU_DIR/max_gpuclk" 2>/dev/null
            chmod 644 "$GPU_DIR/max_pwrlevel" 2>/dev/null
            echo 13 > "$GPU_DIR/max_pwrlevel" 2>/dev/null
            echo 500000000 > "$GPU_DIR/max_gpuclk" 2>/dev/null            
        fi
    fi
}

apply_game_mode() {
    [ "$(cat "$STATE_FILE" 2>/dev/null)" = "game" ] && return 0
    sh "$MODDIR/scripts/logger.sh" "切换至游戏模式，触发应用:$1"

    for policy in "$P0_DIR" "$P6_DIR"; do
        if [ -d "$policy" ]; then
            chmod 644 "$policy/scaling_max_freq" "$policy/scaling_min_freq" 2>/dev/null
            local hw_max=$(cat "$policy/cpuinfo_max_freq" 2>/dev/null)
            [ -n "$hw_max" ] && echo "$hw_max" > "$policy/scaling_max_freq" 2>/dev/null
        fi
    done

    if [ -d "$GPU_DIR" ]; then
        chmod 644 "$GPU_DIR/max_gpuclk" 2>/dev/null
        chmod 644 "$GPU_DIR/max_pwrlevel" 2>/dev/null
        echo 1225000000 > "$GPU_DIR/max_gpuclk" 2>/dev/null
        echo 0 > "$GPU_DIR/max_pwrlevel" 2>/dev/null

    fi

    echo "game" > "$STATE_FILE"
    sh "$MODDIR/scripts/notify.sh" "晨夕敛光 - 骁龙8Gen5限频" "限频已解除，系统接管"
}

# 定义清理函数
cleanup() {
    rm -f "$PIDFILE"
    exit 0
}

# 捕获 EXIT（脚本正常退出）、TERM、INT（Ctrl+C）等信号
trap cleanup EXIT TERM INT

sh "$MODDIR/scripts/logger.sh" "服务启动，强制初始化"

#删掉旧状态，强制触发第一次锁频
rm -f "$STATE_FILE" 2>/dev/null

#强制应用日常模式
apply_normal_mode

#动态主循环
while true; do
    #同时抓取焦点应用、底层全屏应用和保持屏幕常亮的应用
    CURRENT_APPS=$(dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp|mHoldScreenWindow|mTopFullscreenOpaque' | sed -E 's/.* ([a-zA-Z0-9.]+)\/.*/\1/' | sort -u)
    
    GAME_RUNNING=0
    GAME_APP=""

    #遍历当前屏幕上的所有活跃应用，只要其中有一个是游戏，就保持满血释放
    for app in $CURRENT_APPS; do
        if [ -n "$app" ] && [ "$app" != "null" ]; then
            if grep -q -w "$app" "$GAME_LIST_FILE" 2>/dev/null; then
                GAME_RUNNING=1
                GAME_APP="$app"
                break
            fi
        fi
    done

    if [ "$GAME_RUNNING" = "1" ]; then
        apply_game_mode "$GAME_APP"
        #游戏内更低频检测
        sleep 10
    else
        apply_normal_mode
        #日常使用拉长检测间隔至 5 秒，彻底消除滑动卡顿
        sleep 5
    fi
done
