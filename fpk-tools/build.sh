#!/bin/bash
### 烟价速查同步服务 —— 飞牛 fnOS fpk 打包脚本（在 Git Bash 中运行）
###
### 用法：./build.sh
### 产物：dist/cigpricersync-<版本>.fpk  +  dist/deploy-pkg/（兜底部署包）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FPK_DIR="${PROJ_ROOT}/fpk"
OUT_DIR="${PROJ_ROOT}/dist"
IMG_TAR="${FPK_DIR}/app/image/cigpricer-sync-image.tar.gz"

FNPACK="${SCRIPT_DIR}/fnpack.exe"
PYBIN="${PROJ_ROOT}/.venv/Scripts/python.exe"

[ -f "${FNPACK}" ] || { echo "错误：找不到 ${FNPACK}"; exit 1; }
[ -f "${PYBIN}" ] || { echo "错误：找不到 Python ${PYBIN}"; exit 1; }

VERSION="$(grep '^version' "${FPK_DIR}/manifest" | sed 's/.*=[[:space:]]*//' | tr -d '[:space:]')"
[ -n "${VERSION}" ] || { echo "错误：无法从 manifest 解析 version"; exit 1; }

echo "[build] 应用版本 : ${VERSION}"

# ── 0. 离线镜像包（不联网安装的关键）：缺失或比源码旧就重新组装 ──────────
#    make_image.py 层 blob 有缓存，重复跑不重新下载；server.js/index.html
#    变了会自动重打应用层。
NEED_IMG=0
if [ ! -f "${IMG_TAR}" ]; then
    NEED_IMG=1
elif [ "${PROJ_ROOT}/server/server.js" -nt "${IMG_TAR}" ] \
        || [ "${PROJ_ROOT}/build/index.html" -nt "${IMG_TAR}" ]; then
    NEED_IMG=1
fi
if [ "${NEED_IMG}" = "1" ]; then
    echo "[build] 离线镜像包缺失或过期，重新组装（首次会下载 ~48MB 基础层）..."
    "${PYBIN}" "${SCRIPT_DIR}/make_image.py" || { echo "错误：make_image.py 失败"; exit 1; }
else
    echo "[build] 离线镜像包已就绪：$(du -h "${IMG_TAR}" | cut -f1)"
fi

# 旧路线的残留（安装时就地构建镜像）——现在镜像全离线内置，源码/Dockerfile 不进包
rm -rf "${FPK_DIR}/app/src"

# ── 1. 注入镜像 tag（cmd/common 里的 IMAGE 变量；compose 由 cmd 脚本在安装时生成）──
sed -i "s|^IMAGE=.*|IMAGE=\"cigpricer-sync:latest\"|" "${FPK_DIR}/cmd/common"

# ⚠️ 确保包里【绝对不存在】app/docker/。
#    飞牛 appcenter 会按约定路径探测 docker 项目，一旦发现 app/docker/docker-compose.yaml，
#    安装时就会替我们执行 docker compose pull，而 image: cigpricer-sync:latest 是 NAS
#    本地构建的 tag，远端不存在，安装必然失败。（坑 16 / 16b）
rm -rf "${FPK_DIR}/app/docker"

# ── 3. 换行符统一为 LF（CRLF 会让 Linux 报 bad interpreter）──────────────
while IFS= read -r f; do
    if grep -q $'\r' "$f" 2>/dev/null; then
        tr -d '\r' < "$f" > "${f}.lf" && mv "${f}.lf" "$f"
        echo "[build] CRLF -> LF: ${f#"${FPK_DIR}/"}"
    fi
done < <(find "${FPK_DIR}/cmd" "${FPK_DIR}/config" "${FPK_DIR}/wizard" \
              "${FPK_DIR}/app/ui" -type f \
              ! -name "*.png" ! -name "*.PNG" 2>/dev/null)

# ── 4. 打包 ──────────────────────────────────────────────────────────────
mkdir -p "${OUT_DIR}"
TARGET="${OUT_DIR}/cigpricersync-${VERSION}.fpk"
rm -f "${TARGET}" "${OUT_DIR}/cigpricersync.fpk"

(cd "${OUT_DIR}" && "${FNPACK}" build -d "${FPK_DIR}") || {
    echo "错误：fnpack 打包失败"
    exit 1
}

BUILT="${OUT_DIR}/cigpricersync.fpk"
[ -f "${BUILT}" ] || { echo "错误：未找到 fnpack 产物 ${BUILT}"; exit 1; }
mv -f "${BUILT}" "${TARGET}"

# ── 5. 修正顶层权限位（Windows 打出来是 0666，Linux 上无法执行）──────────
"${PYBIN}" "${SCRIPT_DIR}/fix_perm.py" "${TARGET}" || { echo "错误：权限修正失败"; exit 1; }

# ── 6. 兜底部署包（应用中心装不上时的 Plan B，见 deploy/ 说明）───────────
PKG="${OUT_DIR}/deploy-pkg"
rm -rf "${PKG}"
mkdir -p "${PKG}/public"
cp "${PROJ_ROOT}/server/server.js" "${PKG}/"
cp "${PROJ_ROOT}/build/index.html" "${PKG}/public/"
cp "${PROJ_ROOT}/deploy/compose-standalone.yml" "${PKG}/"
cp "${PROJ_ROOT}/deploy/fnos-install.sh" "${PKG}/"
cp "${PROJ_ROOT}/deploy/README.txt" "${PKG}/" 2>/dev/null || true

echo ""
echo "[build] 完成：${TARGET}  ($(du -h "${TARGET}" | cut -f1))"
echo "[build] 兜底：${PKG}  （应用中心装不上时用，见里面 README.txt）"
echo "[build] 安装：飞牛「应用中心」→ 右上角「手动安装」→ 选择该 fpk"
