---
title: "智能体设计模式资料汇总"
date: 2026-02-22T15:00:00+08:00
draft: false
description: "Google 及相关高质量智能体设计模式资料整理"
categories: ["技术"]
tags: ["AI", "Agent", "设计模式", "Google"]
---

这是 Google 及相关高质量智能体设计模式的资料整理，涵盖从理论基础到实践应用的完整内容。

## 📚 中文资料

### 1. Prompt Engineering Guide - 大语言模型智能体简介 ⭐推荐

- **网址**: https://www.promptingguide.ai/zh/research/llm-agents
- **语言**: 中文
- **内容**: 系统性介绍 LLM Agent 的核心组件
  - 智能体（Agent）角色与设计
  - 规划模块（Planning）：无反馈规划 vs 有反馈规划
  - 记忆模块（Memory）：短期记忆与长期记忆
  - 工具使用（Tools）：API、代码解释器等
  - ReAct、Reflexion 等设计模式

## 📚 英文资料（高质量参考）

### 2. A Survey on LLM-based Autonomous Agents ⭐经典论文

- **网址**: https://arxiv.org/abs/2308.11432
- **PDF**: https://arxiv.org/pdf/2308.11432
- **作者**: 中国人民大学高瓴人工智能学院
- **内容**:
  - LLM Agent 的统一框架
  - 社交科学、自然科学、工程领域的应用
  - 评估策略与未来方向

### 3. DeepLearning.AI - Multi AI Agent Systems with crewAI

- **网址**: https://www.deeplearning.ai/short-courses/multi-ai-agent-systems-with-crewai/
- **时长**: 2小时41分钟，18个视频课程
- **内容**:
  - 角色扮演（Role-playing）
  - 记忆系统（短期/长期/共享记忆）
  - 工具分配（Tools）
  - 任务协作（串行、并行、层级）
  - Guardrails 错误处理

### 4. LangChain 官方文档 - Agentic Concepts

- **网址**: https://js.langchain.com/docs/concepts/agentic/
- **内容**:
  - LangChain 的 Agent 架构
  - LangGraph 编排框架
  - Deep Agents 现代功能（自动压缩、虚拟文件系统、子代理）

## 🔗 Google 官方资源

| 资源 | 链接 |
|------|------|
| Vertex AI Agent Builder | https://cloud.google.com/generative-ai-app-builder/docs/agent-intro |
| Gemini API Agents 文档 | https://ai.google.dev/gemini-api/docs/agents |
| Google Research | https://research.google/pubs/ |
| Kaggle Agents 白皮书 | https://www.kaggle.com/whitepaper-agents |

## 📋 核心设计模式总结

| 模式 | 说明 |
|------|------|
| **ReAct** | 推理+行动交替进行（Thought → Action → Observation）|
| **Chain-of-Thought** | 思维链，逐步推理 |
| **Tree of Thoughts** | 多路径思维树 |
| **Reflexion** | 自我反思与改进 |
| **Multi-Agent** | 多智能体协作（角色分工）|
| **RAG** | 检索增强生成 |
| **Tool Use** | 工具调用（搜索、代码解释器等）|

## 📝 延伸阅读

- **MRKL**: 结合 LLM 和专家模块 https://arxiv.org/abs/2205.00445
- **Toolformer**: 微调 LLM 使用外部工具 API https://arxiv.org/abs/2302.04761
- **HuggingGPT**: 利用 LLM 作为任务规划器 https://arxiv.org/abs/2303.17580
- **ChemCrow**: 化学领域专用 Agent https://arxiv.org/abs/2304.05376

---

> 持续学习中，欢迎交流讨论。
