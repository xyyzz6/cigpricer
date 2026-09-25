#!/usr/bin/env python3
"""手工组装 cigpricer-sync 离线镜像（本机无 docker 也能做）。

原理：fpk 不再在 NAS 上构建镜像（国内 NAS 拉 node:20-alpine 经常全挂），
而是在打包机上直接从加速源下载 node:20-alpine 的 manifest/config/层 blob，
再加一层我们自己的应用层（server.js + public/index.html），组装成
`docker load` 认的 docker-save 格式 tar.gz，放进 fpk/app/image/。

产物：fpk/app/image/cigpricer-sync-image.tar.gz  （镜像 tag cigpricer-sync:latest）

层 blob 按 digest 缓存在 fpk-tools/_blobcache/，重复构建不重新下载。
仅用标准库，无第三方依赖。

用法：python make_image.py
"""
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
SRC_SERVER = os.path.join(PROJ, "server", "server.js")
SRC_INDEX = os.path.join(PROJ, "build", "index.html")
OUT_DIR = os.path.join(PROJ, "fpk", "app", "image")
OUT_FILE = os.path.join(OUT_DIR, "cigpricer-sync-image.tar.gz")
CACHE = os.path.join(HERE, "_blobcache")

BASE_REF = "library/node:20-alpine"
REPO = "library/node"
TAG = "20-alpine"
IMAGE_TAG = "cigpricer-sync:latest"

# 加速源候选链（与 fpk 安装脚本曾经的链一致，第一个能通即用）
MIRRORS = [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://docker.fnnas.com",
    "https://registry-1.docker.io",
]

ACCEPT = ", ".join([
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
])

UA = "cigpricer-make-image/1.0"


def log(msg):
    print(f"[make_image] {msg}", flush=True)


def _http_get(url, accept=None, token=None, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if accept:
        req.add_header("Accept", accept)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _anon_token(mirror, repo):
    """标准 registry 匿名 token 流程：从 401 的 WWW-Authenticate 里拿 realm。"""
    try:
        urllib.request.urlopen(
            urllib.request.Request(f"{mirror}/v2/", headers={"User-Agent": UA}),
            timeout=30)
        return None  # 不需要 token
    except urllib.error.HTTPError as e:
        ch = e.headers.get("WWW-Authenticate", "")
        m = re.match(r'Bearer\s+realm="([^"]+)"(?:,service="([^"]+)")?', ch)
        if not m:
            return None
        realm, service = m.group(1), m.group(2) or ""
        q = {"scope": f"repository:{repo}:pull"}
        if service:
            q["service"] = service
        data = _http_get(f"{realm}?{urllib.parse.urlencode(q)}")
        return json.loads(data).get("token")
    except Exception:
        return None


def fetch(url, accept=None, timeout=120):
    return _http_get(url, accept, timeout=timeout)


def fetch_with_fallback(path, accept=None, desc="", repo=None):
    """依次试镜像源；401 时按 WWW-Authenticate 走匿名 token 重试。"""
    last = None
    for m in MIRRORS:
        url = f"{m}/v2/{path}"
        for attempt in range(2):
            try:
                t0 = time.time()
                data = fetch(url, accept)
                log(f"{desc}: {m} OK ({len(data)} bytes, {time.time()-t0:.1f}s)")
                return data, m
            except urllib.error.HTTPError as e:
                last = e
                if e.code == 401 and attempt == 0 and repo:
                    tok = _anon_token(m, repo)
                    if tok:
                        try:
                            data = _http_get(url, accept, token=tok)
                            log(f"{desc}: {m} OK(token) ({len(data)} bytes)")
                            return data, m
                        except Exception as e2:
                            last = e2
                    break
                break
            except Exception as e:
                last = e
                break
        log(f"{desc}: {m} 失败 -> {last}")
    raise SystemExit(f"错误：所有镜像源都拉不到 {desc}（最后错误：{last}）")


def cached_blob(digest):
    """按 digest 取 blob（gz 原样缓存），依次试镜像源。"""
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, digest.replace(":", "_"))
    if os.path.exists(p) and os.path.getsize(p) > 0:
        with open(p, "rb") as f:
            return f.read()
    data, _ = fetch_with_fallback(f"{REPO}/blobs/{digest}",
                                  desc=f"blob {digest[:19]}", repo=REPO)
    with open(p, "wb") as f:
        f.write(data)
    return data


def gunzip_verify(blob_gz, diff_id):
    """解压层 blob 并校验解压后 sha256 == config 里的 diff_id。"""
    raw = gzip.decompress(blob_gz)
    want = diff_id.split(":", 1)[1]
    got = hashlib.sha256(raw).hexdigest()
    if got != want:
        raise SystemExit(f"错误：层解压后 sha256 与 diff_id 不符（want={want} got={got}）")
    return raw


