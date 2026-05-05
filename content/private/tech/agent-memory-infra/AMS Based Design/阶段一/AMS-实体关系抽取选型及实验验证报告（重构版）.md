---

# AMS 记忆：实体关系抽取选型及实验验证报告（重构版）

| 元数据 | 内容 |
|--------|------|
| 文档类型 | 选型研究 / 实验验证 / 方案推荐 |
| 关联设计 | 《AMS 语义记忆与情景记忆构建系统 - 完整方案设计》第 5 章 |
| 版本 | 2026-04-15 重构版；2026-04-16 补充小 LLM（gemma4-e4b）实测数据；2026-04-16 根据交叉确认报告迭代（场景限定、延迟细化、GLiNER2 补充、Encoder 根因分析） |
| 证据来源 | 原报告《AMS记忆-实体关系抽取选型及实验验证报告》、`bert-test/` 实验工程、`scripts/ams_ie_encoder_pipeline_report.py`、`scripts/ams_gliner_model_benchmark.py`、`small_llm_vs_large_gliner_report.json`（小 LLM vs GLiNER 对照实验）、行业调研 |

---

## 摘要

本报告围绕 AMS 系统「从对话文本中抽取实体和关系，构建语义记忆知识图谱」这一工程问题，回答三个核心疑问：

1. **用什么技术路线？** —— Encoder 小模型（GLiNER/BERT） vs 大语言模型（LLM） vs 两者混合
2. **当前选型的实测表现如何？** —— 基于 9 类典型 Case 的多方案对照实验
3. **下一步怎么走？** —— 结合 2025-2026 年业界实践的推荐方案

**核心结论**：

> - **原设计「Encoder 打底 + LLM 精修」的混合架构思路正确，但 Encoder 层在中文会话场景的价值被高估**。实测表明 GLiNER 系列在中文上无法担当"主抽取器"角色。
> - **小参数量 LLM 实测验证了这一判断**：使用 gemma4-e4b（~4B 参数）对同一批测试句进行抽取，中文场景实体识别准确率和语义理解能力**全面碾压** GLiNER（详见 §4.4）。即便是 4B 级别的小 LLM，也已经远超 86M-350M 级 Encoder 在中文上的表现。
> - **业界正快速转向「LLM 主抽取」模式**。在**离线批量知识图谱构建**场景（Microsoft GraphRAG、LightRAG），已全面采用 LLM 抽取；在**实时/近实时 agent 会话处理**场景，主流做法是小 LLM（7-8B，含量化）本地部署或 API 异步调用。7B-8B 级小 LLM（如 Qwen2.5-7B）在中文 NER 上可达 85-92% F1，已接近 fine-tuned BERT-CRF 水平，且同时输出实体+关系，是最值得投入的方向。
> - **Encoder 小模型仍有其生态位**：英文结构化文本（Trace 数据）、离线降级、高吞吐场景。但不应再作为架构叙事的中心。

---

## 第 1 章 问题定义：AMS 要抽什么、从哪抽、为什么难

### 1.1 AMS 实体关系抽取的定位

AMS 从两类原始数据中构建记忆：

| 数据源             | 内容特征            | 语言特征      | 抽取难度   |
| --------------- | --------------- | --------- | ------ |
| **Session**（对话） | 自然语言、指代丰富、上下文隐含 | 中文为主，中英混杂 | **高**  |
| **Trace**（执行日志） | 半结构化、工具名/API 明确 | 英文为主      | **中低** |

抽取的产出物：

- **实体（EntityNode）**：工具名、人名、概念、资源等 → 入图谱节点
- **关系（Fact/Edge）**：USES、INVOKES、CAUSED_BY 等 → 入图谱边
- **事件（EventNode）**：时间+参与者+摘要 → 入时序链

本报告聚焦**实体 + 关系**部分。事件抽取因强依赖 LLM 推理能力，不在 Encoder vs LLM 选型争论范围内。

### 1.2 为什么不能全用 LLM？为什么又不能全用 Encoder？

| 全 LLM | 全 Encoder |
|--------|-----------|
| ✅ 质量高、灵活 | ✅ 快速、廉价 |
| ❌ 成本高（~$300/天/万 block） | ❌ 中文差、开放关系做不了 |
| ❌ 延迟高（3-6s/block） | ❌ 没有推理能力（Foresight 等） |

**所以需要选型**：在成本、质量、延迟之间找最优平衡。

---

## 第 2 章 技术背景：三个核心 NLP 任务一次讲清

> **写给没有 NLP 背景的读者**：本章用一句例句把所有概念钉死。

### 一句例句贯穿全章

```
张三在上海用支付宝付了十元。
```

### 2.1 NER（命名实体识别）—— "文本里有哪些东西？"

**任务**：从文本中找出**实体片段（span）**并标注类型。

| span | 类型 | 起止 |
|------|------|------|
| 张三 | PERSON | [0:2] |
| 上海 | LOCATION | [3:5] |
| 支付宝 | APP | [6:9] |
| 十元 | MONEY | [10:12] |

**技术演进**（简脉络）：

```
统计时代          → 深度学习早期      → BERT 时代          → 零样本时代
HMM/CRF+人工特征  → BiLSTM-CRF       → Token级分类+span   → GLiNER（标签描述匹配）
```
**参考： [[语言模型早期历史]]**

**GLiNER 的做法**：不需要为每种实体类型训练专门模型。你传入一组**文本标签**（如 `["PERSON", "LOCATION", "APP"]`），模型在统一的语义空间中将文本 span 与标签进行匹配。这就是"零样本"的含义——不需要标注数据就能识别新类型。

**与传统分词的关系**：现代 Transformer 模型使用子词分词（BPE/SentencePiece），不需要显式中文分词步骤。AMS 实验中的"按标点切段"是**工程分段策略**，不是传统分词。

### 2.2 关系抽取（RE）—— "这些东西之间有什么联系？"

