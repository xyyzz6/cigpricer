# -*- coding: utf-8 -*-
"""通用跑命令并落日志（避开 PowerShell 重定向的编码坑）

用法：python tools/_run.py <日志文件> <命令> [参数...]
"""
import subprocess, sys, os

log = sys.argv[1]
cmd = sys.argv[2:]
# 子进程自己也要用 utf-8 输出
env = dict(os.environ)
env['PYTHONIOENCODING'] = 'utf-8'
env['PYTHONUTF8'] = '1'
r = subprocess.run(cmd, capture_output=True, env=env, cwd=r'E:\boki\cigpricer')
txt = ''
if r.stdout:
    txt += r.stdout.decode('utf-8', 'replace')
if r.stderr:
    txt += '\n--- stderr ---\n' + r.stderr.decode('utf-8', 'replace')
txt += '\n--- exit=%d ---\n' % r.returncode
open(log, 'w', encoding='utf-8').write(txt)
print('exit=%d -> %s' % (r.returncode, log))
