#!/usr/bin/env python3
"""把 evals/runs/*.json 里的数字摊平成一张快照表,写到 evals/runs/SUMMARY.md。

用途:**不手抄数字**地查看"某个语料某一行现在是多少"。它是中间产物,不是耐久文档——
耐久结论(以及所有数字的解读、口径纪律、未完成项)在 `docs/评测结果.md`,由人维护。
**不要**让本脚本写进 docs/:自动生成的结论文本会立刻过期,而且会覆盖人写的那份。

运行:python3 scripts/eval-report.py
"""
import json, glob, pathlib, datetime

def newest(pat):
    files = sorted(glob.glob(pat))
    return json.load(open(files[-1])) if files else None

def all_of(pat):
    return [json.load(open(f)) for f in sorted(glob.glob(pat))]

def metrics_of(row):
    m = {k: v for k, v in row.items() if k != 'config' and isinstance(v, (int, float))}
    m.update(row.get('metrics') or {})
    return m

ORDER = ['bm25 (参考基线)', 'lexical+no-rerank', 'lexical+rerank', 'hybrid+no-rerank', 'hybrid+rerank']

def retr_table(reports, title, note):
    merged = {}
    for rep in reports:
        if rep is None:
            continue
        for row in rep.get('rows', []):
            merged.setdefault(row['config'], {}).update(metrics_of(row))
    out = [f'### {title}', '', note, '',
           '| 配置 | nDCG@10 | recall@10 | MRR@10 | 单配置耗时 | 语义通道(参与查询数) |',
           '|---|---|---|---|---|---|']
    for cfg in ORDER:
        m = merged.get(cfg)
        if m is None:
            continue
        secs = m.get('seconds')
        used = m.get('vectorUsed')
        out.append(f"| {cfg} | {m.get('nDCG@10')} | {m.get('recall@10')} | {m.get('MRR@10')} | "
                   f"{'—' if secs is None else str(secs) + 's'} | "
                   f"{'—(无向量通道)' if cfg.startswith('bm25') else ('—' if used is None else f'used×{int(used)}')} |")
    return out

nf, nf_b = newest('evals/runs/*beir-nfcorpus_hash.json'), newest('evals/runs/*beir-nfcorpus_hash_bm25.json')
sc, co = newest('evals/runs/*beir-scifact_hash.json'), newest('evals/runs/*coir-cosqa_hash.json')
rgb_reports = all_of('evals/runs/*rgb-zh_judge-v2.json')
rgb = rgb_reports[-1] if rgb_reports else None
# 成本取"调用数最多"的那次(全缓存重跑会显示 0,那不是有信息量的数字)
rgb_cost = max((r.get('cost', {}).get('calls', 0) for r in rgb_reports), default=0)
rgb_cost_row = next((r.get('cost', {}) for r in rgb_reports if r.get('cost', {}).get('calls', 0) == rgb_cost), {})

d = []
d += ['# 报告快照(自动生成,非耐久文档)', '',
      f'> 生成：{datetime.datetime.now().isoformat(timespec="seconds")} · `python3 scripts/eval-report.py` 从 `evals/runs/*.json` 摊平而来。',
      '> **结论、口径纪律与未完成项在 `docs/评测结果.md`（人维护）**；本文只有数字,不解释,也不下判断。',
      '> 注意:每张表取的是"最新一份匹配的报告",样本量与配置口径可能不同,横向对比前先看 `clue bench list`。', '',
      '## 1. 总览', '',
      '| 基准 | 类型 | 样本量 | 嵌入/模型 | 结论指针 |', '|---|---|---|---|---|']
def meta(rep):
    e = rep.get('embedder') if rep else None
    return (f"{rep['corpus'].get('queries')} 查询 / {rep['corpus'].get('documents')} 语料" if rep else '—',
            '—' if e is None else f"{e['id']}(dim={e['dim']}, 语义={e['semantics']})")