**任务**：给定文本和（可选的）实体，识别实体间的**语义关系**。

例如：`PAID_WITH(张三, 支付宝)`、`LOCATED_IN(张三, 上海)`

**两种主流范式**（这是理解本报告的关键区分）：

| 范式 | 流程 | 优点 | 缺点 |
|------|------|------|------|
| **管道式（Pipeline）** | 先做 NER → 取实体对 → 关系分类 | 模块清晰、可分别优化 | **错误传播**：NER 漏了实体，关系必漏 |
| **联合抽取（Joint）** | 单模型一次前向，同时输出实体+关系 | 缓解错误传播、一次搞定 | 模型更复杂、域迁移可能"串味" |

> **关键点**：GLiNER-RelEx 的 `inference(..., return_relations=True)` 是**联合抽取**——一次调用同时出实体和关系，**不是**内部先完整跑 NER 再跑 RE 两个独立步骤。

### 2.3 NLI 做关系分类 —— "一种巧妙的借用"

**NLI（自然语言推理）本身的任务**：给定前提 P 和假设 H，判断蕴含/中立/矛盾。

**在关系抽取中的借用**：把关系类型改写成中文假设模板，让 NLI 模型打分。

| 步骤 | 对应到例句 |
|------|-----------|
| 前提 P | "张三在上海用支付宝付了十元" |
| 假设 H₁ | "张三 使用工具 支付宝" → 对应 USES 关系 |
| 假设 H₂ | "张三 通过 支付宝 完成支付" → 对应 PAID_WITH 关系 |
| 输出 | H₂ 的蕴含分最高 → 预测 `PAID_WITH(张三, 支付宝)` |

**注意**：这是**软匹配**（神经网络打分），不是可证明的逻辑推理。假设模板的措辞直接影响结果质量。

### 2.4 三种 Transformer 架构与适配场景

| 架构 | 代表 | 注意力方向 | 擅长 |
|------|------|-----------|------|
| **Encoder-only** | BERT、DeBERTa、GLiNER | 双向 | 分类、span 判别 |
| **Decoder-only** | GPT、Qwen、Gemma | 单向 | 生成、推理 |
| **Encoder-Decoder** | T5、BART | 编码双向+解码单向 | 翻译、生成式抽取 |

==**对 AMS 的推论**：实体边界判别用双向编码器有结构性优势；但**当双向编码器在特定语言/领域表现不佳时**（如中文 GLiNER），这个理论优势无法兑现。==

---

## 第 3 章 实验方案全景：我们测了什么、怎么测的

### 3.1 五套实验方案一览

| 代号     | 脚本/入口                                           | 核心模型                                                          | 做什么                                                                         | 范式                  |
| ------ | ----------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------- |
| **A**  | `ams_gliner_model_benchmark.py`                 | gliner_small / gliner_multi / gliner-relex / modern-gliner-bi | 同标签同阈值下**多模型 NER 对比**                                                       | 纯 NER 对照            |
| **B**  | `ams_ie_encoder_pipeline_report.py`             | NER: gliner_multi + RelEx: gliner-relex + NLI: mDeBERTa-xnli  | **四层串联**：切段→NER→RelEx联合→NLI补边→规则过滤                                          | 联合+管道并联             |
| **C1** | `bert-test/demo_market_payment_ie.py` (relex分支) | gliner-relex-multi                                            | 单句**联合抽取**（实体+关系一次出）                                                        | 联合抽取                |
| **C2** | 同上 (fallback分支)                                 | NER: gliner_multi + NLI: mDeBERTa-xnli                        | **管道式**：分句NER + 词典补全 + 手写实体对 + 8类NLI                                        | 管道+规则+NLI           |
| **D**  | `small_llm_vs_large_gliner_report.json`         | **GLiNER-small + GLiNER-RelEx + gemma4-e4b**（Ollama 本地）       | **三路对照**：同一句分别跑 GLiNER NER / RelEx 联合 / 小 LLM session extraction，JSON 结构化输出 | 小 LLM vs Encoder 对照 |

### 3.2 方案 B（离线报告管线）的处理流程

```
原文输入
  ↓
Layer0: 标点切段（，,；;\n）
  ↓
Layer1: gliner_multi NER（24类实体标签）
  ↓
RelEx: gliner-relex-multi 整篇联合推理（14类关系）
  ↓
Layer3*: 规则过滤（span 占比、分数阈值、自环丢弃）
  ↓
NLI: mDeBERTa-xnli 对实体对零样本分类（11类假设）
  ↓
输出报告（MD + JSON）
```

> **⚠️ 命名冲突警告**：方案 B 脚本中的 "Layer3" = **规则过滤**层；设计文档中的 "Layer 3" = **LLM 精修**层。两者同名但完全不同。

### 3.3 方案 C2（bert-test 菜市场 demo）的特殊之处

方案 C2 在菜市场句上表现较好，但这是**多重强先验辅助的结果**，不可直接泛化：

| 优化手段 | C2 有 | B 没有 | 影响 |
|----------|-------|--------|------|
| 窄标签（7类 vs 24类） | ✅ | ❌ | 减少标签竞争，提高命中率 |
| 逗号分句+右半句禁 PERSON | ✅ | ❌ | 防止支付半句被糊成人名 |
| 词典注入（支付宝/花呗/苹果手机…） | ✅ | ❌ | 确定性规则，不依赖模型 |
| 手写实体对（7组） | ✅ | ❌ | 跳过了"实体对生成"这个难点 |

==**结论**：C2 的价值在于**证明了 NLI 方法在理想实体对输入下的表达能力**，但**不代表**生产环境下端到端的自动化效果。==

### 3.4 测试样例概览

9 条固定测试句覆盖了不同场景：

