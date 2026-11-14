#!/system/bin/sh
MODDIR="/data/adb/modules/module_CDPR"
CONFIG_FILE="$MODDIR/res/config.conf"

# 读取配置
# 用法: sh config_helper.sh get <KEY>
get_config() {
    grep "^$1=" "$CONFIG_FILE" | head -1 | cut -d '=' -f 2-
}

# 写入配置
# 用法: sh config_helper.sh set <KEY> <VALUE>
set_config() {
    local key="$1"
    local value="$2"
    local escaped_value=$(echo "$value" | sed -e 's/[&|/\]/\\&/g')
    if grep -q "^$key=" "$CONFIG_FILE"; then
        #存在则替换该行
        sed -i "s|^$key=.*|$key=$escaped_value|" "$CONFIG_FILE"
    else
        #不存在则在文件末尾追加
        echo "$key=$value" >> "$CONFIG_FILE"
    fi
}

# 入口
case "$1" in
    get)
        get_config "$2"
        ;;
    set)
        set_config "$2" "$3"
        ;;
    *)
        echo "Usage: $0 {get|set} key [value]"
        exit 1
        ;;
esac