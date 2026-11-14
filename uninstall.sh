#!/system/bin/sh
# 卸载时恢复默认频率
write() {
    local node="$1"
    local val="$2"
    if [ -f "$node" ]; then
        chmod 644 "$node" 2>/dev/null
        echo "$val" > "$node" 2>/dev/null
    fi
}

for cpu in /sys/devices/system/cpu/cpu[0-7]*; do
    [ -f "$cpu/online" ] && echo 1 > "$cpu/online" 2>/dev/null
done

write "/sys/devices/system/cpu/cpufreq/policy0/scaling_max_freq" 3321600
write "/sys/devices/system/cpu/cpufreq/policy6/scaling_max_freq" 3801600

write "/sys/class/kgsl/kgsl-3d0/max_gpuclk" 1225000000
write "/sys/class/kgsl/kgsl-3d0/max_pwrlevel" 0

kill -15 $(cat "/data/adb/modules/module_CDPR/res/module.pid")
rm "/data/adb/modules/module_CDPR/res/module.pid"
kill -15 $(cat "/data/adb/modules/module_CDPR/res/daemon.pid")
rm "/data/adb/modules/module_CDPR/res/daemon.pid"