| ID             | 原文                                                                        | 场景        | 预期难度             |
| -------------- | ------------------------------------------------------------------------- | --------- | ---------------- |
| zh_weather     | 上海今天天气怎么样                                                                 | 中文极短句     | 高（整句=一个实体？）      |
| zh_money       | 我有10万闲钱,想做稳健理财                                                            | 中文金融      | 高（无明显实体标记词）      |
| zh_lend        | 我有10万块钱,想借给葛瑞刚                                                            | 中文借贷+人名   | 高                |
| en_flight      | Book a flight from Shanghai to Beijing tomorrow morning.                  | 英文行程      | 低（与 RelEx 训练域对齐） |
| en_code_mixed  | The user in our Shanghai office called the LangChain API from Python...   | 英文技术      | 中                |
| mixed_dialogue | Melanie said the lake sunrise painting was from last year. Caroline 觉得... | 中英混聊      | 中高               |
| market_payment | 我今天去菜市场买了2个苹果40块钱，是用我的苹果手机里的支付宝的花呗支付的                                     | 中文支付长句    | 高（实体嵌套、歧义多）      |
| pandas_csv     | Turn 1 - 用户：我用 pandas 处理了一个 CSV，有个列的类型识别有问题。                              | 工具对话      | 低（显式动词+明确实体）     |
| trace_invoke   | Agent 通过 python_executor 运行脚本，内部进一步调用了 read_excel 读取表格。                   | Trace 调用链 | 低                |

---

## 第 4 章 实验结果与根因分析

### 4.1 定量总览（方案 B 单次运行）

| sample_id      | L1实体数 | RelEx实体数 | RelEx关系数 | NLI边数 | 规则丢弃日志              |
| -------------- | ----- | -------- | -------- | ----- | ------------------- |
| zh_weather     | 1     | 1        | 0        | 0     | 1（整句 DROP）          |
| zh_money       | 0     | 1        | 0        | 0     | 0                   |
| zh_lend        | 0     | 1        | 0        | 0     | 0                   |
| en_flight      | 4     | 6        | 5        | 5     | 0                   |
| en_code_mixed  | 6     | 8        | 6        | 6     | 1                   |
| mixed_dialogue | 5     | 5        | 1        | 6     | 0                   |
| market_payment | 1     | 1        | 0        | 0     | 1（WARN long PERSON） |
| pandas_csv     | 2     | 3        | 1        | 1     | 0                   |
| trace_invoke   | 3     | 4        | 3        | 3     | 0                   |

### 4.2 核心发现与根因

#### 发现一：中文短句大面积失效

**现象**：zh_weather / zh_money / zh_lend / market_payment 四条中文句，L1 实体数为 0 或仅 1 个（且往往是错误的长 span）。

**根因分析**：

| 因素         | 说明                                                                                   |
| ---------- | ------------------------------------------------------------------------------------ |
| **子词分词问题** | GLiNER 底层使用 SentencePiece/BPE，中文字符被拆为字节级 token。span 预测头在以空格分隔语言为主的训练数据上优化，对中文边界检测能力弱 |
| **标签集过宽**  | 24 类标签在零样本模式下互相竞争。"上海"可能同时匹配 CITY、LOCATION、PERSON 等多个标签，当各标签分数都不高时全部被阈值过滤            |
| **训练数据偏差** | GLiNER 的多语言训练数据中，中文比例远低于英文/欧洲语言，导致 F1 下降 15-30 个百分点（社区已知问题）                          |

**实证**：`zh_weather` 中"上海"被标为整句 `[上海今天天气怎么样] → CITY`（score≈0.860, span=[0:9]），规则层 `DROP span covers 1.00 of text`。

#### 发现二：英文结构化文本表现良好

**现象**：en_flight（4 个实体、5 条关系）、en_code_mixed（6 个实体、6 条关系）、trace_invoke（3 个实体、3 条关系）均有较好输出。

**根因**：英文白空格天然分隔了 token 边界；技术领域实体（API、工具名）往往是独立词汇；行程类关系（FLIES_FROM/TO）与 RelEx 训练域对齐。

#### 发现三：RelEx 关系类型"串味"

**现象**：`en_code_mixed` 中出现 `LangChain API --[FLIES_FROM]--> Python`（score=0.852）。

**根因**：RelEx 的联合解码头在非行程句式上仍会激活行程类关系标签（FLIES_FROM/TO/SCHEDULED_ON），因为训练数据中这些标签与"从 A 到 B"的句式模式强绑定。

**影响**：如果不做关系白名单/场景分流，非行程域的关系输出中将混入大量无意义边。

#### 发现四：NLI 补边受限于实体对来源

**现象**：`market_payment` 在方案 B 中 NLI 边数为 0，因为 L1 仅产出 1 个实体，无法形成实体对。在方案 C2 中因手写 7 组实体对，NLI 能输出丰富关系。

**根因**：管道式的 NLI 关系分类**完全依赖**上游实体对的质量和数量。NER 漏检 = 关系必漏，这是经典的**错误传播**问题。

### 4.3 典型 Case 详解（三例）

#### Case 1：`zh_weather` —— Encoder 的典型困境

```
输入: "上海今天天气怎么样"
期望: CITY(上海), DATE(今天)
实际 L1: [上海今天天气怎么样] → CITY, score=0.860, span=[0:9] 
         ❌ 整句被当作一个城市名
Layer3规则: DROP（span 占整句 100%）
最终: 无可用实体、无关系
```

==**教训**：GLiNER 在中文极短句上无法区分"实体"和"包含实体的问句"。==

#### Case 2：`en_flight` —— Encoder 的舒适区

```
输入: "Book a flight from Shanghai to Beijing tomorrow morning."
L1: flight(TRANSPORT), Shanghai(CITY), Beijing(CITY), tomorrow morning(DATE)
RelEx: flight--[FLIES_FROM]-->Shanghai, flight--[FLIES_TO]-->Beijing, 
       flight--[SCHEDULED_ON]-->tomorrow
NLI: 5条补边（多为 RELATES_TO 弱关联）
最终: 实体+关系丰富，主链路正确
```