def build_app_layer():
    """应用层：/app/server.js + /app/public/index.html（未压缩 tar）。"""
    with open(SRC_SERVER, "rb") as f:
        server_js = f.read()
    with open(SRC_INDEX, "rb") as f:
        index_html = f.read()
    if len(server_js) < 1000 or len(index_html) < 10000:
        raise SystemExit("错误：server.js / index.html 尺寸异常，先跑 build_app.py？")

    buf = io.BytesIO()
    now = int(time.time())
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT) as t:

        def add_dir(name):
            ti = tarfile.TarInfo(name)
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            ti.mtime = now
            t.addfile(ti)

        def add_file(name, data):
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            ti.mode = 0o644
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            ti.mtime = now
            t.addfile(ti, io.BytesIO(data))

        add_dir("app")
        add_file("app/server.js", server_js)
        add_dir("app/public")
        add_file("app/public/index.html", index_html)
    return buf.getvalue()


def main():
    for f in (SRC_SERVER, SRC_INDEX):
        if not os.path.exists(f):
            raise SystemExit(f"错误：缺 {f}")

    # ── 1. 拿 manifest（可能是 list，取 linux/amd64）────────────────────
    raw, _ = fetch_with_fallback(f"{REPO}/manifests/{TAG}", accept=ACCEPT,
                                 desc=f"manifest {BASE_REF}", repo=REPO)
    man = json.loads(raw)
    mt = man.get("mediaType", "")
    if "list" in mt or "index" in mt or "manifests" in man:
        pick = None
        for m in man.get("manifests", []):
            p = m.get("platform", {})
            if p.get("os") == "linux" and p.get("architecture") == "amd64" \
                    and not p.get("variant"):
                pick = m
                break
        if not pick:
            raise SystemExit("错误：manifest list 里找不到 linux/amd64")
        raw, _ = fetch_with_fallback(f"{REPO}/manifests/{pick['digest']}",
                                     accept=ACCEPT, desc="manifest amd64", repo=REPO)
        man = json.loads(raw)

    if man.get("mediaType", "") not in (
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.oci.image.manifest.v1+json"):
        raise SystemExit(f"错误：不认识的 manifest 类型 {man.get('mediaType')}")

    cfg_digest = man["config"]["digest"]
    layers = [l["digest"] for l in man["layers"]]

    # ── 2. config + 各层 ────────────────────────────────────────────────
    log(f"基础镜像 {len(layers)} 层")
    cfg_blob = cached_blob(cfg_digest)
    base_cfg = json.loads(cfg_blob)

    layer_files = []          # (archive 内文件名, 未压缩 tar 字节)
    for i, dg in enumerate(layers):
        gz = cached_blob(dg)
        raw_tar = gunzip_verify(gz, base_cfg["rootfs"]["diff_ids"][i])
        layer_files.append((f"layer_{i:03d}.tar", raw_tar))
        log(f"  层 {i}: {dg[:19]} -> {len(raw_tar)/1e6:.1f} MB 解压")

    # ── 3. 应用层 ───────────────────────────────────────────────────────
    app_tar = build_app_layer()
    app_diff = "sha256:" + hashlib.sha256(app_tar).hexdigest()
    layer_files.append(("layer_app.tar", app_tar))
    log(f"应用层: {len(app_tar)/1e3:.1f} KB  diff_id={app_diff[:27]}")

    # ── 4. 改 config：WORKDIR /app + CMD + ENV + 端口/卷 ────────────────
    cfg = base_cfg
    c = cfg.setdefault("config", {})
    c["WorkingDir"] = "/app"
    c["Cmd"] = ["node", "server.js"]
    env = [e for e in c.get("Env", [])
           if not e.startswith(("PORT=", "DATA_DIR=", "NODE_ENV="))]
    env += ["PORT=8080", "DATA_DIR=/data", "NODE_ENV=production"]
    c["Env"] = env
    ep = c.setdefault("ExposedPorts", {})
    ep["8080/tcp"] = {}
    vol = c.setdefault("Volumes", {})
    vol["/data"] = {}
    cfg["rootfs"]["diff_ids"] = list(cfg["rootfs"]["diff_ids"]) + [app_diff]
    hist = cfg.setdefault("history", [])
    hist.append({
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "created_by": "cigpricer fpk-tools/make_image.py（离线组装）",
    })
    cfg_bytes = json.dumps(cfg, separators=(",", ":"), sort_keys=False).encode()
    cfg_hex = hashlib.sha256(cfg_bytes).hexdigest()

    # ── 5. 组装 docker-save 格式 tar -> gzip ────────────────────────────
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest_json = json.dumps([{
        "Config": f"{cfg_hex}.json",
        "RepoTags": [IMAGE_TAG],
        "Layers": [n for n, _ in layer_files],
    }], separators=(",", ":")).encode()

    n_bytes = 0
    with tarfile.open(OUT_FILE, mode="w:gz", compresslevel=6) as out:
        def put(name, data):
            nonlocal n_bytes
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            ti.mode = 0o644
            ti.mtime = int(time.time())
            out.addfile(ti, io.BytesIO(data))
            n_bytes += len(data)

        put(f"{cfg_hex}.json", cfg_bytes)
        for name, data in layer_files:
            put(name, data)
        put("manifest.json", manifest_json)

    sz = os.path.getsize(OUT_FILE)
    log(f"产物: {OUT_FILE}")
    log(f"  内容 {n_bytes/1e6:.1f} MB -> 压缩后 {sz/1e6:.1f} MB  tag={IMAGE_TAG}")
    log("完成。fpk 打包会自动把它带进去（build.sh 会检查新鲜度）。")


if __name__ == "__main__":
    main()
