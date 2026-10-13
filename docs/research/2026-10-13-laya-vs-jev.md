# Laya vs Jev: typed decision models, and whether they fit VTC

Date: 2026-10-13 · Read-only web research · Related: `docs/superpowers/specs/2026-10-12-vtc-system-design.md`

## 1. Identification

**What they are:** Jev and Laya are both **"System One" typed decision models**. You send them a *state* (text or JSON) plus typed questions, and they return typed answers with probabilities instead of generated text. There are three question types: **Choice**, **Score** (an ordinal rubric) and **Noul** (yes/no with a probability).

**Commonly compared:** yes. They launched three days apart in September 2026, and many "Jev vs Laya" posts compare them directly.

| Rank | Candidate | What it is | Fit |
|---|---|---|---|
| 1 | **Jev** by TypeSafe AI ([typesafe.ai](https://typesafe.ai), [docs.typesafe.ai](https://docs.typesafe.ai)) | Hosted, closed decision model (`typesafe/jev-1.13`). Launched 2026-09-15. | Certain |
| 1 | **Laya** by Convai Innovations ([GitHub](https://github.com/NandhaKishorM/laya), [HF](https://huggingface.co/convaiinnovations/laya), [PyPI](https://pypi.org/project/laya/)) | Open-weight (Apache-2.0) local decision model. Launched 2026-09-18 as an open alternative to Jev. | Certain |
| low | LayaAir (Layabox) | HTML5/3D game engine | Not relevant |
| low | Javy (Bytecode Alliance) | JS-to-Wasm toolchain | Not relevant |

The two near-spelling rows (LayaAir and Javy) come from prior knowledge and were not researched further.

## 2. Profiles

### Jev (TypeSafe)
- **License and model:** proprietary and hosted only. No weights. Architecture and parameter count are not disclosed.
- **Access:** **early access** according to the vendor homepage.
  - Direct API is at `console.typesafe.ai`.
  - Also available on OpenRouter (`POST /api/alpha/decisions`, `/api/v1/systemone`), AIMLAPI, OrcaRouter and the Vercel AI Gateway.
- **SDKs:** official JavaScript and Python SDKs.
- **Price:** about $0.042 per million input tokens. Output is free.
- **Context window:** 32K on OpenRouter; 64K according to OrcaRouter.
- **Latency:** about 150–280 ms p50 over the network. This is vendor or aggregator data.
- **Benchmarks:**
  - Typed-decisions zero-shot: 0.727 accuracy, ECE 0.144.
  - Banking77: 0.870.
- **Limitations:** the vendor documents weaknesses in exact calculation, date comparison and adversarial input. Rate limits are dynamic.
- **MCP and CLI:**
  - No official MCP server or CLI.
  - Small third-party MCP servers exist (`jev-judge-mcp`, about 69 stars; `jev-decision-mcp`, about 1 star). Both are very early.
- **Maturity:** about four weeks old. Version 1.13, early access, from a startup with no track record.

### Laya (Convai Innovations)
- **License:** Apache-2.0, for both code and weights.
- **Checkpoints:**

  | Checkpoint | Backbone | Params | Context |
  |---|---|---|---|
  | English | ModernBERT-large | 421M | 512 |
  | Multilingual | mmBERT-base | 322M | 1024, up to 8k |
  | Typed-decisions (fine-tuned) | ModernBERT-large | 421M | 1024 |

  All three are non-autoregressive and answer in a single forward pass with no sampling.
- **Activity:** repo created 2026-09-18; last push 2026-10-12.
  - 32.6k stars, 2.9k forks, about 125 open issues and PRs, and about 2,000 commits.
  - PyPI is at v0.4.6. The model has about 45k downloads a month on Hugging Face.
  - The star count is unusually fast for a repo that is 25 days old. Treat it as hype, not proof of maturity.
- **Tooling:**
  - `laya` CLI and `laya-evals` evaluation harness.
  - `laya-serve`: an HTTP server exposing **`/v1/systemone`, which is compatible with Jev's API**.
  - `laya-mcp-server`: an MCP stdio server, installed with `pip install laya[mcp]`.
  - ONNX and MLX ports, plus LangChain, LlamaIndex and CrewAI extras.
  - Fine-tuning notebooks (RLCD training and temperature calibration) for Kaggle T4 GPUs and Apple Silicon.
- **Benchmarks (from the model card):**
  - **Zero-shot is weak.** Typed-decisions accuracy is 0.362, below the 0.461 majority baseline.
  - The 0.766 headline result needs the checkpoint fine-tuned on that benchmark's training split.
  - Banking77: 0.425.
  - Accuracy degrades past about 20–50 options, and Score is the weakest question type.
  - Ships over-confident: mean ECE 0.466, falling to 0.081 after per-type temperature fitting.
  - The model card itself says it is "a fast base to specialise, not a zero-shot decision engine."
- **Latency:** about 33–40 ms per question on a T4 GPU. Apple Silicon or CPU speed is not published.

## 3. Head-to-head

| | Jev | Laya |
|---|---|---|
| Runs locally (VTC D1) | No. Code and specs leave the machine. | Yes |
| Extra credentials or provider (VTC D2, non-goal §1.2) | Yes. TypeSafe or OpenRouter key and billing. | No |
| Out-of-box accuracy | **Strong** (0.727 zero-shot) | Weak until fine-tuned |
| Calibration | Better raw | Good only after temperature fit |
| Context | 32–64K: enough for specs and diffs | 512–1024 (8k max): too small for diffs |
| MCP and CLI | Third-party only | **First-party MCP, CLI, HTTP** |
| Reproducibility and tracing | Opaque, version alias can drift | Pinned weights SHA; deterministic forward pass |
| Runtime cost | Nearly free per call, plus network | Free per call; Python, PyTorch and about 1–2 GB of weights; GPU preferred |
| Maturity and risk | Early-access vendor; pricing could change | Weeks old; hype metrics; benchmark claims mixed |

Benchmark caveat: the two sides' numbers do not come from the same test. Different prompts and samples were used, and Laya's best score comes from fine-tuning on the test's training split. Jev leads on soft accuracy and raw calibration.

## 4. Fit with VTC

**Where it fits:** a decision model is a middle tier between "code decides" and "an LLM decides" (D11). It fits steps that are cheap classifications today, which VTC would otherwise send to a Low-tier LLM:

| VTC step | Use |
|---|---|
| **INTAKE** | Track, UI yes/no, risk-hint flags. |
| **Risk Router**, advisory only | A semantic "touches auth/payments/migrations?" Noul. Must only **add** a park, never remove one. The deterministic glob rules stay authoritative. |
| **Triage and escalation** | Reason-category Choice. |
| **Lookback attribution** | Replace the "AI tiebreaker when the routing tree is inconclusive" with a Choice over {BA, QA, Engineer}. Human escalation labels then become fine-tuning data. |
| **Security and review** | Finding dedupe and severity Score. |

**Where it does not fit:**
- Visual QA, because it takes no images.
- Anything that needs reasoning or explanations.
- Anything that needs to see whole diffs, because Laya's context is too short.

**How to plug it in:** run `laya-mcp-server` (or `laya-serve`) as a second local MCP server that the engine calls. The engine is TypeScript, so calling the HTTP endpoint is simplest.
- Code against the System One schema, so that Jev could later be swapped in through the compatible `/v1/systemone` endpoint if a user opts in.
- Log the checkpoint SHA and calibration file in the trace (spec §1 goal 3).

## 5. Risks
- **Jev:**
  - Breaks D1 and D2 and the v1 non-goal (no third-party model providers).
  - Sends proprietary code to an early-access startup.
  - Pricing and rate limits are unstable.
- **Laya:**
  - Without fine-tuning on VTC's own labels it is near chance, and VTC has no labelled data yet.
  - Adds a Python/PyTorch runtime and large weights to a TypeScript engine; install friction for users.
  - Context limits and over-confidence; repo popularity may be inflated.
  - Calibration is per-task, so thresholds must be validated.
- **Both:**
  - About one month old, with mostly vendor or aggregator benchmarks.
  - Adding a model to gating decisions widens the trust surface.

## 6. Recommendation
- **"Which is better":** Jev is the better model out of the box. Laya is the better fit for VTC: local, Apache-2.0, first-party MCP, pinned and reproducible.
- **v1:** integrate **neither** into the core pipeline. D11 says code decides first, and the decision points that remain go to the host LLM.
- **v2 (optional):** add Laya as an **advisory, opt-in** decision tier, behind a feature flag. Steps:
  1. Collect labelled data from Lookback and escalations.
  2. Fine-tune and calibrate the model.
  3. Run `laya-evals` against the host-LLM baseline.
  4. Promote only those steps where it matches accuracy at lower token cost.
- **Never let either model relax a deterministic risk rule.**
- **Jev:** reject for VTC under the current constraints. At most it could serve as an offline benchmark reference.

## Sources
- https://github.com/NandhaKishorM/laya · https://api.github.com/repos/NandhaKishorM/laya · https://huggingface.co/convaiinnovations/laya · https://pypi.org/project/laya/
- https://typesafe.ai · https://docs.typesafe.ai · https://openrouter.ai/docs/guides/community/jev
- https://www.orcarouter.ai/de/blog/jev-vs-laya · https://wavect.io/zh/blog/laya-vs-jev-benchmark-ai-startup-moat/
- https://skillsllm.com/skill/jev-judge-mcp · https://mcpmarket.com/server/jev
