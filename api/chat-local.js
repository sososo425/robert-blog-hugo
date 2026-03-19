// Local development API route for chat (Node.js runtime, not Edge)
// This allows file system access for local logging
// Only used when BLOB_READ_WRITE_TOKEN is not set

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const LOG_DIR = './logs/chat-conversations';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body;
    const { message, articleTitle, articleContent, articleUrl, conversationId = crypto.randomUUID() } = body;

    if (!message) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    const apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'API key not configured' });
      return;
    }

    // Build system prompt
    const systemPrompt = `你是一位专业的技术博客 AI 助手，帮助读者理解文章内容。

当前文章信息：
- 标题：${articleTitle || '未知'}
- URL：${articleUrl || '未知'}

文章内容（部分）：
${articleContent?.substring(0, 6000) || '未提供文章内容'}

请基于以上文章内容回答读者的问题。如果问题与文章内容无关，请礼貌地引导读者回到文章主题。回答要简洁、专业、有帮助。如果文中涉及技术概念，请用通俗易懂的方式解释。使用 Markdown 格式输出，代码块用 \`\`\`language 标注。`;

    const startTime = Date.now();

    const response = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'kimi-k2-5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        temperature: 0.3,
        max_tokens: 3000,
      }),
    });

    const latency = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.text();
      console.error('Kimi API error:', error);

      // Log to local file even on error
      await logToLocalFile({
        conversationId,
        articleTitle,
        articleUrl,
        userMessage: message,
        assistantResponse: null,
        error,
        latency,
        timestamp: new Date().toISOString(),
        model: 'kimi-k2-5',
        success: false,
      });

      res.status(502).json({ error: 'AI service error' });
      return;
    }

    const data = await response.json();

    const conversationData = {
      conversationId,
      articleTitle,
      articleUrl,
      userMessage: message,
      assistantResponse: data.choices?.[0]?.message?.content || '',
      latency,
      timestamp: new Date().toISOString(),
      model: 'kimi-k2-5',
      tokenUsage: data.usage || {},
      success: true,
    };

    // Log to local file (async, don't block)
    logToLocalFile(conversationData).catch(err => {
      console.error('Failed to log to local file:', err);
    });

    res.status(200).json({
      ...data,
      conversationId,
    });
  } catch (error) {
    console.error('Chat API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Log conversation to local file system
 * Path: ./logs/chat-conversations/{articleSlug}/{date}/{conversationId}.json
 */
async function logToLocalFile(data) {
  try {
    // Extract article slug from URL
    const articleUrl = data.articleUrl || 'unknown';
    const articleSlug = articleUrl.split('/').filter(Boolean).pop() || 'unknown';

    // Build directory path: ./logs/chat-conversations/{articleSlug}/{date}/
    const date = new Date().toISOString().split('T')[0];
    const dirPath = join(process.cwd(), LOG_DIR, articleSlug, date);

    // Create directories if they don't exist
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }

    // Write file
    const filename = `${data.conversationId}.json`;
    const filePath = join(dirPath, filename);
    const fileData = JSON.stringify(data, null, 2);

    await writeFile(filePath, fileData, 'utf-8');

    console.log('\n' + '='.repeat(60));
    console.log('📝 CHAT LOG (Local File Mode)');
    console.log('='.repeat(60));
    console.log(`File: ${filePath}`);
    console.log(`Time: ${data.timestamp}`);
    console.log(`Article: ${data.articleTitle}`);
    console.log(`Success: ${data.success}`);
    console.log('-'.repeat(60));
    console.log('User:', data.userMessage?.substring(0, 100));
    if (data.assistantResponse) {
      console.log('Assistant:', data.assistantResponse?.substring(0, 100) + '...');
    }
    console.log('='.repeat(60) + '\n');
  } catch (error) {
    console.error('Local file logging error:', error);
  }
}

// Export config to use Node.js runtime (not Edge)
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};
