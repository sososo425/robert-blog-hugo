// 认证模块 - 处理登录和权限验证
(function() {
    'use strict';

    const API_BASE = '/api';
    
    // 存储token的key
    const TOKEN_KEY = 'auth_token';
    const USER_KEY = 'auth_user';

    // 获取当前token
    function getToken() {
        return localStorage.getItem(TOKEN_KEY);
    }

    // 保存token
    function saveToken(token) {
        localStorage.setItem(TOKEN_KEY, token);
    }

    // 清除token
    function clearToken() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
    }

    // 检查是否已登录
    function isLoggedIn() {
        return !!getToken();
    }

    // 获取当前用户
    function getCurrentUser() {
        const user = localStorage.getItem(USER_KEY);
        return user ? JSON.parse(user) : null;
    }

    // 登录函数
    async function login(username, password) {
        try {
            const response = await fetch(`${API_BASE}/auth.js`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    action: 'login',
                    username: username,
                    password: password
                })
            });

            const data = await response.json();
            
            if (response.ok && data.success) {
                saveToken(data.token);
                localStorage.setItem(USER_KEY, JSON.stringify({
                    username: data.username,
                    role: data.role
                }));
                return { success: true, message: '登录成功' };
            } else {
                return { 
                    success: false, 
                    message: data.message || '用户名或密码错误' 
                };
            }
        } catch (error) {
            console.error('Login error:', error);
            return { 
                success: false, 
                message: '网络错误，请稍后重试' 
            };
        }
    }

    // 登出函数
    function logout() {
        clearToken();
        window.location.href = '/';
    }

    // 检查访问权限
    async function checkAccess(path) {
        const token = getToken();
        if (!token) {
            return { allowed: false, reason: 'unauthorized' };
        }

        try {
            const response = await fetch(`${API_BASE}/access-control.js`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    action: 'check',
                    path: path
                })
            });

            const data = await response.json();
            return {
                allowed: data.allowed,
                reason: data.reason
            };
        } catch (error) {
            console.error('Access check error:', error);
            return { allowed: false, reason: 'error' };
        }
    }

    // 页面加载时检查权限
    function initPageProtection() {
        const protectedPaths = ['/private/', '/admin/'];
        const currentPath = window.location.pathname;
        
        const isProtected = protectedPaths.some(path => 
            currentPath.startsWith(path)
        );

        if (isProtected && !isLoggedIn()) {
            window.location.href = '/login/';
            return;
        }

        // 更新UI显示登录状态
        updateUI();
    }

    // 更新UI
    function updateUI() {
        const user = getCurrentUser();
        const loginLinks = document.querySelectorAll('.login-link');
        const logoutLinks = document.querySelectorAll('.logout-link');
        const adminPanels = document.querySelectorAll('.admin-only');

        if (user) {
            loginLinks.forEach(el => el.style.display = 'none');
            logoutLinks.forEach(el => el.style.display = 'inline');
            adminPanels.forEach(el => el.style.display = 'block');
        } else {
            loginLinks.forEach(el => el.style.display = 'inline');
            logoutLinks.forEach(el => el.style.display = 'none');
            adminPanels.forEach(el => el.style.display = 'none');
        }
    }

    // 导出到全局
    window.Auth = {
        getToken,
        isLoggedIn,
        getCurrentUser,
        login,
        logout,
        checkAccess,
        initPageProtection
    };

    // 自动初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPageProtection);
    } else {
        initPageProtection();
    }
})();
