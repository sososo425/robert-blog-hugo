# 管理员登录与权限控制功能指南

## 📋 功能概述

本功能为博客添加了管理员登录和基于目录的访问控制系统，允许你：

- 设置受保护的目录（如 `/private/`）
- 只有登录的管理员才能查看这些目录下的文章
- 通过管理面板动态配置受保护路径

## 🗂️ 新增文件结构

```
robert-blog-hugo/
├── api/
│   ├── auth.js              # 认证 API（登录、token 验证）
│   └── access-control.js    # 访问控制 API（权限检查）
├── layouts/_default/
│   ├── login.html           # 登录页面模板
│   └── admin.html           # 管理面板模板
├── content/
│   ├── admin/
│   │   └── _index.md        # 管理面板入口
│   └── private/
│       └── example-protected-article.md  # 私密文章示例
└── ADMIN_GUIDE.md           # 本文档
```

## 🔐 默认凭据

**⚠️ 重要：首次部署后请立即修改密码！**

- 用户名：`admin`
- 密码：`admin123`

## 🚀 快速开始

### 1. 本地测试

```bash
# 构建并预览
hugo server -D

# 访问以下页面
http://localhost:1313/login/     # 登录页面
http://localhost:1313/admin/     # 管理面板
http://localhost:1313/private/example-protected-article/  # 私密文章示例
```

### 2. Vercel 部署

```bash
git add .
git commit -m "feat: 添加管理员登录和权限控制功能"
git push origin feature/admin-auth-access-control
```

然后在 Vercel 导入该分支进行部署测试。

### 3. 环境变量配置（生产环境）

在 Vercel 项目设置中添加以下环境变量：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `ADMIN_USERNAME` | 管理员用户名 | `admin` |
| `ADMIN_PASSWORD_HASH` | 密码的 SHA-256 哈希 | `8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918` |
| `JWT_SECRET` | Token 签名密钥 | `your-secret-key-change-this` |
| `PROTECTED_PATHS` | 受保护路径列表 | `/private/,/members-only/` |

生成密码哈希的命令：
```bash
echo -n "your-password" | shasum -a 256
```

## 📖 使用流程

### 设置受保护内容

1. **创建私密文章**
   ```markdown
   ---
   title: "我的私密笔记"
   date: 2026-03-12
   protected: true  # 标记为受保护
   ---
   
   这是只有管理员能看到的内容...
   ```

2. **将文章放在受保护目录下**
   ```
   content/private/my-private-note.md
   ```

3. **在管理面板确认目录已配置**
   - 访问 `/admin/`
   - 检查 `/private/` 是否在受保护路径列表中
   - 如不在，添加它

### 访问控制逻辑

```
用户请求文章
    ↓
检查文章路径是否在受保护目录中
    ↓
是 → 检查 Authorization header 中的 token
    ↓       ↓
   有效     无效/无 token
    ↓       ↓
显示文章  返回 401 错误
```

## 🔧 API 接口说明

### POST /api/auth

用户登录接口

**请求体：**
```json
{
  "username": "admin",
  "password": "admin123"
}
```

**成功响应：**
```json
{
  "success": true,
  "token": "abc123...",
  "expires": 1710345600000,
  "username": "admin"
}
```

### GET /api/auth

验证 token 有效性

**请求头：**
```
Authorization: Bearer abc123...
```

**成功响应：**
```json
{
  "valid": true
}
```

### GET /api/access-control?path=/private/article

检查对指定路径的访问权限

**请求头：**
```
Authorization: Bearer abc123...
```

**响应：**
```json
{
  "allowed": true,
  "protected": true,
  "message": "Access granted"
}
```

## 🛡️ 安全建议

1. **立即修改默认密码** - 使用强密码并更新 `ADMIN_PASSWORD_HASH`
2. **使用 HTTPS** - Vercel 默认提供，确保启用
3. **定期更换密钥** - 特别是 `JWT_SECRET`
4. **监控访问日志** - 定期检查异常登录尝试
5. **限制登录尝试** - 考虑添加速率限制（需额外实现）

## 📝 已知限制与改进方向

### 当前限制

- Token 存储在 localStorage（易受 XSS 攻击）
- 无数据库支持，配置无法持久化
- 单用户系统，不支持多角色
- 无密码找回功能

### 未来改进

- [ ] 集成数据库（如 Supabase、PlanetScale）
- [ ] 支持多用户和角色权限
- [ ] 添加双因素认证（2FA）
- [ ] 实现访问日志和审计
- [ ] 支持 OAuth 第三方登录
- [ ] 添加密码强度验证

## ❓ 常见问题

**Q: 忘记密码怎么办？**

A: 目前需要直接在 Vercel 重新设置 `ADMIN_PASSWORD_HASH` 环境变量。

**Q: 如何让某些文章对所有人可见，即使它们在受保护目录下？**

A: 可以在 front matter 中添加 `protected: false` 来覆盖目录设置。

**Q: 支持微信/Google 登录吗？**

A: 当前版本不支持，需要在后续版本中添加 OAuth 集成。

**Q: Token 多久过期？**

A: 默认 24 小时。可以在 `api/auth.js` 中修改 `expires` 设置。

## 📞 技术支持

如有问题或建议，请：
1. 查看 Vercel 函数日志
2. 检查浏览器控制台错误
3. 确认环境变量配置正确

---

*最后更新：2026-03-12*