==**教训**：英文 + 行程域 + 边界清晰 = Encoder 最优工况。==

#### Case 3：`market_payment` —— 方案 B vs C2 的对照

| 维度 | 方案 B（自动化管线） | 方案 C2（演示管线） |
|------|-------------------|-------------------|
| L1 实体 | 1个（错误的长 span PERSON） | 分句+降阈→多实体 |
| 词典 | 无 | 注入支付宝/花呗/苹果手机等 |
| 实体对 | 自动组对（仅1实体→0对） | 手写7组 |
| NLI 关系 | 0 | 多条有效关系 |

==**教训**：C2 的好效果来自人工先验，不可作为"Encoder 方案可行"的证据。它证明的是"**如果实体对是正确的，NLI 方法可以工作**"——但"实体对正确"这个前提恰恰是瓶颈所在。==

### 4.4 方案 D 实测：小 LLM（gemma4-e4b）vs GLiNER 三路对照

> **数据来源**：`small_llm_vs_large_gliner_report.json`
> **实验配置**：GLiNER NER = `urchade/gliner_small-v2.1`（threshold=0.35）；GLiNER RelEx = `knowledgator/gliner-relex-multi-v1.0`；LLM = `gemma4-e4b:latest`（Ollama 本地，temperature=0.2）
> **调用方式**：LLM 使用 AMS 生产级 prompt（`EXTRACTION_SYSTEM_PROMPT` + `build_extraction_user_prompt`），输出完整的 entities / events / participants / relationships 结构化 JSON

#### 4.4.1 逐 Case 对照总表

| sample_id      | GLiNER-small NER        | GLiNER-RelEx 实体       | GLiNER-RelEx 关系                 | **gemma4-e4b 实体**                            | **gemma4-e4b 事件**           | **gemma4-e4b 关系**                       | **对照判定**                    |
| -------------- | ----------------------- | --------------------- | ------------------------------- | -------------------------------------------- | --------------------------- | --------------------------------------- | --------------------------- |
| zh_weather     | 1（❌ 整句→City）            | 1（❌ 整句→City）          | 1（❌ 自环 located_in）              | **1（✅ "上海" CONCEPT）**                        | 1（user_request）             | 1（DERIVED_FROM）                         | **LLM 完胜**                  |
| zh_money       | 1（❌ "我有10万闲钱"→Person）   | 2（❌ 两段均→Person）       | 0                               | **1（✅ "10万闲钱" RESOURCE）**                    | 1（user_request）             | 1                                       | **LLM 完胜**                  |
| zh_lend        | 1（❌ "我有10万块钱"→Person）   | 2（❌ 两段均→Person）       | 0                               | **2（✅ "10万块钱" RESOURCE, "葛瑞刚" PERSON）**      | 1                           | 2（含 MENTIONS 语义关系）                      | **LLM 完胜**                  |
| en_flight      | 4（✅ 正确）                 | 4（✅ 正确）               | 3（✅ flies_from/to/scheduled_on） | **3（✅ Shanghai, Beijing, tomorrow morning）** | 1                           | 3（含 MENTIONS 语义关系）                      | **持平**，GLiNER 出 flight 实体更细 |
| en_code_mixed  | 3（⚠️ 漏 LangChain API 等） | 7（✅ 丰富）               | 10（⚠️ 含重复+串味）                   | **5（✅ 全部关键实体）**                              | 2（✅ 分出 API 调用 + hotfix 两事件） | 8（✅ INVOKES, PRODUCES, CAUSED_BY 等语义丰富） | **LLM 胜**（语义质量高）            |
| mixed_dialogue | 4（✅ 人名+日期）              | 4（⚠️ lake 当 Location） | 2（❌ Caroline works_at museum）   | **4（✅ Melanie, painting, Caroline, museum）** | 1                           | 4（✅ MENTIONS 语义正确）                      | **LLM 胜**（无离谱关系）            |

#### 4.4.2 中文场景逐 Case 详解

**Case: `zh_weather`** — "上海今天天气怎么样"

| 层 | GLiNER-small NER | GLiNER-RelEx | gemma4-e4b |
|----|-----------------|--------------|------------|
| 实体 | `[上海今天天气怎么样]` → City (0.675) ❌ 整句 | `[上海今天天气怎么样]` → City (0.895) ❌ 整句 | `上海` → CONCEPT ✅ 精准切词 |
| 关系 | — | located_in（自环：整句→整句）❌ | DERIVED_FROM（事件溯源） ✅ |
| 事件 | — | — | "用户询问上海当天的天气情况" ✅ |

**Case: `zh_money`** — "我有10万闲钱,想做稳健理财"

| 层 | GLiNER-small NER | GLiNER-RelEx | gemma4-e4b |
|----|-----------------|--------------|------------|
| 实体 | `[我有10万闲钱]` → Person (0.846) ❌ | `[我有10万闲钱]` → Person (0.914) ❌ + `[想做稳健理财]` → Person (0.410) ❌ | `10万闲钱` → RESOURCE ✅ |
| 关系 | — | 0 | 1（DERIVED_FROM） |
| 事件 | — | — | "用户希望对10万闲钱进行稳健理财" ✅ |

> ==**注意**：GLiNER-RelEx 在此 case 上**比 GLiNER-small 更差** — 不仅第一段误标 Person（且 score 从 0.846 升到 0.914，更"自信地"犯错），还把第二段"想做稳健理财"也标为 Person。==

**Case: `zh_lend`** — "我有10万块钱,想借给葛瑞刚"

