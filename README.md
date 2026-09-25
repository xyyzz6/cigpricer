# 烟价速查（cigpricer）

给烟酒店老板用的**价目表查询工具**：把纸质价目表拍张照，自动切成一个个商品小图；店员想查价，输入商品名（或点快捷品牌）立刻弹出对应的价目表切片——**看到的就是原表原样**，不用录数据库、不怕录错价。

## 组成

| 部分 | 说明 |
|---|---|
| **手机 App**（`cigpricer.apk`） | Android WebView 单页应用，完全离线可用。见 [Releases](../../releases) |
| **单文件网页版**（`build/烟价速查.html`） | 双击就能用的单 HTML 文件，数据存浏览器 |
| **飞牛同步服务**（`cigpricersync.fpk`） | 飞牛 fnOS 应用，自托管同步服务器，多设备间数据同步 |
| **通用 Node 服务**（`server/`） | 零依赖（纯 Node 标准库）的同步服务器，Docker Compose 也可部署 |

## 功能

- 📷 **拍照加表**：价目表照片自动切格成商品，无需 OCR 也能用（格子按序号命名，看图改名即可）
- 🔍 **秒搜价格**：输入商品名直接弹出原表切片，点击放大、左右滑动翻页
- 🏷️ **快捷搜索自定义**：首页那排品牌快捷词可增可删（点「编辑」），改动保存在本机
- 📋 **多表管理**：多张价目表并存，支持表改名、换照片（同表换新价）、导入/导出表包
- ☁️ **自动同步**：启用同步后，改动约 5 秒内自动上传、每 60 秒自动拉取，多设备免手动
- 🔒 **注册用户鉴权**：用户名/密码注册登录（30 天免登录），也兼容旧版共享密钥
- 🌐 **联网认字（可选）**：接 OpenAI 兼容 API 把照片格子自动认成商品名（支持百炼/火山/硅基流动/智谱/Gemini 等）

## 目录结构

```
tools/            构建源（app_template.html 模板 + build_app.py 打包器 + smoke 冒烟测试）
build/            构建产物（烟价速查.html 单文件版 + index.html 服务器托管副本）
server/           同步服务器（零依赖 Node）+ 网页版托管
android/          无 Gradle APK 构建链（build.js → verify.js → acceptance.js）
fpk/ + fpk-tools/ 飞牛 fpk 打包（离线内置 Docker 镜像）与自检脚本
tables/           价目表数据源（构建期内嵌进单文件版）
recognizer/       联网认字页（可独立部署）
_diag/            诊断 / e2e 测试脚本
```

## 构建

```bash
# 单文件网页版（需要 tables/ 数据源）
python tools/build_app.py

# 冒烟测试（Edge 无头，237 项断言）
NODE_PATH=<node_modules> node tools/smoke.js

# APK（无 Gradle：JDK17 + Android SDK，先 debug 包录点位再正式包验收）
node android/build.js --debug --no-bump
node android/verify.js
node android/build.js
node android/acceptance.js

# 飞牛 fpk
bash fpk-tools/build.sh
python fpk-tools/verify_fpk.py dist/cigpricersync-x.x.x.fpk
bash fpk-tools/test_fpk.sh dist/cigpricersync-x.x.x.fpk
```

## 同步服务部署

**飞牛**：应用中心 → 手动安装 `cigpricersync-*.fpk`（镜像内置、全程离线）。

**通用 Docker**：

```bash
cd server && docker compose up -d
```

首次配置：网页版/ App 的「管理 → 数据同步」里填服务器地址，注册用户名密码即可。服务端 `secret.key` 首次启动自动生成（换掉它会让所有登录失效）。

## License

仅供个人/店内使用。
