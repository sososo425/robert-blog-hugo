#!/bin/bash
# Hugo 博客快速设置脚本

echo "🚀 Robert Blog Hugo 版本快速设置"
echo "================================"

# 检查 hugo
if ! command -v hugo &> /dev/null; then
    echo "❌ Hugo 未安装，请先安装 Hugo:"
    echo "   brew install hugo"
    echo "   或访问: https://github.com/gohugoio/hugo/releases"
    exit 1
fi

echo "✅ Hugo 已安装: $(hugo version)"

# 初始化 git
echo "📝 初始化 Git 仓库..."
git init

# 添加 PaperMod 主题
echo "🎨 添加 PaperMod 主题..."
git submodule add --depth=1 https://github.com/adityatelange/hugo-PaperMod.git themes/PaperMod

# 本地预览
echo "🌐 启动本地服务器..."
echo "   访问: http://localhost:1313"
hugo server -D
