#!/usr/bin/env python3
"""重写 fpk（tar.gz）：把 cmd/* 下的脚本权限位改成 0755。

Windows 上 fnpack 打出来的成员权限是 0666，在 Linux 上无法执行，
症状是安装时报 `Permission denied` 或 `bad interpreter`。

注意：本脚本**不改动 app.tgz 的字节内容**，因为它只重写 fpk 这一层的 tar 条目，
而 manifest 里的 checksum 算的是 app.tgz 这个文件本身的 md5，所以依然有效。
（但如果需要修 app.tgz **内部** 的权限，就必须重算 checksum，见 build.sh 的说明。）

用法：fix_perm.py <path/to/xxx.fpk>
"""
import io
import os
import sys
import tarfile

# fpk 顶层需要保持可执行的条目
EXEC_PREFIXES = ("cmd/",)


def main(src: str) -> None:
    if not os.path.isfile(src):
        print(f"[fix-perm] 找不到文件：{src}")
        sys.exit(1)

    tmp = src + ".tmp"
    with tarfile.open(src, "r:gz") as tin:
        members = tin.getmembers()
        blobs = {}
        for m in members:
            if m.isfile():
                f = tin.extractfile(m)
                blobs[m.name] = f.read() if f else b""

    changed = 0
    with tarfile.open(tmp, "w:gz") as tout:
        for m in members:
            info = tarfile.TarInfo(m.name)
            info.mtime = m.mtime
            if m.isdir():
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tout.addfile(info)
            elif m.issym() or m.islnk():
                info.type = m.type
                info.linkname = m.linkname
                info.mode = m.mode
                tout.addfile(info)
            else:
                want = 0o755 if m.name.startswith(EXEC_PREFIXES) else 0o644
                if m.mode != want:
                    changed += 1
                info.size = m.size
                info.mode = want
                tout.addfile(info, io.BytesIO(blobs[m.name]))

    os.replace(tmp, src)
    print(f"[fix-perm] 已修正 {changed} 个条目的权限位（cmd/* -> 0755）: {src}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1])