| 层 | GLiNER-small NER | GLiNER-RelEx | gemma4-e4b |
|----|-----------------|--------------|------------|
| 实体 | `[我有10万块钱]` → Person (0.818) ❌ | `[我有10万块钱]` → Person (0.754) ❌ + `[想借给葛瑞刚]` → Person (0.369) ❌ | `10万块钱` → RESOURCE ✅ + `葛瑞刚` → PERSON ✅ |
| 关系 | — | 0 | MENTIONS("用户希望将10万块钱借给葛瑞刚") ✅ |
| 事件 | — | — | "用户表示有10万块钱，并希望借给葛瑞刚" ✅ |

> ==**关键差异**：GLiNER 两个变体**完全无法识别**人名"葛瑞刚"——它被包裹在更长的 span "想借给葛瑞刚" 中整体标为 Person。gemma4-e4b 不仅正确提取了人名，还建立了金额与人之间的语义关系。==

#### 4.4.3 英文场景逐 Case 详解

**Case: `en_flight`** — "Book a flight from Shanghai to Beijing tomorrow morning."

| 层 | GLiNER-small NER | GLiNER-RelEx | gemma4-e4b |
|----|-----------------|--------------|------------|
| 实体 | 4个 ✅ (flight, Shanghai, Beijing, tomorrow morning) | 4个 ✅ (flight, Shanghai, Beijing, tomorrow) | 3个 ✅ (Shanghai, Beijing, tomorrow morning) |
| 关系 | — | 3条 ✅ flies_from(0.944), flies_to(0.931), scheduled_on(0.927) | 3条 ✅ (MENTIONS Shanghai→Beijing, RELATES_TO time) |
| 评价 | 实体完整 | **关系最精准**——行程域标签完全匹配 | 实体少了 flight；关系用通用类型，语义稍弱 |

> ==**这是 GLiNER/RelEx 的最佳工况**：英文 + 行程域 + 清晰 token 边界 + 关系标签与训练域对齐。在此场景下 Encoder 与小 LLM 基本持平，Encoder 甚至略优（关系标签更精确）。==

**Case: `en_code_mixed`** — "The user in our Shanghai office called the LangChain API from Python..."

| 维度 | GLiNER-RelEx | gemma4-e4b |
|------|-------------|------------|
| 实体数 | 7 | 5 |
| 实体质量 | ✅ 丰富，但 LangChain API 标为 Concept 而非 RESOURCE/TOOL | ✅ 语义类型更准（RESOURCE, CONCEPT 区分合理） |
| 关系数 | 10（含大量重复） | 8（无重复） |
| 关系质量 | ⚠️ 含 `scheduled_on(LangChain API→tomorrow)` 等串味 | ✅ INVOKES(Python→LangChain API), PRODUCES(hotfix→billing service) 语义正确 |
| 额外能力 | — | ✅ 拆出两个事件 + 推断出事件时序 PRECEDES |

#### 4.4.4 方案 D 核心结论

| 维度 | GLiNER-small (NER only) | GLiNER-RelEx (联合) | gemma4-e4b (~4B) |
|------|------------------------|--------------------|--------------------|
| **中文实体** | ❌ 全军覆没（整句/长 span 误标） | ❌ 同样覆没，甚至更"自信地"犯错 | ✅ 精准识别（上海、10万闲钱、葛瑞刚） |
| **英文实体** | ✅ 好 | ✅ 好 | ✅ 好（略少但类型更准） |
| **中文关系** | — | ❌ 0 条有效关系 | ✅ 语义关系+fact_text |
| **英文关系** | — | ✅ 行程域强；⚠️ 技术域串味 | ✅ 通用类型，无串味 |
| **事件抽取** | ❌ 无此能力 | ❌ 无此能力 | ✅ 含摘要、时间、参与者 |
| **结构化输出** | span + score | span + score + relation | 完整 JSON（entities + events + participants + relationships） |
| **参数量** | ~50M | ~86M | **~4B**（约 50-80 倍） |

==**一句话**：即便是 4B 级的小 LLM（gemma4-e4b），在中文场景上也**全面碾压**了 50M-86M 级 Encoder。在英文场景上两者持平，但 LLM 提供了 Encoder 完全无法输出的事件、参与者、fact_text 等高阶结构。**参数量差距约 50-80 倍，但质量差距是"能用 vs 不能用"的级别**。==

---

### 4.5 根因汇总表

| 根因                 | 影响范围   | 工程缓解措施           | 根本解法                          |
| ------------------ | ------ | ---------------- | ----------------------------- |
| GLiNER 中文 span 边界差 | 所有中文句  | 分句、规则过滤          | **换模型（已验证：小 LLM 可解）**         |
| 标签集过宽              | 零样本场景  | 按场景拆子集           | Schema 收敛+模型升级                |
| RelEx 关系串味         | 非训练域   | 关系白名单/场景分流       | **领域微调或换 LLM（已验证：小 LLM 无串味）** |
| NLI 依赖实体对          | 管道式全链路 | RelEx∪L1 并集、子句组对 | **小 LLM 一步到位输出实体+关系**         |
| 实验样本少（9条）          | 结论泛化性  | 扩展回归集            | 构建标注评测集                       |

---

## 第 5 章 业界实践对照（2025-2026）

### 5.1 行业主流分三个梯队

| 梯队 | 做法 | 适用场景 | 代表 |
|------|------|---------|------|
| **T1: LLM 主抽取** | GPT-4o / Claude / Qwen + 结构化输出 | 复杂、多语言、开放域 | Microsoft GraphRAG、LightRAG |
| **T2: 小 LLM 抽取** | 7-8B 级模型（Qwen2.5-7B / Llama3.1-8B）+ LoRA 微调 | 成本敏感的规模化生产 | 越来越多的工业落地 |
| **T3: Encoder 模型** | BERT/DeBERTa/GLiNER | 高吞吐英文结构化文本 | 传统 NLP 管线（向 T1/T2 迁移中） |

