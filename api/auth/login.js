// User login API
import bcrypt from 'bcryptjs';
import { get, list } from '@vercel/blob';
import { SignJWT } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'your-secret-key-change-in-production');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find user
    const userPath = `users/${username}.json`;
    let user;

    try {
      const blob = await get(userPath);
      const text = await blob.text();
      user = JSON.parse(text);
    } catch {
      // Special case: initialize admin user if not exists
      if (username === 'admin') {
        user = await initializeAdminUser();
      } else {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = await new SignJWT({ userId: user.id, username: user.username, role: user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('7d')
      .sign(JWT_SECRET);

    res.status(200).json({
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Initialize admin user with default password
async function initializeAdminUser() {
  const { put } = await import('@vercel/blob');

  const passwordHash = await bcrypt.hash('123456', 10);
  const adminUser = {
    id: crypto.randomUUID(),
    username: 'admin',
    passwordHash,
    role: 'admin',
    createdAt: new Date().toISOString(),
  };

  await put('users/admin.json', JSON.stringify(adminUser), {
    access: 'private',
    contentType: 'application/json',
  });

  console.log('Admin user initialized with password: 123456');
  return adminUser;
}
