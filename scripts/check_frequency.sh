#!/system/bin/sh
P0="/sys/devices/system/cpu/cpufreq/policy0"
P6="/sys/devices/system/cpu/cpufreq/policy6"
GPU="/sys/class/kgsl/kgsl-3d0"

# CPU调度模式检查函数
check_cpu_governor() {
    local policy_num="$1"
    # 定义调度器节点路径
    local gov_node="/sys/devices/system/cpu/cpufreq/policy${policy_num}/scaling_governor"
    #先判断文件是否存在
    if [ ! -f "$gov_node" ]; then
        echo "［policy${policy_num}］错误：调度器节点不存在，该CPU集群未被内核识别"
        return 1
    fi
    #读取调度器内容，屏蔽所有错误输出
    local current_gov=$(cat "$gov_node" 2>/dev/null)
    #判断读取结果是否为空，为空说明集群已关闭
    if [ -z "$current_gov" ]; then
        echo "［policy${policy_num}］核心集群已关闭"
        return 0
    fi
    # 所有检查通过，输出当前调度模式
    echo "［policy${policy_num}］当前调速器模式：${current_gov}"
    return 0
}


while true; do
    clear
    echo "======================================"
    echo "      一加 Ace6T (8Gen5) 频率实时监控"
    echo "======================================"
    
    TOP_APP=$(dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -n 1 | sed -E 's/.* ([a-zA-Z0-9.]+)\/.*/\1/')
    echo "当前前台应用: $TOP_APP"
    echo "--------------------------------------"

    if [ -f "$P0/scaling_max_freq" ]; then
        P0_MAX=$(cat "$P0/scaling_max_freq" 2>/dev/null)
        P0_CUR=$(cat "$P0/scaling_cur_freq" 2>/dev/null)
        echo "大核集群 (Policy 0):"
        echo "  当前限制上限: $((P0_MAX / 1000)) MHz"
        echo "  实时运行频率: $((P0_CUR / 1000)) MHz"
    fi
    check_cpu_governor 0

    if [ -f "$P6/scaling_max_freq" ]; then
        P6_MAX=$(cat "$P6/scaling_max_freq" 2>/dev/null)
        P6_CUR=$(cat "$P6/scaling_cur_freq" 2>/dev/null)
        echo "超大核集群 (Policy 6):"
        echo "  当前限制上限: $((P6_MAX / 1000)) MHz"
        echo "  实时运行频率: $((P6_CUR / 1000)) MHz"
    fi
    check_cpu_governor 6

    if [ -d "$GPU" ]; then
        GPU_MAX=$(cat "$GPU/max_gpuclk" 2>/dev/null)
        GPU_CUR=$(cat "$GPU/gpuclk" 2>/dev/null)
        
        echo "GPU (Adreno 829):"
        echo "  当前限制上限: $((GPU_MAX / 1000000)) MHz"
        echo "  实时运行频率: $((GPU_CUR / 1000000)) MHz"
    fi
    
    echo "======================================"
    echo "按 Ctrl+C 退出监控 (每秒刷新)"
    sleep 1
done