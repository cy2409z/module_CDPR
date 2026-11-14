#!/system/bin/sh
#晨夕敛光后台守护进程
MODDIR=${0%/*}
MAINSCRIPT="$MODDIR/main.sh"
PIDFILE="$MODDIR/res/module.pid"
LOCKFILE="$MODDIR/res/daemon.pid"
CONFIG_HELPER="$MODDIR/scripts/config_helper.sh"
LOGFILE="$MODDIR/运行日志.log"

#检查是否已有监控进程在运行
if [ -f "$LOCKFILE" ]; then
    oldpid=$(cat "$LOCKFILE" 2>/dev/null)
    if kill -0 "$oldpid" 2>/dev/null; then
        exit 0
    fi
fi
echo $$ > "$LOCKFILE"   #记录当前监控进程 PID

start_main() {
    rm -f "$PIDFILE"
    sh "$MAINSCRIPT" &
    local wait=0
    while [ ! -f "$PIDFILE" ] && [ $wait -lt 50 ]; do
        sleep 0.1
        wait=$((wait + 1))
    done
}

is_running() {
    [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

remove_log() {
    if [ -f "$CONFIG_HELPER" ]; then
        MAX_SIZE="$(sh "$CONFIG_HELPER" get MAX_SIZE)"
        if [ -z "$MAX_SIZE" ]; then
            MAX_SIZE="10240"
        fi
    fi

    FILE_SIZE=$(wc -c < "$LOGFILE" 2>/dev/null | tr -d ' ')
    if [ -n "$FILE_SIZE" ] && [ "$FILE_SIZE" -gt "$MAX_SIZE" ]; then
        KEEP_SIZE=$((FILE_SIZE / 2))
        TEMP_LOG="$LOGFILE.tmp"
        tail -c "$KEEP_SIZE" "$LOGFILE" > "$TEMP_LOG" 2>/dev/null
        if [ -n "$(dd if="$LOGFILE" bs=1 skip=$((FILE_SIZE - KEEP_SIZE - 1)) count=1 2>/dev/null)" ]; then
            tail -n +2 "$TEMP_LOG" > "$TEMP_LOG.2" 2>/dev/null && mv -f "$TEMP_LOG.2" "$TEMP_LOG"
        fi
        mv -f "$TEMP_LOG" "$LOGFILE" 2>/dev/null
        rm -f "$TEMP_LOG.2"
        sh "$MODDIR/scripts/logger.sh" "已触发自动清理日志文件"
    fi
}
while [ "$(getprop sys.boot_completed)" != "1" ]; do
    sleep 5
done

start_main

(
while true; do
    sleep 1800
    R="$(sh "$CONFIG_HELPER" get MAX_SIZE)"
    if [ $R != "0" ]; then
        remove_log
    fi
done    
) &

while true; do
    if ! is_running; then
        start_main  #尝试重启服务
    fi
    sleep 30
done