**关键趋势**：在**离线批量知识图谱构建**场景，LLM-first 已全面落地（GraphRAG / LightRAG 均无 Encoder 参与）。在**实时 agent 会话处理**场景，主流做法是小 LLM 本地部署（7-8B 量化）或 API 异步调用配合队列缓冲。纯 Encoder 方案正退出通用 IE 的叙事中心，但在高吞吐英文结构化文本场景仍是最经济的选择。

### 5.2 大厂做法

| 公司 | 做法 | 要点 |
|------|------|------|
| **Microsoft（GraphRAG）** | 纯 LLM 管线（**离线批量构建**） | GPT-4/4o 做全部实体/关系/社区摘要抽取，无 Encoder 模型参与。注意：GraphRAG 面向**静态文档库 Q&A**，可容忍单条 3-5s 延迟，与 AMS 实时会话流场景不同 |
| **Google** | 历史用 BERT 集成，正转向 Gemini | 结构化域保留专用模型，开放域用 LLM |
| **Amazon** | 工具包方式 | Claude/Titan via Bedrock 抽取 → Neptune 存储 |

### 5.3 中文实体关系抽取的现实选型

| 方案 | 模型 | 中文 NER F1（参考） | 生产就绪度 |
|------|------|-------------------|-----------|
| **提示式 LLM** | Qwen2.5-7B/14B | 85-92% | ★★★★★ |
| **API LLM** | GPT-4o / Claude | 90%+ | ★★★★★ |
| **微调 BERT** | Chinese-BERT-wwm + CRF | 90-95%（需标注数据） | ★★★★☆ |
| **零样本 Encoder** | GLiNER / mDeBERTa 零样本 | 60-75%（中文） | ★★☆☆☆ |

### 5.4 联合抽取的学术前沿

| 方向 | 代表 | 说明 |
|------|------|------|
| Encoder 联合模型 | OneRel / UniRel / PRGC | 英文基准（NYT, WebNLG）强，零样本/开放域弱 |
| Code-LLM IE | GoLLIE (2024) | 用 Python class 定义 schema，LLM 抽取，新颖有效 |
| 指令式统一抽取 | InstructUIE / USM | 统一指令格式，多任务单模型 |

==**趋势判断**：联合抽取正从"特殊架构"走向"LLM prompt 工程"。GPT-4 / Qwen2.5 配合良好设计的 prompt 即可做联合抽取，不再需要专门的联合模型。==

---

## 第 6 章 原报告结论审查

### 6.1 原报告哪些结论正确

| 结论                        | 验证结果                      |
| ------------------------- | ------------------------- |
| "GLiNER 在中文会话上表现远逊预期"     | ✅ **正确**，与社区已知问题一致        |
| "RelEx 是联合抽取，不是两阶段串行"     | ✅ **正确**                  |
| "中文 Session 需以 LLM 为主"    | ✅ **正确**，与业界趋势一致          |
| "Encoder 在英文 Trace 上仍有价值" | ✅ **正确**                  |
| "bert-test 的高分不可泛化"       | ✅ **正确**，C2 的人工先验不代表自动化效果 |

### 6.2 原报告哪些结论需要修正或补充

| 结论 | 问题 | 建议修正 |
|------|------|---------|
| "Layer1+2 覆盖 60-70%" | **过于乐观且未分语言**。中文场景可能只有 10-20% 有效覆盖 | 改为"英文结构化文本 50-70%；中文会话 10-30%"，并注明需扩大样本验证 |
| "Encoder 打底 + LLM 精修" | **叙事重心偏差**。业界已转向 LLM-first，Encoder 是可选补充而非"底座" | 改为"LLM 主抽取 + Encoder 选择性打底（英文 Trace/降级场景）" |
| "混合架构成本~$50-80/天" | **前提不成立**（假设 Encoder 能分担大量抽取工作）。中文场景下 LLM 仍需处理绝大多数 block | 改为"中文场景成本~$200-250/天；未来如用本地 7B 模型可降至 $30-50/天" |
| 原报告对小 LLM 方案缺乏实测 | **已补充**：方案 D（gemma4-e4b）实测数据见 §4.4，中文场景全面验证了小 LLM 优势 | ✅ 已在本版补充。后续可扩展到 Qwen2.5-7B / Qwen3-8B 对比 |
| 实验样本量（9条） | **不足以支撑统计显著性结论** | 扩展至 50-100 条标注样本，覆盖更多中文场景 |

### 6.3 原报告的结构性问题

| 问题 | 具体表现 |
|------|---------|
| **命名空间冲突** | 脚本 Layer3 = 规则过滤 vs 设计文档 Layer3 = LLM，全文最大混淆源 |
| **多方案叠写** | A/B/C1/C2 四套方案共用 GLiNER 一词，读者容易混同 |
| **证据分散** | 代码在 scripts/、结果在 data/、demo 在用户本机 bert-test/、生产说明在 docs/ |
| **理论与实验脱节** | 第 2-3 章 NLP 理论很详细，但未直接解释"为什么中文 GLiNER 会失败" |

---

## 第 7 章 推荐方案与设计文档修订建议

### 7.1 推荐架构（修订后）

```
                    定位            适用场景            成本
                    ↓               ↓                  ↓
路径 A: 本地小 LLM   主抽取器         中文会话+混合场景    低
├── Qwen2.5-7B（或同级）
├── 结构化输出（JSON mode / constrained decoding）
├── 一次调用同时输出：实体 + 关系 + 置信度
└── 可选 LoRA 微调（AMS 域数据积累后）

路径 B: Encoder     辅助快筛/降级     英文 Trace/离线      极低
├── GLiNER-RelEx（联合抽取）
├── 仅处理英文技术文本 + Trace
└── 作为 LLM 不可用时的降级通道

路径 C: 大 LLM      高阶推理          不可替代的子任务      高
├── Foresight（validity_reasoning、invalid_at 预测）
├── 开放关系发现（SCREAMING_SNAKE_CASE 自动生成）
├── 跨句因果推断
├── fact_text 自然语言改写
└── 纠错与补漏（审校小 LLM 输出）
```

