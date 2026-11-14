#!/system/bin/sh
SCRIPT_DIR="$(dirname "$0")"
CONFIG_HELPER="$SCRIPT_DIR/config_helper.sh"
VIBRATE=1   # 默认启用震动
MESSAGE=0   # 默认不启用通知

# 读取 VIBRATE 和 MESSAGE 配置
if [ -f "$CONFIG_HELPER" ]; then
    tmp_vibrate="$(sh "$CONFIG_HELPER" get VIBRATE)"
    [ -n "$tmp_vibrate" ] && VIBRATE="$tmp_vibrate"

    tmp_message="$(sh "$CONFIG_HELPER" get MESSAGE)"
    [ -n "$tmp_message" ] && MESSAGE="$tmp_message"
fi

# 震动
send_notice() {
    local title="$1"
    local text="$2"
    [ "$VIBRATE" = "0" ] && return

    # 物理震动反馈
    if [ "$text" = "限频已解除，系统接管" ]; then
        # 游戏模式：两次短震动（45ms）
        su -c "cmd vibrator_manager synced oneshot 45"
        sleep 0.1
        su -c "cmd vibrator_manager synced oneshot 45"
    else
        # 日常模式：一次稍长震动（120ms）
        su -c "cmd vibrator_manager synced oneshot 120"
    fi
}

# 通知
notification_simulation() {
    local title="${1}"
    local text="${2}"
    [ "$MESSAGE" != "1" ] && return

    if test "$(pm list package | grep -w "com.google.android.ext.services")" != ""; then
        cmd notification allow_assistant "com.google.android.ext.services/android.ext.services.notification.Assistant"
    fi
    
    test -z "${title}" && title="晨夕敛光"
    test -z "${text}" && text="您未给出任何信息"

    su 2000 -c "cmd notification post -S messaging --conversation \"${title}\" --message \"${title}\":\"${text}\" \"Tag\" \"$(echo \$RANDOM)\"" >/dev/null 2>&1
}

# 主入口
if [ $# -lt 1 ]; then
    echo "Usage: $0 <title> [text]"
    exit 1
fi

TITLE="$1"
TEXT="${2:-}"   # 若未提供文本则置空

send_notice "$TITLE" "$TEXT"

notification_simulation "$TITLE" "$TEXT"