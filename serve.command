#!/bin/bash
# 双击运行：启动一个本地静态服务器并打开阅读页面。
# 关闭此终端窗口（或按 Control-C）即可停止服务器。

cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  echo "未找到 Python，请先安装 Python 3 后再试。"
  read -r -n 1 -s -p "按任意键关闭…"
  exit 1
fi

PORT=8000
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

URL="http://localhost:$PORT/"

printf '\n  复变函数 · 习题解答\n'
printf '  本地地址: %s\n' "$URL"
printf '  按 Control-C 停止服务器\n\n'

(sleep 1; open "$URL") &

exec "$PYTHON" -m http.server "$PORT" --bind 127.0.0.1