**架构叙事变化**：从"Encoder 打底 + LLM 精修" → **"小 LLM 主抽取 + Encoder 选择性辅助 + 大 LLM 精修不可替代环节"**

### 7.2 对设计文档第 5 章的逐条修订建议

| 位置                             | 当前内容                                | 建议修改                                                      |
| ------------------------------ | ----------------------------------- | --------------------------------------------------------- |
| **§5.1 设计思路**                  | "Encoder 打底 + LLM 精修"               | → "**LLM 主抽取 + Encoder 选择性打底**"。保留混合架构思想，但调整主次关系          |
| **§5.1 关键洞察1**                 | "Encoder-only 模型更快更准"               | → 增加限定条件："**在英文标准语料、封闭标签、边界清晰的场景下**"。中文会话需另行评估            |
| **§5.2 "Layer 1+2 覆盖 60-70%"** | 全局一刀切                               | → **分数据源陈述**："英文 Trace：50-70%；中文 Session：10-30%（需扩大样本验证）" |
| **§5.2 成本估算**                  | 混合架构 ~$50-80/天                      | → 中文场景 ~$200-250/天（现阶段）；引入本地 7B 模型后可降至 ~$30-50/天          |
| **§5.3 Layer 1 模型选型**          | 仅列 GLiNER-RelEx 和 ModernBERT        | → 增加 **Qwen2.5-7B / Qwen3-8B** 作为 Layer 1 替代选项，标注其中文优势    |
| **§5.3 调用方式**                  | `predict_entities_and_relations` 示例 | → 增加小 LLM 结构化输出的调用示例                                      |
| **§5.5 Layer 3**               | LLM 从 Layer 1+2 结果增强                | → 调整为"小 LLM 初步抽取 → 大 LLM 仅精修复杂子任务"，并明确大 LLM 是否需要跑全量 block |
| **§5.6 阶段规划**                  | 验证期仅对比 GLiNER vs LLM                | → 增加 **Qwen2.5-7B 抽取实验**作为验证阶段的优先项                        |
| **新增**                         | 无                                   | → 增加 **§5.7 中文 Encoder 已知局限与缓解策略**，引用本报告实验数据              |

### 7.3 小 LLM 替代 Encoder 的成本-质量对比（含实测数据）

| 维度 | GLiNER-RelEx (86M) | **gemma4-e4b (~4B) 实测** | Qwen2.5-7B (本地，预估) | GPT-4o-mini (API) |
|------|--------------------|--------------------------|------------------------|--------------------|
| 中文 NER 质量 | 低（❌ 整句误标） | **高（✅ §4.5 实证）** | 很高（F1 ~85-92%） | 最高（F1 ~90%+） |
| 英文 NER 质量 | 中高 | **高（✅ 与 GLiNER 持平）** | 高 | 很高 |
| 关系抽取 | 联合但串味 | **✅ 无串味，语义类型正确** | 提示式，可控 | 提示式，质量最高 |
| 事件抽取 | ❌ 无此能力 | **✅ 含摘要/时间/参与者** | ✅ 更强 | ✅ 最强 |
| 延迟/条 | 10-40ms | **CPU: 5-15s；GPU(Q4量化): 0.5-2s** | GPU: 200-500ms | 500-1500ms |
| 显存需求 | ~2GB | **~4-6GB** | ~16GB（FP16） | 无（云端） |
| 日均成本(万block) | ~$0 | **~$3-8（电费+折旧）** | ~$5-15（电费+折旧） | ~$50-100 |
| 维护复杂度 | 低 | **低（Ollama 一键部署）** | 中（需 GPU 服务） | 低 |

**实测结论**：gemma4-e4b 作为约 4B 参数的小 LLM，在 AMS 抽取任务上的性价比**已经超越** GLiNER 方案。考虑到 7B-8B 级模型（Qwen2.5-7B / Qwen3-8B）在中文上通常比 Gemma 系列更强，实际生产部署时**质量还会进一步提升**。

**建议**：优先实验 **Qwen2.5-7B 本地部署**。如果质量满足需求，它是性价比最高的选择——质量接近 GPT-4o-mini，成本远低于 API 方案。gemma4-e4b 的实测已证明方向可行，更大模型只会更好。

---

## 第 8 章 GLiNER/Encoder 线的剩余价值讨论

> 回答你的核心疑问："GLiNER + BERT 系列这条线的相对价值，还有多大？"

### 为什么"Encoder 打底"的叙事被高估了？

原始设计文档（第 5 章）把"Encoder 打底"的成立依据写为：

> "NER 和关系分类本质上是 token 级分类/句对分类任务，双向注意力具有结构性优势——Encoder-only 模型在这些任务上不仅更快，准确率也往往更高。"

**这句话本身没错，但它成立的隐含前提是：训练分布与推理分布对齐。**

GLiNER 的训练数据主要来自 PileNER（英文）和 Euro-GLiNER-x（12 种印欧语言，拉丁字母为主），在 subword embedding 层面对中文字符的覆盖非常有限。在这个前提下，"双向注意力的结构性优势"无法兑现——模型在预训练阶段**根本没有学好中文字符的 span 边界**。

这就解释了为什么一个 4B 的 decoder-only 模型（gemma4-e4b）能在中文场景碾压一个 86M 的 encoder-only 模型（GLiNER-RelEx）：前者在预训练阶段看过大量中文文本，建立了真实的字符级语义表示；后者的 span 预测头是在"没有见过中文边界"的前提下做零样本迁移，必然失败。

**根本原因不只是"训练数据中中文比例低"（表面现象），而是训练分布与推理分布的结构性错位（深层原因）。** Encoder 的理论优势只在训练分布内兑现，中文零样本场景根本不在分布内。

