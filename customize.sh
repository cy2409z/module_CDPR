SKIPUNZIP=1

ui_print "晨夕敛光 - 骁龙8Gen5限频"
ui_print "当前版本：C1.3.1 - 20261114"

#设备信息
SOC_MODEL=$(getprop ro.soc.model)
ui_print "  [设备] SoC: $SOC_MODEL"
if [ "$SOC_MODEL" = "SM8845" ] || [ "$SOC_MODEL" = "SM8845P" ]; then
    ui_print "  [✓] SoC 匹配"
else
    ui_print " [!] SoC不符合要求"
    exit 1
fi

#架构
if [ "$ARCH" = "arm64" ]; then
    ui_print "  [✓] 架构: arm64"
elif [ "$ARCH" = "arm" ]; then
    ui_print "  [!] 架构: arm (32位，可能有兼容性问题)"
else
    ui_print "  [!] 架构: $ARCH"
fi

#管理器版本
if [ -n "$KSU_VER_CODE" ]; then
    ui_print "  [✓] KernelSU 已安装 $KSU_VER "
elif [ -n "$MAGISK_VER_CODE" ]; then
    ui_print "  [✓] Magisk 版本: $MAGISK_VER_CODE"
    ui_print "  ❗本模块为KernelSu开发，不确定其在其他管理器的兼容性"
elif [ -n "$APATCH_VER_CODE" ]; then
    ui_print "  [✓] APatch 版本: $APATCH_VER_CODE"
    ui_print "  ❗本模块为KernelSu开发，不确定其在其他管理器的兼容性"
else
    ui_print "  [!] 未检测到 Magisk/APatch/KernelSU"
    exit 1
fi

#检查冲突
MODDIR="${0%/*}"
SELF_ID="module_CDPR"
TMP_RESULT="/data/local/tmp/conflict_result.txt"
TIMEOUT=30

SCHED_OPS="scaling_max_freq|scaling_min_freq|scaling_governor|cpu_boost|sched_boost|schedtune|sched_walt|walt|pelt_multiplier"
FREQ_OPS="cpufreq|core_ctl|max_freq|min_freq"
BIND_OPS="cpuset|AppOpt|appopt|taskset|affinity|threads\.json|categories\.json"
GPU_OPS="gpu_max_freq|gpu_min_freq|gpu_pwrlevel|kgsl|adreno_idler|max_gpuclk|min_pwrlevel"
OTHER_OPS="perfhal|perfservice|perfmgr|MiuiPerf|gameopt|boost|powerhal|power\.HAL|miperf|oiface|horae"

ALL_OPS="$SCHED_OPS|$FREQ_OPS|$BIND_OPS|$GPU_OPS|$OTHER_OPS"
MAX_HITS=10
CHUNK=200
MATCH_FILE="$TMP_RESULT.matches"
LIST_FILE="$TMP_RESULT.list"

MODULES_DIR="/data/adb/modules"
#忽略的模块
EXCLUDED_IDS="scene_swap_controller"
FOUND_CONFLICT=false

#回退逻辑
say() {
    if command -v ui_print >/dev/null 2>&1; then
        ui_print "$1"
    else
        echo "$1"
    fi
}

#写报告文件
log() {
    printf "%s\n" "$1" >> "$TMP_RESULT"
    say "$1"
}
#多行处理
log_details() {
    printf "%b\n" "$1" | while IFS= read -r line; do
        [ -n "$line" ] && log "$line"
    done
}
#音量键检测
read_volume_key() {
    KEY_CHOICE=""
    start_time=$(date +%s)

    while [ $(($(date +%s) - start_time)) -lt "$TIMEOUT" ]; do
        # getevent -qlc 1 在没按键时会一直阻塞，套一层 timeout 保证超时能生效
        if command -v timeout >/dev/null 2>&1; then
            key_event=$(timeout 1 getevent -qlc 1 2>/dev/null | awk '/KEY_VOLUME/ {print $3}')
        else
            key_event=$(getevent -qlc 1 2>/dev/null | awk '/KEY_VOLUME/ {print $3}')
        fi

        if [ "$key_event" = "KEY_VOLUMEUP" ]; then
            KEY_CHOICE="continue"
            return 0
        elif [ "$key_event" = "KEY_VOLUMEDOWN" ]; then
            KEY_CHOICE="cancel"
            return 0
        fi

        sleep 0.1
    done
}

ask_continue_install() {
    say ""
    say "⚠️  检测到冲突，请选择下一步操作"
    say "    音量上键：继续安装"
    say "    音量下键：取消安装"
    say "    30 秒内无按键：默认取消安装"

    if command -v getevent >/dev/null 2>&1; then
        read_volume_key
        case "$KEY_CHOICE" in
            continue) log "选择结果：继续安装" ;;
            cancel)   log "选择结果：取消安装" ;;
            *)        log "超时未选择，使用默认选择：取消安装" ;;
        esac
    else
        say "警告: getevent 不可用，无法读取按键，默认取消安装"
        KEY_CHOICE="cancel"
        log "选择结果：取消安装（getevent 不可用）"
    fi
}

