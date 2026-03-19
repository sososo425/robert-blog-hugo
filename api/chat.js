// Vercel Serverless Function for Kimi AI Chat with Blob logging
// Node.js runtime - supports @vercel/blob

import { put } from '@vercel/blob';

const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const BLOB_PATH_PREFIX = 'chat-conversations';

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, articleTitle, articleContent, articleUrl, conversationId = crypto.randomUUID() } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const systemPrompt = `你是一位专业的技术博客 AI 助手，帮助读者理解文章内容。

当前文章信息：
- 标题：${articleTitle || '未知'}
- URL：${articleUrl || '未知'}

文章内容（部分）：
${articleContent?.substring(0, 6000) || '未提供文章内容'}

请基于以上文章内容回答读者的问题。如果问题与文章内容无关，请礼貌地引导读者回到文章主题。回答要简洁、专业、有帮助。如果文中涉及技术概念，请用通俗易懂的方式解释。使用 Markdown 格式输出，代码块用 \`\`\`language 标注。`;

  try {
    const startTime = Date.now();

    const response = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'kimi-k2.5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        temperature: 1,
        max_tokens: 3000,
      }),
    });

    const latency = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.text();
      console.error('Kimi API error:', error);

      await logToBlob({ conversationId, articleTitle, articleUrl, userMessage: message, error, latency, success: false });

      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await response.json();

    // Log to blob before returning response (ensure it completes)
    try {
      await logToBlob({
        conversationId,
        articleTitle,
        articleUrl,
        userMessage: message,
        assistantResponse: data.choices?.[0]?.message?.content || '',
        latency,
        timestamp: new Date().toISOString(),
        model: 'kimi-k2.5',
        tokenUsage: data.usage || {},
        success: true,
      });
    } catch (logError) {
      console.error('Blob log error:', logError);
    }

    return res.status(200).json({ ...data, conversationId });
  } catch (error) {
    console.error('Chat API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function logToBlob(data) {
  try {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    console.log('BLOB_READ_WRITE_TOKEN exists:', !!blobToken);

    if (!blobToken) {
      console.log('CHAT LOG (no token):', JSON.stringify(data, null, 2));
      return;
    }

    const articleSlug = (data.articleUrl || 'unknown').split('/').filter(Boolean).pop() || 'unknown';
    const date = new Date().toISOString().split('T')[0];
    const pathname = `${BLOB_PATH_PREFIX}/${articleSlug}/${date}/${data.conversationId}.json`;

    console.log('Uploading to blob:', pathname);

    const result = await put(pathname, JSON.stringify(data, null, 2), {
      access: 'private',
      contentType: 'application/json',
    });

    console.log('Blob upload success:', result.url || result.pathname);
  } catch (error) {
    console.error('Blob logging error:', error.message, error.stack);
  }
}