### 8.1 价值矩阵

| 场景 | Encoder 价值 | 说明 |
|------|------------|------|
| **英文 Trace 数据** | **高** | 工具名、API 名是明确 token，结构化字段多，Encoder 的速度优势可兑现 |
| **离线/内网降级** | **高** | 无 GPU/无网络时，86M Encoder CPU 推理仍可产出候选 |
| **高吞吐批量处理** | **中** | 万级/秒的吞吐需求下，Encoder 的成本优势显著 |
| **中文会话主抽取** | **低** | 当前开源权重无法胜任，不建议投入精力调优 |
| **通用关系抽取** | **低** | RelEx 串味问题需逐场景白名单，维护成本抵消了速度收益 |

### 8.2 值不值得继续投入？

**短期（3-6个月）**：保留现有 Encoder 代码作为英文 Trace 处理通道和降级 fallback，**不再为中文场景投入 Encoder 调优**。将精力转向小 LLM 抽取实验。

**中期（6-12个月）**：观察三个信号——
1. **GLiNER2**（2025 EMNLP）已将原始 GLiNER 扩展为统一多任务 IE 框架（NER + 分类 + 层次化抽取），且衍生了 GLiREL（零样本关系抽取）和 GLiClass（零样本分类）。但其底层仍是 Encoder，中文 subword 问题未根本解决 → 关注其后续是否引入字符级中文支持
2. 如果 Knowledgator 发布 **ModernBERT-large 版 RelEx**（8192 上下文），且中文表现有显著提升 → 重新评估
3. 如果本地 7B LLM 推理成本持续下降（量化、推测解码等） → Encoder 的成本优势进一步被压缩

**长期**：大概率 Encoder 专用模型将收敛为**特定高频子任务的加速器**（类似 YOLO 之于视觉），而不是通用抽取方案的核心组件。

### 8.3 一个理性的中间路线

```
               ┌─────────────────┐
               │   路由判断       │
               │ (语言+数据源)    │
               └───────┬─────────┘
                       │
          ┌────────────┼────────────┐
          ↓            ↓            ↓
   英文 Trace      中文 Session    复杂子任务
   ┌────────┐    ┌──────────┐    ┌──────────┐
   │Encoder │    │小 LLM    │    │大 LLM    │
   │(GLiNER)│    │(Qwen 7B) │    │(GPT-4o)  │
   └────────┘    └──────────┘    └──────────┘
   ~20ms, $0     ~300ms, $$      ~1.5s, $$$
```

这保留了混合架构的智慧（不同任务用不同最优工具），但**把 Encoder 从"底座"降级为"一条分支"**。

---

## 第 9 章 下一步行动项

| 优先级 | 行动 | 预期交付 | 状态 |
|--------|------|---------|------|
| **P0** | ~~用小 LLM 跑同样 Case，对比质量~~ | ~~实验报告 + 对照表~~ | ✅ 已完成（gemma4-e4b，见 §4.4） |
| **P0** | 用 **Qwen2.5-7B / Qwen3-8B** 跑同样 Case，与 gemma4-e4b 对比中文质量 | 补充对照表 | 待做 |
| **P0** | 扩展测试集至 50-100 条标注样本 | 评测集 + 评测框架 | 待做 |
| **P1** | 实验 constrained decoding（Outlines / vLLM）确保 JSON 输出可靠性 | 工程 PoC | 待做 |
| **P1** | 更新设计文档第 5 章（按 §7.2 修订建议） | 文档更新 PR | 待做 |
| **P2** | 构建语言/数据源路由逻辑原型 | 路由模块代码 | 待做 |
| **P2** | Encoder 限定为英文 Trace 通道 + 降级 fallback，简化中文路径 | 架构重构 | 待做 |

---

## 附录

### A. 模型速查表

| Hugging Face ID | 类型 | 参数量 | 角色 |
|-----------------|------|--------|------|
| `urchade/gliner_small-v2.1` | NER | ~50M | 方案 D GLiNER NER 对照 |
| `urchade/gliner_multi-v2.1` | NER（多语言） | ~200M | 方案 B Layer1 |
| `knowledgator/gliner-relex-multi-v1.0` | 联合 NER+RE | ~86M | 方案 B RelEx / C1 / D 对照 |
| `knowledgator/modern-gliner-bi-base-v1.0` | Bi-encoder NER | ~350M | 基准对照 |
| `MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7` | NLI | ~86M | NLI 关系分类 |
| **`gemma4-e4b:latest`（Ollama）** | **小 LLM（Decoder-only）** | **~4B** | **方案 D 小 LLM 对照** |

### B. 复现命令

```bash
# 方案 A: 多模型 NER 对比
python scripts/ams_gliner_model_benchmark.py

# 方案 B: 完整管线报告
python scripts/ams_ie_encoder_pipeline_report.py

# 方案 B: 跳过 NLI
python scripts/ams_ie_encoder_pipeline_report.py --skip-nli

# 方案 D: 小 LLM vs GLiNER 三路对照（需先启动 Ollama）
# ollama pull gemma4-e4b
# 数据产物: small_llm_vs_large_gliner_report.json
```

### C. 术语表

| 术语 | 含义 |
|------|------|
| NER | Named Entity Recognition，命名实体识别 |
| RE | Relation Extraction，关系抽取 |
| NLI | Natural Language Inference，自然语言推理 |
| Span | 文本中的连续子串片段 |
| 联合抽取 | 单模型一次前向同时预测实体+关系 |
| 管道式 | NER → 组对 → 关系分类的串行流程 |
| 零样本 | 不需要目标任务标注数据，通过标签描述或模板工作 |
| Constrained Decoding | 约束 LLM 输出格式（如强制 JSON schema） |
| Foresight | AMS 设计中的时效预测能力（validity_reasoning / invalid_at） |

---

[[GLiNER实体关系抽取问题]]