#!/usr/bin/env bash
# 调用仓库内 tools/url-to-blog-post 的 url_to_hugo_post，将 URL 转为本站文章。
# 用法: ./scripts/url_to_blog_post.sh "<URL>" [section] [subsection] [slug]

set -e
BLOG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="$BLOG_ROOT/tools/url-to-blog-post"

if [ ! -f "$TOOLS_DIR/url_to_hugo_post.py" ]; then
  echo "未找到工具脚本：$TOOLS_DIR/url_to_hugo_post.py"
  echo "请确认已从 Git 仓库完整拉取 tools/url-to-blog-post 目录。"
  exit 1
fi

# 优先使用 tools/url-to-blog-post 下的 venv，其次回退到系统 python3
PYTHON="$TOOLS_DIR/venv/bin/python"
[ -x "$PYTHON" ] || PYTHON="python3"

exec "$PYTHON" "$TOOLS_DIR/url_to_hugo_post.py" "$1" "$BLOG_ROOT" "${2:-tech}" "${3:-}" "${4:-}"
