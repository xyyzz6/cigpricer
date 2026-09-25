#!/usr/bin/env python3
"""fpk 结构性校验（发包前机械检查清单）。

用法：python verify_fpk.py [path/to/xxx.fpk]
"""
import hashlib
import io
import json
import re
import sys
import tarfile


def main(src: str) -> None:
    ok = True

    def check(name, cond, extra=""):
        nonlocal ok
        print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra else ""))
        if not cond:
            ok = False

    with tarfile.open(src, "r:gz") as t:
        members = t.getmembers()
        blobs = {}
        for m in members:
            if m.isfile():
                f = t.extractfile(m)
                blobs[m.name] = f.read() if f else b""

    names = [m.name for m in members]

    # ── 结构齐全 ──
    for req in ("manifest", "app.tgz", "ICON.PNG", "ICON_256.PNG"):
        check(f"顶层含 {req}", req in names)
    for d in ("cmd/", "config/", "wizard/"):
        check(f"含 {d}", any(n.startswith(d) for n in names))

    # ── cmd/* 权限 0755 ──
    badperm = [m.name for m in members
               if m.name.startswith("cmd/") and m.isfile() and (m.mode & 0o111) == 0]
    check("cmd/* 都有执行位(0755)", not badperm, ",".join(badperm[:3]))

    # ── checksum 一致 ──
    manifest = blobs.get("manifest", b"").decode("utf-8", "replace")
    msum = re.search(r"checksum\s*=\s*([0-9a-fA-F]{32})", manifest)
    actual = hashlib.md5(blobs["app.tgz"]).hexdigest()
    check("manifest.checksum == md5(app.tgz)",
          bool(msum) and msum.group(1).lower() == actual,
          f"manifest={msum.group(1) if msum else None} actual={actual}")

    # ── app.tgz 内部 ──
    with tarfile.open(fileobj=io.BytesIO(blobs["app.tgz"]), mode="r:gz") as a:
        amembers = a.getmembers()
        ablobs = {}
        for m in amembers:
            if m.isfile():
                f = a.extractfile(m)
                ablobs[m.name] = f.read() if f else b""
    anames = [m.name for m in amembers]
    atop = sorted({n.split("/")[0] for n in anames})
    check("app.tgz 顶层不含 docker/（坑16b）", "docker" not in atop, str(atop))
    check("app.tgz 顶层不含 src/（离线镜像路线已不需要）", "src" not in atop, str(atop))
    for d in ("image", "ui", "config"):
        check(f"app.tgz 顶层含 {d}/", d in atop, str(atop))

    # ── 离线镜像包：docker load 能吃的 gzip tar，tag 正确 ──
    img = ablobs.get("image/cigpricer-sync-image.tar.gz")
    check("app.tgz 含 image/cigpricer-sync-image.tar.gz", img is not None)
    if img:
        try:
            with tarfile.open(fileobj=io.BytesIO(img), mode="r:gz") as it:
                inames = it.getnames()
                imanifest = json.loads(
                    it.extractfile("manifest.json").read().decode())
                icfg = json.loads(
                    it.extractfile(imanifest[0]["Config"]).read().decode())
            check("镜像包 manifest.json 合法", isinstance(imanifest, list)
                  and len(imanifest) == 1)
            check("镜像 tag == cigpricer-sync:latest",
                  imanifest[0].get("RepoTags") == ["cigpricer-sync:latest"],
                  str(imanifest[0].get("RepoTags")))
            check("镜像包含配置与层文件",
                  imanifest[0]["Config"] in inames
                  and all(l in inames for l in imanifest[0]["Layers"]))
            check("镜像 Cmd 为 node server.js，含 PORT/DATA_DIR 环境变量",
                  icfg.get("config", {}).get("Cmd") == ["node", "server.js"]
                  and any(e.startswith("PORT=") for e in icfg["config"].get("Env", []))
                  and any(e.startswith("DATA_DIR=") for e in icfg["config"].get("Env", [])))
            check("镜像 diff_ids 数 == 层数",
                  len(icfg["rootfs"]["diff_ids"]) == len(imanifest[0]["Layers"]))
        except Exception as e:
            check(f"镜像包可解析（gzip tar）", False, str(e))

    # ── config/resource 不声明 docker-project（坑16）──
    res = blobs.get("config/resource", b"").decode("utf-8", "replace")
    check("config/resource 无 docker-project", "docker-project" not in res)

    # ── privilege 必须 root 运行（package 用户不在 docker 组，碰不了 docker.sock）──
    try:
        priv = json.loads(blobs.get("config/privilege", b"{}").decode("utf-8"))
        check("config/privilege run-as = root（docker 应用必须）",
              priv.get("defaults", {}).get("run-as") == "root",
              str(priv.get("defaults", {}).get("run-as")))
    except Exception as e:
        check("config/privilege 可解析", False, str(e))

    # ── cmd/main 真的起停容器（坑16：没有 docker-project 时 appcenter 不代劳）──
    main = blobs.get("cmd/main", b"").decode("utf-8", "replace")
    check("cmd/main start 有 docker start", "docker start" in main)
    check("cmd/main stop 有 docker stop", "docker stop" in main)
    check("cmd/main status 用 State.Running 判断", ".State.Running" in main)

    # ── 离线镜像路线的关键断言 ──
    common = blobs.get("cmd/common", b"").decode("utf-8", "replace")
    check("cmd/common 用 docker load 导入离线镜像", "docker load -i" in common)
    check("cmd/common 不再 compose build / ensure_image 残留",
          "compose build" not in common and "ensure_image" not in common)
    check("cmd/common 修了 HOME 不可写（DOCKER_CONFIG 指到数据目录）",
          'export HOME=' in common and 'export DOCKER_CONFIG=' in common)
    check("cmd/common 无 BASE_IMAGE 残留", "BASE_IMAGE" not in common)
    install_cb = blobs.get("cmd/install_callback", b"").decode("utf-8", "replace")
    upgrade_cb = blobs.get("cmd/upgrade_callback", b"").decode("utf-8", "replace")
    check("install_callback 调 load_image", "load_image 0" in install_cb)
    check("upgrade_callback 强制重导镜像", "load_image 1" in upgrade_cb)

    # ── CRLF ──
    crlf = [n for n in blobs if n.startswith("cmd/") and b"\r\n" in blobs[n]]
    check("cmd/* 无 CRLF", not crlf, ",".join(crlf[:3]))

    # ── wizard JSON 合法且 rules 是数组（坑10）──
    for w in ("wizard/install", "wizard/config"):
        try:
            data = json.loads(blobs[w].decode("utf-8"))
            for step in data:
                for it in step.get("items", []):
                    if "rules" in it:
                        assert isinstance(it["rules"], list), "rules 必须是数组"
            check(f"{w} JSON 合法且 rules 是数组", True)
        except Exception as e:
            check(f"{w} JSON 合法", False, str(e))

    print()
    print("全部通过" if ok else "存在失败项")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1])
