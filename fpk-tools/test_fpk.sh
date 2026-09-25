#!/bin/bash
### fpk 功能自检：假 docker + 模拟飞牛 TRIM_* 环境，把 cmd 脚本真跑一遍（技能·七）
### 用法：bash test_fpk.sh [path/to/xxx.fpk]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FPK="${1:-}"
# ⚠️ 别用 mktemp -d：git-bash 里它返回 Windows 路径，tar -C 会被 MSYS 转换搞坏
#    （症状：tar: C\:\\Users\\...\\tmp.xxx: Cannot open）。用项目内的固定目录。
WORK="$(cd "${HERE}/.." && pwd)/_fpktest"
rm -rf "${WORK}"
APPDEST="$WORK/appdest"
PKGETC="$WORK/etc"
LOG="$WORK/err.log"
FAILED=0

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILED=$((FAILED+1)); }

[ -n "${FPK}" ] || FPK="$(ls "${HERE}/../dist"/cigpricersync-*.fpk 2>/dev/null | sort -V | tail -1)"
[ -f "${FPK}" ] || { echo "错误：找不到 fpk"; exit 1; }
echo "== 功能自检：${FPK} =="

mkdir -p "${APPDEST}" "${PKGETC}"

# ── 1. 解包 ──
tar -xzf "${FPK}" -C "${WORK}" || { echo "解包失败"; exit 1; }
[ -f "${WORK}/manifest" ] && [ -f "${WORK}/app.tgz" ] || { echo "包结构缺失"; exit 1; }
tar -xzf "${WORK}/app.tgz" -C "${APPDEST}"

# ── 2. 原文契约：APP_DIR 写死 /var/apps（只在测试副本里改写）──
if grep -q 'APP_DIR="/var/apps/\${TRIM_APPNAME}"' "${WORK}/cmd/common"; then
    pass "common 里 APP_DIR 指向 /var/apps（契约）"
else
    fail "common 里 APP_DIR 不是 /var/apps"
fi
mkdir -p "${WORK}/appdir"
sed -i "s|^APP_DIR=.*|APP_DIR=\"${WORK}/appdir\"|" "${WORK}/cmd/common"

# ── 3. 假 docker（镜像存在与否用 marker 文件表达：load 时 touch，inspect 时检查）──
export FAKE_IMG_MARK="${WORK}/fake-image-loaded"
rm -f "${FAKE_IMG_MARK}"
docker() {
    local args=("$@") sub="" i=1
    if [ "${args[0]}" = "compose" ]; then
        while [ $i -lt ${#args[@]} ]; do
            case "${args[$i]}" in
                -f|--file|-p|--project-name) i=$((i+2)) ;;
                *) sub="${args[$i]}"; break ;;
            esac
        done
        case "$sub" in
            build)   echo "[fake] compose build"; touch "${FAKE_IMG_MARK}"; return 0 ;;
            up)      echo "[fake] compose up"; return 0 ;;
            version) return 0 ;;
            *)       return 0 ;;
        esac
    fi
    case "${args[0]}" in
        image)
            if [ -f "${FAKE_IMG_MARK}" ]; then return 0; else return 1; fi ;;
        load)
            echo "[fake] docker load"; touch "${FAKE_IMG_MARK}"; return 0 ;;
        container) return 0 ;;
        inspect)   echo "true"; return 0 ;;
        start|stop|rm) return 0 ;;
        *)         return 0 ;;
    esac
}
export -f docker 2>/dev/null || true

# ── 4. 模拟飞牛环境 ──
export TRIM_APPNAME=cigpricersync
export TRIM_APPDEST="${APPDEST}"
export TRIM_PKGETC="${PKGETC}"
export TRIM_TEMP_LOGFILE="${LOG}"
export wizard_port=9090
unset wizard_sync_key wizard_base_image 2>/dev/null || true
mkdir -p "${APPDEST}/ui"
echo '{ ".url": { "x": { "port": "8080" } } }' > "${APPDEST}/ui/config"

# ── 5. 首次安装 ──
bash "${WORK}/cmd/install_callback" > "${WORK}/install.out" 2>&1
if [ $? -eq 0 ]; then pass "install_callback 退出 0"; else fail "install_callback 退出非0（看 ${WORK}/install.out）"; fi