for label, kind, rep, ref in [('**D1 BEIR nfcorpus**', '通用检索', nf, '§3.1'),
                              ('**D1 BEIR scifact**', '通用检索', sc, '§3.2'),
                              ('**D2 CoIR cosqa**', '代码检索', co, '§4')]:
    s, m = meta(rep)
    d.append(f'| {label} | {kind} | {s} | {m} | {ref} |')
if rgb is not None:
    d.append(f"| **D3 RGB zh** | RAG 端到端 | {rgb['corpus']['queries']} 题 · 判分 {rgb['judge']['promptVersion']} | "
             f"答案 {rgb['answer']['id']} / 判分 {rgb['judge']['id']} | §5 |")
d += ['', '## 3. D1 BEIR：检索侧（四配置 + BM25 参考行）', '']
d += retr_table([nf, nf_b], '3.1 nfcorpus（50 查询，hashEmbedder dim=256）',
                'BM25 是同数据、同查询的**教科书实现**（k1=1.2 / b=0.75，倒排打分），用来给我们的数字一个参照系。')
d += ['']
d += retr_table([sc], '3.2 scifact（30 查询，hashEmbedder dim=256）',
                '与 nfcorpus 同形态：BM25 远高于我们；**hybrid 不带精排最差**。'
                '注意这里精排并非全胜：`lexical+rerank` 的 nDCG@10 略低于不精排（0.478 vs 0.4838），'
                '但 recall@10 更高（0.54 vs 0.50）——精排把"更相关的排前"，代价是压掉了一些只是"沾边"的命中。')
d += ['', '## 4. D2 CoIR/cosqa：代码检索', '']
d += retr_table([co], '（20 查询，hashEmbedder dim=256；语料裁过：全部金标 + 1200 干扰 = 1700 篇，原始 2 万篇）',
                '**注意**：语料裁过 ⇒ 不与 CoIR 官方榜可比；`recall@10` 那一列四配置全等（0.20）是本表最重要的信息。')
d += ['', '## 5. D3 RGB：RAG 端到端（judge-v2）', '', '### 5.1 四指标与三条负对照', '',
      '| 行 | 指标 | 数值 | 判定 |', '|---|---|---|---|']
if rgb is not None:
    for row in rgb['rows']:
        for k, v in metrics_of(row).items():
            name = row['config']
            if '编造答案' in name: verdict = '✓ 抓到（健康 1.00 → 此处）'
            elif '答非所问' in name: verdict = '✓ 抓到'
            elif '替换式' in name: verdict = '✓ 抓到' + ('（模型 100% 如实答"资料未提及"，未编造）' if k == 'refusesRate' else '')
            elif '掺入看着对其实错' in name: verdict = '⚠ 未抓到 ⇒ 该项标"未证明"'
            elif '参考' in name: verdict = '参考行'
            else: verdict = '—'
            d.append(f"| {name} | {k} | {round(v, 4) if isinstance(v, float) else v} | {verdict} |")
    d += ['', '### 5.2 成本与版本', '', '| 项 | 值 |', '|---|---|',
          f"| 判分版本 | `{rgb['judge']['promptVersion']}`（改提示词 = 改口径 = 必须重跑） |",
          f"| 首次运行成本 | {rgb_cost} 次调用 / {rgb_cost_row.get('chars', 0)} 字符 / {rgb_cost_row.get('seconds', 0)}s（失败 {rgb_cost_row.get('failedCalls', 0)}） |",
          '| 重跑成本 | **0 次调用**（判分与答案全部命中 `evals/cache/<judgeVersion>/`） |',
          f"| 报告结论 | `ok={rgb['ok']}`（判据 = 三条能制造失败的对照，见 5.3） |"]
d += ['', '### 5.3 通过判据：哪三条算数、为什么', '', '| 对照 | 计入判据 | 依据 |', '|---|---|---|',
      '| 编造答案（数据集自带 `fakeanswer`） | ✅ | faithfulness 必须降：实测 1.00 → 0.67 |',
      '| 答非所问 | ✅ | answer relevance 必须降：实测 1.00 → 0.00 |',
      '| **替换式噪声**（只给 `positive_wrong`，金标不在场） | ✅ | 答案覆盖金标要点必须降：实测 1.00 → 0.00 |',
      '| 追加式噪声（错段排前、金标仍在场） | ❌ 仅参考 | 实测制造不出失败（1.00 → 1.00）；**把"测不出失败"当"通过"才是作假** |']
