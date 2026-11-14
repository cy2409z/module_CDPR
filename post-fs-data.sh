#!/system/bin/sh
MODDIR=${0%/*}
#STATE_FILE="$MODDIR/current_state"

#write_lock() {
#    local node="$1"
#    local val="$2"
#    if [ -f "$node" ]; then
#        chmod 644 "$node" 2>/dev/null
#        echo "$val" > "$node" 2>/dev/null
#    fi
#}

#for cpu in /sys/devices/system/cpu/cpu[0-7]*; do
#    [ -f "$cpu/online" ] && echo 1 > "$cpu/online" 2>/dev/null
#done

#write_lock "/sys/devices/system/cpu/cpufreq/policy0/scaling_max_freq" 2266000
#write_lock "/sys/devices/system/cpu/cpufreq/policy6/scaling_max_freq" 1651000

#write_lock "/sys/class/kgsl/kgsl-3d0/max_gpuclk" 500000000
#write_lock "/sys/class/kgsl/kgsl-3d0/max_pwrlevel" 13

#echo "normal" > "$STATE_FILE"

target="config_helper.sh logger.sh notify.sh"
missing_files=""

for file in $target; do
    if [ ! -f "$MODDIR/scripts/$file" ]; then
        missing_files="${missing_files}${file} "
    fi
done

if [ ! -z "$missing_files" ]; then
    echo "[$(/system/bin/date +%Y-%m-%d\ %H:%M:%S)] 缺少关键文件:${missing_files% }" >> "$LOG_FILE"
    #echo "Warning" >> "$MODDIR/res/daemon.pid"
fi
