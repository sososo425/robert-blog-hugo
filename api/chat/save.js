// Save chat message for a specific article
import { list, put, get } from '@vercel/blob';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'your-secret-key-change-in-production');

async function getBlobJson(pathname) {
  const { blobs } = await list({ prefix: pathname });
  const blob = blobs.find(b => b.pathname === pathname);
  if (!blob) return null;
  const response = await get(blob.url, { access: 'private' });
  const chunks = [];
  for await (const chunk of response.stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { articleSlug, message, role } = req.body;

    if (!articleSlug || !message || !role) {
      return res.status(400).json({ error: 'Article slug, message, and role are required' });
    }

    const authHeader = req.headers.authorization;
    let userId = 'guest';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const { payload } = await jwtVerify(token, JWT_SECRET);
        userId = payload.userId;
      } catch {
        // Invalid token, treat as guest
      }
    }

    if (userId === 'guest') {
      return res.status(200).json({ success: true, saved: false, reason: 'guest' });
    }

    const conversationPath = `conversations/${userId}/${articleSlug}.json`;

    let conversation = await getBlobJson(conversationPath);
    if (!conversation) {
      conversation = {
        userId,
        articleSlug,
        messages: [],
        createdAt: new Date().toISOString(),
      };
    }

    conversation.messages.push({
      role,
      content: message,
      timestamp: new Date().toISOString(),
    });
    conversation.updatedAt = new Date().toISOString();

    await put(conversationPath, JSON.stringify(conversation), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
    });

    res.status(200).json({ success: true, saved: true });
  } catch (error) {
    console.error('Save message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