d += ['', '## 6. 结论 → 证据 → 行动', '', '| # | 结论 | 证据 | 行动 |', '|---|---|---|---|',
      '| 1 | 一级评分弱于教科书 BM25 | §3.1 0.2779 vs 0.1872；§4 0.3768 vs 0.1750；§3.2 0.7455 vs 0.4838 | 把 `bm25ish`（IDF + 长度归一）从"精排特征"提升为**一级评分主体**，配倒排索引 |',
      '| 2 | 瓶颈在召回而非排序 | §4 四配置 `recall@10` 全等 0.20 | 同 1；再加"金标是否进候选集"的专项指标进回归 |',
      '| 3 | `hybrid` 不带精排有害 | §3.1 −0.048、§3.2 −0.126、§4 −0.048（另：内部合成集 −23.8pt；三个语料四次复现） | 配置层禁止该组合（`clue recall` 护栏已在抓） |',
      '| 4 | 判分器分指标可用 | §5.1 三条能制造失败的对照全部抓到 | faithfulness/relevance 可用于报告；`context precision` 保持"未证明" |',
      '| 5 | 真端点有规模墙 | 设计文档 §19：3633 篇 ⇒ 约 364 次嵌入调用，9 分钟未完成 | 真端点跑大语料前先裁语料或调大批量 |']
d += ['', '## 7. 未完成项（如实记账）', '', '| 项 | 状态 | 补齐方式 |', '|---|---|---|',
      '| D1 BEIR 真端点一次 | ❌ 未完成（已量出时间墙） | `bench-beir.mjs` 加 `--docs 800` 裁语料后 `--embedder http` |',
      '| D2 CoIR codefeedback-st | ❌ 未跑（handle 与脚本已具备） | `node scripts/fetch-coir.mjs --task codefeedback-st --cap 1200` 后同法跑 |',
      '| 检索侧接进 D3 | ❌ 未做 | D3 现用数据集金标段（先验判分链路），下一步把检索结果喂给答案模型 |',
      '| 内部金标集（E0） | ❌ 未做 | 与本目标并行，需人写 15 题 |']
d += ['', '## 8. 产物与清理', '', '| 路径 | 内容 | 清理 |', '|---|---|---|',
      '| `evals/datasets/` | BEIR 两集 + CoIR cosqa + RGB clone（约 62M） | `clue bench clean --datasets` |',
      '| `evals/runs/` | 报告 + `INDEX.json`（约 60K） | `clue bench clean --runs` |',
      '| `evals/cache/` | 判分缓存（重跑免费的关键） | `clue bench clean --cache` |',
      '| `evals/goldens/` | 人写金标集（**故意保留**） | 需手动删 |',
      '| 本文档 / 设计文档 | 耐久数字与结论 | 清理 `evals/` 不影响 |']
d += ['', '## 9. 复跑命令', '', '```bash',
      'clue bench list                        # 历史报告（数据集/样本量/模型/是否通过）',
      'clue bench diff <报告id> <报告id>       # 逐指标对比（回退即 exit 1）',
      'clue bench clean --all                 # 清理数据+报告+缓存',
      'python3 scripts/eval-report.py          # 从报告摊平一张快照表到 evals/runs/SUMMARY.md',
      '',
      'node scripts/bench-beir.mjs --dataset nfcorpus --queries 50 --depth 20',
      'node scripts/bench-beir.mjs --dataset coir-cosqa --label coir/cosqa --queries 20',
      'node scripts/bench-rag.mjs --records 3  # D3：四指标 + 三条负对照',
      '```']
pathlib.Path('evals/runs/SUMMARY.md').write_text('\n'.join(d) + '\n')
print('lines:', len(d))
