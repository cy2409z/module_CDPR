#!/system/bin/sh
SCRIPT_DIR="$(dirname "$0")"
MODDIR="/data/adb/modules/module_CDPR"
CONFIG_HELPER="$SCRIPT_DIR/config_helper.sh"
LOG_FILE="$MODDIR/运行日志.log"

# 读取 WRITE_LOG 配置
# 若 config_helper.sh 不存在，则默认视为启用日志（值为1）
if [ -f "$CONFIG_HELPER" ]; then
    WRITE_LOG="$(sh "$CONFIG_HELPER" get WRITE_LOG)"
else
    WRITE_LOG=1
fi

if [ "$WRITE_LOG" != "0" ]; then
    echo "[$(/system/bin/date +%Y-%m-%d\ %H:%M:%S)] $1" >> "$LOG_FILE"
fi