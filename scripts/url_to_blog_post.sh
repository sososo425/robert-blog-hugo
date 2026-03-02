#!/usr/bin/env bash
# 调用 my_tools 的 url_to_hugo_post，将 URL 转为本站文章。
# 用法: ./scripts/url_to_blog_post.sh "<URL>" [section] [subsection] [slug]
# 需设置 MY_TOOLS_PATH 或使用默认 ~/Documents/workspace/my_tools

set -e
BLOG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MY_TOOLS="${MY_TOOLS_PATH:-$HOME/Documents/workspace/my_tools}"

if [ ! -f "$MY_TOOLS/url_to_hugo_post.py" ]; then
  echo "未找到 my_tools：$MY_TOOLS"
  echo "请设置 MY_TOOLS_PATH 或在本机安装 my_tools（含 url_to_hugo_post.py）"
  exit 1
fi

PYTHON="$MY_TOOLS/venv/bin/python"
[ -x "$PYTHON" ] || PYTHON="python3"

exec "$PYTHON" "$MY_TOOLS/url_to_hugo_post.py" "$1" "$BLOG_ROOT" "${2:-tech}" "${3:-}" "${4:-}"
