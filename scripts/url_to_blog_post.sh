#!/usr/bin/env bash
# 调用仓库内 tools/url-to-blog-post 的 url_to_hugo_post，将 URL 转为本站文章。
# 用法: ./scripts/url_to_blog_post.sh "<URL>" [section] [subsection] [slug]
# 环境变量:
#   FETCH_MODE=auto|requests|playwright  抓取模式 (默认: auto)
#   PROXY=http://host:port               代理地址
#   HEADLESS=0|1                         Playwright 无头模式 (默认: 1)

set -e
BLOG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="$BLOG_ROOT/tools/url-to-blog-post"

if [ ! -f "$TOOLS_DIR/url_to_hugo_post.py" ]; then
  echo "未找到工具脚本：$TOOLS_DIR/url_to_hugo_post.py"
  echo "请确认已从 Git 仓库完整拉取 tools/url-to-blog-post 目录。"
  exit 1
fi

cd "$TOOLS_DIR"

# 导出环境变量供 Python 脚本使用
export FETCH_MODE="${FETCH_MODE:-auto}"
export PROXY="${PROXY:-}"
export HEADLESS="${HEADLESS:-1}"

exec python3 "$TOOLS_DIR/url_to_hugo_post.py" "$1" "$BLOG_ROOT" "${2:-tech}" "${3:-}" "${4:-}"