#显示上限
add_hit() {
    HAS_CONFLICT=true
    HIT_COUNT=$((HIT_COUNT + 1))
    [ "$HIT_COUNT" -le "$MAX_HITS" ] && CONFLICT_DETAILS="$CONFLICT_DETAILS\n   $1"
}

#按文件名判断
check_name() {
    _n=${1##*/}
    case "$_n" in
        AppOpt*) add_hit "⚠️ AppOpt 绑核引擎: ${1#"$MOD_DIR"/}" ;;
    esac
    return 0
}

#命中的脚本再处理
classify_file() {
    _f=$1
    _rel=${_f#"$MOD_DIR"/}

    grep -qE "$SCHED_OPS" "$_f" 2>/dev/null && add_hit "⚠️ 调度冲突: $_rel → 检测到 CPU 频率/调度器写入"
    grep -qE "$FREQ_OPS"  "$_f" 2>/dev/null && add_hit "⚠️ 频率冲突: $_rel → 检测到 cpufreq/core_ctl 操作"
    grep -qE "$BIND_OPS"  "$_f" 2>/dev/null && add_hit "⚠️ 绑核冲突: $_rel → 检测到 cpuset/AppOpt/Scene 操作"
    grep -qE "$GPU_OPS"   "$_f" 2>/dev/null && add_hit "⚠️ GPU冲突: $_rel → 检测到 GPU 频率/功耗控制"
    grep -qE "$OTHER_OPS" "$_f" 2>/dev/null && add_hit "⚠️ 性能管理冲突: $_rel → 检测到修改系统调度操作"
    return 0
}

scan_chunk() {
    grep -lE "$ALL_OPS" "$@" 2>/dev/null > "$MATCH_FILE"
    [ -s "$MATCH_FILE" ] || return 0

    while IFS= read -r _f; do
        classify_file "$_f"
    done < "$MATCH_FILE"
    return 0
}

list_targets() {
    if command -v find >/dev/null 2>&1; then
        find "$1" \
            \( -name webroot -o -name .git -o -name __MACOSX \) -prune -o \
            -type f \( -name '*.sh' -o -name 'AppOpt*' \) -print 2>/dev/null
        return 0
    fi
    walk_targets "$1"
}

walk_targets() {
    _dir=$1
    for _e in "$_dir"/* "$_dir"/.[!.]* "$_dir"/..?*; do
        [ -L "$_e" ] && continue
        case "/$_e/" in
            */.git/*|*/__MACOSX/*|*/webroot/*) continue ;;
        esac
        if [ -d "$_e" ]; then
            walk_targets "$_e"
            continue
        fi
        case "$_e" in
            *.sh|*AppOpt*) [ -f "$_e" ] && printf '%s\n' "$_e" ;;
        esac
    done
}

scan_module() {
    list_targets "$MOD_DIR" > "$LIST_FILE"
    [ -s "$LIST_FILE" ] || return 0

    set --
    _cnt=0
    while IFS= read -r _e; do
        case "$_e" in
            *.sh) ;;                            # 脚本：排队等 grep
            *) check_name "$_e"; continue ;;     # AppOpt 之类：只看名字
        esac

        SCANNED=$((SCANNED + 1))
        set -- "$@" "$_e"
        _cnt=$((_cnt + 1))
        if [ "$_cnt" -ge "$CHUNK" ]; then
            scan_chunk "$@"
            set --
            _cnt=0
        fi
    done < "$LIST_FILE"

    [ $# -gt 0 ] && scan_chunk "$@"
    return 0
}

rm -f "$TMP_RESULT" "$MATCH_FILE" "$LIST_FILE"
log "已安装模块扫描"

for d in "$MODULES_DIR"/*/; do
    [ -d "$d" ] || continue
    MOD_ID=$(basename "$d")

    [ "$MOD_ID" = "$SELF_ID" ] && continue

    case " $EXCLUDED_IDS " in
        *" $MOD_ID "*)
            log "⏭️  [已排除] $MOD_ID — 按配置跳过"
            continue ;;
    esac

    if [ -f "$d/disable" ]; then
        log "▶️  [已禁用] $MOD_ID — 跳过"
        continue
    fi

    if [ -f "$d/remove" ]; then
        log "🗑️  [待删除] $MOD_ID — 跳过"
        continue
    fi

    MOD_NAME=""
    [ -f "$d/module.prop" ] && MOD_NAME=$(grep "^name=" "$d/module.prop" 2>/dev/null | head -1 | cut -d= -f2)
    MOD_VERSION=""
    [ -f "$d/module.prop" ] && MOD_VERSION=$(grep "^version=" "$d/module.prop" 2>/dev/null | head -1 | cut -d= -f2)

    MOD_DIR=${d%/}                      # 去掉尾斜杠，报告里显示相对路径
    HAS_CONFLICT=false
    CONFLICT_DETAILS=""
    HIT_COUNT=0
    SCANNED=0

    # 扫描本模块的脚本（含任意子目录）
    scan_module

    if [ "$HIT_COUNT" -gt "$MAX_HITS" ]; then
        CONFLICT_DETAILS="$CONFLICT_DETAILS\n   …另有 $((HIT_COUNT - MAX_HITS)) 处命中未展开"
    fi

    # 检查旧版残留
    if [ "$MOD_ID" = "sd8845_dynamic_perf" ]; then
        HAS_CONFLICT=true
        CONFLICT_DETAILS="$CONFLICT_DETAILS\n   ❌ 检测到旧版模块！请卸载后再使用"
    fi
    if [ "$MOD_ID" = "CDPR" ]; then
        HAS_CONFLICT=true
        CONFLICT_DETAILS="$CONFLICT_DETAILS\n   ❌ 检测到分支版！请卸载后再使用"
    fi

    log "📦 $MOD_ID  （扫描 $SCANNED 个脚本）"
    [ -n "$MOD_NAME" ] && log "   名称: $MOD_NAME"
    [ -n "$MOD_VERSION" ] && log "   版本: $MOD_VERSION"

    if [ "$HAS_CONFLICT" = true ]; then
        FOUND_CONFLICT=true
        log_details "$CONFLICT_DETAILS"
        log "   🔴 存在冲突，请检查"
    else
        log "   🟢 未检测到冲突"
    fi
    log ""
done

rm -f "$MATCH_FILE" "$LIST_FILE"

log "========== 汇总 =========="

if [ "$FOUND_CONFLICT" = true ]; then
    log "❗ 检测到冲突，建议禁用或卸载冲突模块"
    log "❗ 如果您已知晓冲突并坚持继续安装，请等待3s后按按键确认"
    
    sleep 3
    
    ask_continue_install

    if [ "$KEY_CHOICE" != "continue" ]; then
        log "❌ 已取消安装"
        exit 1
    fi

    log "✅ 用户已确认风险并继续安装"
else
    log "✅ 未检测到与其他模块的冲突，继续安装"
fi


#解压
ui_print ""
ui_print "  [>] 正在释放模块文件..."
unzip -o "$ZIPFILE" -x 'META-INF/*' -d "$MODPATH" >/dev/null 2>&1
UNZIP_STATUS=$?
if [ $UNZIP_STATUS -ne 0 ]; then
    ui_print "  [✗] 释放失败 (code: $UNZIP_STATUS)"
    abort "请尝试重新下载模块"
    exit 1
fi

#配置文件检测
#if [ -f "/data/adb/modules/module_CDPR/res/config.conf" ]; then
#    ui_print "[>] 检测到旧配置..."
#    #ui_print "[+] 是否保留旧配置？"
#    TIMEOUT=20
#    reserve=""
#    ui_print "请20秒内选择是否保留旧配置："
#    ui_print "音量+：保留"
#    ui_print "音量-：不保留"
#    ui_print "超时默认选择保留"

#    start_time=$(date +%s)

#    if command -v getevent >/dev/null 2>&1; then
#        while [ $(($(date +%s) - start_time)) -lt $TIMEOUT ]; do
#            key_event=$(getevent -qlc 1 2>/dev/null | awk '/KEY_VOLUME/ {print $3}')
#            if [ "$key_event" = "KEY_VOLUMEUP" ]; then
#                reserve=1
#                break
#            elif [ "$key_event" = "KEY_VOLUMEDOWN" ]; then
#               reserve=0
#               break
#            fi
#            sleep 0.1
#        done
#    else
#        echo "警告: getevent 不可用，默认保留"
#    fi

#    if [ -z "$reserve" ]; then
#        reserve=1
#        echo "超时，使用默认选择：保留"
#    fi
#    if [ "$reserve" = 1 ]; then
#        echo "选择结果：保留"
#    else
#        echo "选择结果：不保留"
#    fi
#    echo ""
#    sleep 1
#else
#    reserve=0
#fi

#if [ "$reserve" != 1 ]; then
#    unzip -o "$ZIPFILE" "res/config.conf" -d "$MODPATH" >/dev/null 2>&1
#fi
    

#权限设置
set_perm_recursive $MODPATH 0 0 0755 0644

set_perm $MODPATH/service.sh 0 0 0755
set_perm $MODPATH/main.sh 0 0 0755
set_perm $MODPATH/post-fs-data.sh 0 0 0755
set_perm $MODPATH/uninstall.sh 0 0 0755
set_perm $MODPATH/res/config_helper.sh 0 0 0755
set_perm $MODPATH/res/check_frequency.sh 0 0 0755

ui_print "权限设置完成！"
ui_print "[ C1.3.1 更新内容 ]"
ui_print "  ► 修复Sukisu系管理器WebUI异常的问题"
ui_print "  ► 重构多处代码，优化效率并减少开销"
ui_print "  ► 重构WebUI界面和后端逻辑"
ui_print "  ► 尝试修复部分已知问题"
ui_print "  ► 吃了两碗大米饭，配菜是西红柿炒鸡蛋"
ui_print ""
ui_print "  [✓] 安装完成，重启后生效"


