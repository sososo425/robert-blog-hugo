#!/usr/bin/env node
// Blob 管理工具 - 用于批量查看/下载对话日志
// 用法: BLOB_READ_WRITE_TOKEN=xxx node scripts/blob-admin.js [command] [options]

import { list, get } from '@vercel/blob';
import fs from 'fs';
import path from 'path';

const BLOB_PREFIX = 'chat-conversations';

// 确保 token 存在
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('Error: BLOB_READ_WRITE_TOKEN environment variable is required');
  console.error('请从 Vercel Dashboard → Storage → Blob → .env.local 获取 token');
  process.exit(1);
}

const command = process.argv[2] || 'list';

async function main() {
  try {
    switch (command) {
      case 'list':
        await listConversations();
        break;
      case 'download':
        await downloadAll();
        break;
      case 'stats':
        await showStats();
        break;
      default:
        console.log(`
用法: node scripts/blob-admin.js [command]

Commands:
  list       列出所有对话记录
  download   下载所有记录到本地
  stats      显示统计信息

Examples:
  BLOB_READ_WRITE_TOKEN=xxx node scripts/blob-admin.js list
  BLOB_READ_WRITE_TOKEN=xxx node scripts/blob-admin.js download
        `);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// 列出所有对话记录
async function listConversations() {
  console.log('📁 正在列出所有对话记录...\n');

  const { blobs } = await list({
    prefix: BLOB_PREFIX,
    token,
  });

  if (blobs.length === 0) {
    console.log('暂无记录');
    return;
  }

  // 按文章分组
  const grouped = {};
  for (const blob of blobs) {
    const parts = blob.pathname.split('/');
    const articleSlug = parts[1] || 'unknown';
    const date = parts[2] || 'unknown';

    if (!grouped[articleSlug]) grouped[articleSlug] = {};
    if (!grouped[articleSlug][date]) grouped[articleSlug][date] = [];
    grouped[articleSlug][date].push(blob);
  }

  // 打印分组结果
  for (const [article, dates] of Object.entries(grouped)) {
    console.log(`\n📄 ${article}`);
    for (const [date, items] of Object.entries(dates)) {
      console.log(`  📅 ${date}: ${items.length} 条对话`);
      for (const item of items) {
        console.log(`    - ${path.basename(item.pathname)} (${formatSize(item.size)})`);
      }
    }
  }

  console.log(`\n总计: ${blobs.length} 条记录`);
}

// 下载所有记录
async function downloadAll() {
  const outputDir = process.argv[3] || './blob-downloads';

  console.log(`📥 正在下载所有记录到 ${outputDir}...\n`);

  const { blobs } = await list({
    prefix: BLOB_PREFIX,
    token,
  });

  if (blobs.length === 0) {
    console.log('暂无记录可下载');
    return;
  }

  // 创建输出目录
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let success = 0;
  let failed = 0;

  for (const blob of blobs) {
    try {
      const localPath = path.join(outputDir, blob.pathname);
      const dir = path.dirname(localPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 下载文件内容
      const response = await fetch(blob.url);
      const content = await response.text();
      fs.writeFileSync(localPath, content);

      console.log(`✅ ${blob.pathname}`);
      success++;
    } catch (err) {
      console.error(`❌ ${blob.pathname}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n下载完成: ${success} 成功, ${failed} 失败`);
  console.log(`文件保存在: ${path.resolve(outputDir)}`);
}

// 显示统计信息
async function showStats() {
  console.log('📊 正在统计对话数据...\n');

  const { blobs } = await list({
    prefix: BLOB_PREFIX,
    token,
  });

  let totalConversations = 0;
  let totalSize = 0;
  const articleStats = {};
  const dailyStats = {};

  for (const blob of blobs) {
    totalConversations++;
    totalSize += blob.size;

    const parts = blob.pathname.split('/');
    const articleSlug = parts[1] || 'unknown';
    const date = parts[2] || 'unknown';

    // 文章统计
    if (!articleStats[articleSlug]) {
      articleStats[articleSlug] = { count: 0, size: 0 };
    }
    articleStats[articleSlug].count++;
    articleStats[articleSlug].size += blob.size;

    // 日期统计
    if (!dailyStats[date]) {
      dailyStats[date] = { count: 0, size: 0 };
    }
    dailyStats[date].count++;
    dailyStats[date].size += blob.size;
  }

  console.log(`总对话数: ${totalConversations}`);
  console.log(`总存储: ${formatSize(totalSize)}`);

  console.log('\n📄 按文章统计:');
  for (const [article, stats] of Object.entries(articleStats).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${article}: ${stats.count} 条 (${formatSize(stats.size)})`);
  }

  console.log('\n📅 按日期统计:');
  for (const [date, stats] of Object.entries(dailyStats).sort()) {
    console.log(`  ${date}: ${stats.count} 条 (${formatSize(stats.size)})`);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

main();
