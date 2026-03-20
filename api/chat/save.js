// Save chat message for a specific article
import { get, put } from '@vercel/blob';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'your-secret-key-change-in-production');

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

    // Get user from token (optional)
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

    // Guest users don't save history
    if (userId === 'guest') {
      return res.status(200).json({ success: true, saved: false, reason: 'guest' });
    }

    const conversationPath = `conversations/${userId}/${articleSlug}.json`;

    // Get existing conversation or create new
    let conversation;
    try {
      const blob = await get(conversationPath);
      const text = await blob.text();
      conversation = JSON.parse(text);
    } catch {
      conversation = {
        userId,
        articleSlug,
        messages: [],
        createdAt: new Date().toISOString(),
      };
    }

    // Add new message
    conversation.messages.push({
      role,
      content: message,
      timestamp: new Date().toISOString(),
    });

    conversation.updatedAt = new Date().toISOString();

    // Save conversation
    await put(conversationPath, JSON.stringify(conversation), {
      access: 'private',
      contentType: 'application/json',
    });

    res.status(200).json({ success: true, saved: true });
  } catch (error) {
    console.error('Save message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