COMPOSE="${APPDEST}/cigpricer-sync-compose.yaml"
[ -f "${COMPOSE}" ] && pass "生成了 compose（app 根目录、非探测路径）" || fail "没生成 compose"
# 探测路径检查看的是【文件位置】，不是内容（compose 注释里合法地提到过那个名字）
if [ -e "${APPDEST}/docker" ]; then fail "appdest 里出现了 docker/ 目录（会被 appcenter 接管）"; else pass "compose 路径避开探测（app 根目录、无 docker/）"; fi
grep -q "9090:8080" "${COMPOSE}" && pass "端口用了向导值 9090" || fail "端口不是 9090"
grep -q "image: cigpricer-sync:latest" "${COMPOSE}" && pass "compose 用离线镜像 tag" || fail "compose 镜像 tag 不对"
grep -q "build:" "${COMPOSE}" && fail "compose 还有 build 段（离线路线不应有）" || pass "compose 无 build 段（纯 image）"
[ -f "${APPDEST}/image/cigpricer-sync-image.tar.gz" ] \
    && pass "离线镜像包随包安装" || fail "appdest 里没有镜像包"
grep -q "SYNC_KEY=" "${COMPOSE}" && pass "SYNC_KEY 已写入 compose" || fail "SYNC_KEY 缺失"
KEY="$(sed -n 's/.*SYNC_KEY="\([^"]*\)".*/\1/p' "${COMPOSE}")"
[ -n "${KEY}" ] && pass "SYNC_KEY 自动生成非空" || fail "SYNC_KEY 为空"
grep -q '"port": "9090"' "${APPDEST}/ui/config" && pass "ui/config 桌面端口已同步" || fail "ui/config 端口没改"
[ -f "${WORK}/appdir/shares/cigpricersync/data/SYNC_KEY.txt" ] \
    && pass "SYNC_KEY.txt 已写到数据目录" || fail "SYNC_KEY.txt 缺失"
[ -f "${PKGETC}/cigpricersync.conf" ] && pass "conf 已持久化" || fail "conf 缺失"

# ── 6. 改配置：留空 = 保持原值（坑14）──
export wizard_port=""
export wizard_sync_key=""
bash "${WORK}/cmd/config_callback" > "${WORK}/config.out" 2>&1
if [ $? -eq 0 ]; then pass "config_callback 退出 0"; else fail "config_callback 退出非0"; fi
grep -q "9090:8080" "${COMPOSE}" && pass "config 留空端口保持 9090" || fail "config 后端口被打回默认"
if grep -q "SYNC_KEY=\"${KEY}\"" "${COMPOSE}"; then pass "config 留空密钥保持不变"; else fail "config 后密钥被换"; fi

# ── 7. main 起停与状态 ──
bash "${WORK}/cmd/main" status >/dev/null 2>&1
[ $? -eq 0 ] && pass "main status 运行中 exit 0" || fail "main status 应 exit 0"
bash "${WORK}/cmd/main" stop >/dev/null 2>&1 && pass "main stop 退出 0" || fail "main stop 失败"
bash "${WORK}/cmd/main" bogus >/dev/null 2>&1
[ $? -eq 1 ] && pass "main 未知子命令 exit 1" || fail "main 未知子命令应 exit 1"

# ── 8. 升级：沿用配置 + 强制重建 ──
bash "${WORK}/cmd/upgrade_callback" > "${WORK}/upgrade.out" 2>&1
if [ $? -eq 0 ]; then pass "upgrade_callback 退出 0"; else fail "upgrade_callback 退出非0（看 ${WORK}/upgrade.out）"; fi
grep -q "9090:8080" "${COMPOSE}" && pass "升级后端口仍是 9090" || fail "升级后配置丢了"

# ── 9. 卸载 ──
bash "${WORK}/cmd/uninstall_callback" >/dev/null 2>&1 && pass "uninstall_callback 退出 0" || fail "uninstall 失败"

# ── 10. 向导双前缀命名兼容（坑18）──
export wizard_wizard_port=7777
unset wizard_port 2>/dev/null || true
bash "${WORK}/cmd/config_callback" > "${WORK}/config2.out" 2>&1
grep -q "7777:8080" "${COMPOSE}" && pass "wizard_wizard_ 前缀也能读到" || fail "双前缀命名被忽略"

echo ""
if [ ${FAILED} -eq 0 ]; then
    echo "== 功能自检全部通过 =="
else
    echo "== 功能自检有 ${FAILED} 项失败 =="
    echo "现场保留在 ${WORK}"
fi
exit $((FAILED > 0))
