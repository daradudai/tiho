# Tiho Engine

Optional local GPU server for the [Tiho](../README.md) extension. It runs the
[Clef-Flash](https://huggingface.co/Cloudflare/clef-flash) decision model (9B, Apache-2.0)
through llama.cpp's `llama-server` and answers two kinds of questions about chat messages:

- **Custom filters**: questions you write in plain language ("Is this message backseating the
  streamer's gameplay?", "Does it spoil the plot of Elden Ring?"). Each one comes back as a
  probability.
- **Second opinion**: the same 6-way category + 3-way tone schema the in-browser model was
  trained on (`toxic, spam, scam, noise, question, clean` + `positive, negative`), for messages
  the in-browser model is unsure about. These are softmax probabilities on another scale than
  the in-browser model's: the extension averages them with its own scores, each against
  thresholds calibrated for its model, and never compares them with the in-browser thresholds.

A decision model gives a probability for every option of every question in one forward pass.
It never generates text, so it is fast and its output never needs parsing.

The engine is a small FastAPI app on `http://127.0.0.1:7377`. It starts and supervises its own
`llama-server` (or attaches to one you already run), and it batches, deduplicates, caches and
drops stale requests, because a chat answer that arrives after 3 seconds is no longer useful.

## Requirements

| GPU VRAM | Model file (auto) | Download | llama-server profile |
|---|---|---|---|
| 20 GB or more (RTX 3090/4090/5090) | `Clef-Flash-Q8_0.gguf` | 9.0 GiB | 8 slots, `-c 16384 -ub 2048` |
| 14 to 20 GB | `Clef-Flash-Q8_0.gguf` | 9.0 GiB | 4 slots, `-c 4096 -ub 1024` |
| 10 to 14 GB | `Clef-Flash-Q4_K_M.gguf` | 6.0 GiB | 4 slots, `-c 4096 -ub 1024` |
| 7.5 to 10 GB | `Clef-Flash-Q4_K_M.gguf` | 6.0 GiB | 2 slots, `-c 2048 -ub 1024` |
| less than that, or no NVIDIA GPU | `Clef-Flash-Q4_K_M.gguf` | 6.0 GiB | llama.cpp decides offload (`--fit`, slow) |

Q8_0 needs about 11 GB of **free** VRAM while running. If you game on the same GPU, use
`--quant Q4_K_M`.

You also need:
- Python 3.10+
- an NVIDIA driver for CUDA 12.4+ (Windows) or CUDA 12.8 (Linux)

Without NVIDIA, the engine uses the Vulkan build on Windows and Linux, and the regular build on
macOS.

On first start the engine downloads anything that is missing:
- **Model.** The GGUF from `huggingface.co/ggml-org/Clef-Flash-GGUF`. The download resumes if
  interrupted and is SHA-256 verified. It goes to `vendor/models/clef-flash/`, or to
  `--models-dir` / `TIHO_MODELS_DIR`.
- **llama.cpp.** Release **b11541** from GitHub, the first release with the Clef decision
  endpoint (PR #29831). It goes to `vendor/llama.cpp/`, or to `--llama-dir` /
  `TIHO_LLAMA_DIR`. On Windows with NVIDIA, the engine fetches
  `llama-b11541-bin-win-cuda-12.4-x64.zip` plus `cudart-llama-bin-win-cuda-12.4-x64.zip`. Every
  archive is checked against its pinned size and SHA-256 before it is unpacked. A replaced
  archive fails just like a corrupt model file.

To fetch everything without starting the server, use `--download-only`. To never download
anything, use `--no-download`.

These downloads come from their publishers under their own licenses: Clef-Flash under
Apache-2.0, llama.cpp under MIT, and the CUDA runtime archives under NVIDIA's CUDA Toolkit EULA.
None of them is part of this repository ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)).

## Run

```powershell
cd engine
.\start.ps1                                   # first run creates .venv, then starts llama-server + engine
.\start.ps1 --quant Q4_K_M                    # smaller model
.\start.ps1 --attach http://127.0.0.1:7378    # reuse a llama-server that already runs Clef-Flash
```

```sh
./start.sh                                    # Linux / macOS / Git Bash
```

You can also run `python -m tiho_engine --help` or `tiho-engine --help` inside `.venv`.
Startup takes about 5 to 30 seconds while the model loads. During that time `/health` reports
`"status": "loading"`.

**Managed mode** (the default) means the engine starts and owns the `llama-server` child:
- The child listens on `127.0.0.1:7379` and logs errors and warnings to `logs/llama-server.log`
  (at llama.cpp's default verbosity it would log three lines per request). For more detail, pass
  `--llama-args "-lv 3"`.
- It is locked with an API key that the engine makes up on every run, so only the engine can use
  it (see [Privacy and security](#privacy-and-security)).
- It is killed when the engine exits. On Windows a Job Object does this even after a hard kill
  or a closed console window; on Linux `PR_SET_PDEATHSIG` does the same.
- If it crashes, the engine restarts it, up to 3 times in 10 minutes. A restart that fails (for
  example because a game holds the VRAM) is tried again after 15 s, then 30 s.

**Attach mode** (`--attach URL`) uses a `llama-server` you run yourself. Start it with
`--api-key <key>` and pass the same key with `--attach-key <key>`. Without a key, any web page you
visit can use that server.

## How the extension connects

- `settings.engine.url` defaults to `http://127.0.0.1:7377`. Poll `GET /health`; every 10 s is
  plenty. `ok: true` means the engine is ready. Otherwise show `status` (`starting`, `loading`,
  `waiting_backend`, `backend_down` or `error`) together with `detail`.
- **Call the engine from the background service worker or the offscreen document, never from a
  content script.** Content-script fetches carry the page's origin (youtube.com), and the engine
  rejects it. The manifest already has `http://127.0.0.1/*` in `host_permissions`.
- Allowed origins are `chrome-extension://<32 a-p chars>`, `moz-extension://<uuid>` and
  `http(s)://localhost|127.0.0.1[:port]`. Add more with `--allow-origin`. The engine answers
  Chrome's Private Network Access preflight for these origins.
- Send up to 256 messages per request. Set `deadline_ms` to how long you are still willing to
  wait. Whatever is not done by then comes back as `{"id", "error": "expired"}`. Treat that as
  "no engine opinion".
- Under load some messages of a request expire, and a plain JSON answer then arrives at the
  deadline, even for messages that were done long before. Send `stream: true` to get each answer
  as soon as it is ready. The extension does (`extension/src/engine-client/client.ts`).
- **The engine refines a subset of messages; it cannot classify every message in a busy chat.**
  One RTX 3090 handles about 10 messages per second with 3 filters. Repeats and waves cost
  nothing because of the cache.
  - Send custom-filter questions only for messages that survived the Tier-0 rules.
  - Send `base: true` only for messages the in-browser model is unsure about.
  - `/health` → `queue.req_per_s_10s` and `queue.backend_ms_p50` show how much headroom is left.

## API

### `GET /health`

```json
{
  "ok": true,
  "status": "ready",
  "detail": "",
  "version": "0.1.0",
  "decision_model": "Clef-Flash-Q8_0",
  "device": "NVIDIA GeForce RTX 3090 (24 GB)",
  "mode": "managed",
  "backend": "http://127.0.0.1:7379",
  "queue": {"pending": 0, "inflight": 0, "inflight_limit": 2, "max_inflight": 8, "max_queue": 1024,
            "submitted": 0, "completed": 0, "deduped": 0, "expired": 0, "dropped": 0, "errors": 0,
            "backend_ms_p50": null, "backend_ms_p95": null, "req_per_s_10s": 0.0, "prompt_tok_per_s_10s": 0.0},
  "cache": {"size": 0, "max": 50000, "hits": 0, "misses": 0, "hit_rate": 0.0},
  "service": {"requests": 0, "messages": 0, "expired": 0, "budget": 2016},
  "limits": {"max_messages": 256, "max_filters": 32, "default_deadline_ms": 3000,
             "prompt_budget": 2016, "slots": 8, "isolate_base": false},
  "uptime": 12.3
}
```

### `POST /v1/classify`

Request:

```json
{
  "messages": [
    {"id": "m1", "text": "bro just jump on the left ledge, why are you going right??",
     "author": "bob", "channel": "xqc", "platform": "twitch"}
  ],
  "filters": [
    {"id": "backseat", "question": "Is this message backseating the streamer's gameplay?"},
    {"id": "spoiler",  "question": "Does it spoil the plot of Elden Ring?"}
  ],
  "base": true,
  "deadline_ms": 3000,
  "context": "Streamer is playing Elden Ring, first playthrough"
}
```

Fields:
- **`messages`**
  - `id`: a string or number, echoed back.
  - `text`: up to 4000 chars; the model sees at most the first 600.
  - `platform`: `twitch`, `youtube` or `kick`. Anything else becomes "live-stream".
  - `author`, `channel`: accepted, but not sent to the model.
- **`filters`**: up to 32. Each `question` is up to 500 chars, phrased as a yes/no question about
  "this message". Identical questions are asked only once.
- **`base`** (default false): also ask the teacher's category + tone schema.
- **`deadline_ms`** (default 3000): `0` means wait as long as it takes.
- **`context`** (optional, up to 300 chars): added to the state as `Stream context: ...`. It
  helps filters such as spoilers and backseating. Without it, the state is exactly the teacher's:
  `"<Platform> live chat message: <text>"`.
- **`stream`** (default false): answer as NDJSON instead, see below.

Response:

```json
{
  "results": [
    {"id": "m1",
     "filters": {"backseat": 0.8733, "spoiler": 0.1499},
     "base": {"toxic": 0.006, "spam": 0.015, "scam": 0.0075, "noise": 0.0196, "question": 0.2986,
              "clean": 0.6534, "positive": 0.0131, "negative": 0.031},
     "cached": false},
    {"id": "m2", "error": "expired"}
  ],
  "ms": 183.2,
  "expired": 1
}
```

- **`base`** maps the `cat` probabilities to `toxic, spam, scam, noise, question, clean`, and the
  `tone` probabilities to `positive, negative`. This is the same mapping as
  `ml/teacher/label.py`.
- **`error`** is one of:
  - `expired`: the deadline passed.
  - `overloaded`: the queue was full and the request was dropped.
  - `backend_unavailable`
  - `backend_error`
- **HTTP 503** with `{"error": {"code": "<status>", ...}}` means the engine is not ready.
  **HTTP 422** means the request is invalid.

With `"stream": true` the response is `application/x-ndjson`: one line per message, written as
soon as that message is answered, in the order the answers are ready rather than request order.
Messages that are not done by the deadline follow with their `error`. The last line sums up:

```
{"id":"m2","filters":{"backseat":0.0643,"spoiler":0.0121},"cached":false}
{"id":"m1","error":"expired"}
{"done":true,"ms":2500.4,"expired":1}
```

### `POST /v1/systemone`

A raw Jev/SystemOne passthrough for power users. The body is the same as llama-server's, and it
is queued, deduped and cached like everything else. Differences from calling llama-server
directly:
- A missing `instructions` defaults to the question id. This is the reference behaviour;
  llama-server alone rejects the request.
- A missing `model` defaults to `clef-flash`.
- An optional `deadline_ms` is accepted.

```json
{"model": "clef-flash", "state": "Twitch live chat message: hello chat!",
 "questions": {"greeting": {"type": "noul", "instructions": "Is this a greeting?"},
               "hype": {"type": "score", "instructions": "How hyped is it?", "criteria": ["calm", "some", "very"]},
               "lang": {"type": "choice", "instructions": "Language?", "criteria": {"en": "English", "other": "Other"}}}}
```

## What happens to a request

1. **One llama-server request per message.** All questions for one message (base and filters) go
   into a single systemone request. Prompt size is roughly:
   - 64 tokens of template, plus the message
   - about 75 to 100 tokens per filter
   - about 290 tokens for the base schema
2. **Splitting.** For a decision model, llama.cpp requires each request to fit one physical batch
   (`-ub`) and one slot (`-c / -np`).
   - The engine estimates prompt size without a tokenizer. The estimate errs on the high side and
     was calibrated against `/tokenize`.
   - Questions are packed into as few requests as fit. The base pair always stays together.
     Very long messages are cut.
   - If llama-server still answers "input is too large", the engine splits that request in half,
     retries, and learns the real limit.
3. **Cache and dedup.**
   - The LRU cache holds 50k entries, keyed by (platform, context, cleaned text, exact question
     set).
   - Cleaning only removes invisible characters and collapses whitespace. Case, repeated
     characters and zalgo are kept because they change the answer.
   - Identical requests already in flight share one llama call, so a wave of 37 × "KEKW" costs
     one call.
4. **Scheduling.**
   - The queue is LIFO: under overload the newest messages go first and old ones expire.
   - A queued request that can no longer finish before its deadline is dropped without reaching
     the GPU.
   - When the queue is full, the oldest requests are dropped.
5. **Adaptive concurrency.** llama.cpp runs decision requests one at a time, whatever its slot
   count. More requests in flight only queue inside llama.cpp, where they can be neither reordered
   nor dropped, and llama.cpp serves them unfairly.
   - On an RTX 3090 (1 filter): 1 in flight gave 18 req/s at 54 ms; 2 gave 20 req/s at 109 ms;
     4 to 16 gave the same 20 req/s, but some requests waited up to 2.5 s.
   - The in-flight limit starts at 2: one request running, the next one ready.
   - It grows by 1 while requests that run next to others take about as long per prompt token as
     one that runs alone. That happens only on a backend that really runs them in parallel. The
     limit never goes above the server's slot count (or `--max-inflight`).
   - It shrinks (×0.75) when requests queue in the backend (1.5× slower than alone), or when
     answers take more than 70% of their deadline budget (a game or another client on the GPU).
   - In one contended run, a fixed 16 requests in flight gave 0.8 msg/s on time; 6 in flight
     gave 2.7 msg/s.
   - `--fixed-concurrency` turns this off and keeps `--max-inflight` requests in flight.

## Privacy and security

- The engine and its child llama-server bind to `127.0.0.1` only. Nothing leaves the machine.
- Message text is kept only in the in-memory cache and is never logged. The access log is off by
  default.
- The `Host` header must be `127.0.0.1` or `localhost`. This blocks DNS-rebinding attacks.
- CORS allows only extension and localhost origins. A POST with any other `Origin` gets 403
  before it reaches the model. This blocks "simple" cross-site POSTs from web pages.
- llama-server itself checks neither `Origin` nor `Host`. In managed mode it therefore gets a
  random API key on every run (`--api-key`, kept out of its log), and only `/health` answers
  without it. Otherwise any web page could read `/props` (its model path can show your user
  name), keep its slots busy so Tiho's answers miss their deadlines, or use your GPU. In attach
  mode, give your server a key and pass it with `--attach-key`.

## Performance

These numbers were measured on an RTX 3090 **while the same llama-server (`-np 16 -ub 1024`) was
busy labelling training data at full load** (about 8 to 9 req/s from 16 or more other clients).
They show the floor under heavy contention, not what a dedicated engine does:

| Test | Result (contended) |
|---|---|
| 1 message × 3 filters, sequential | p50 1.15 to 2.87 s; the engine adds ≈0 ms over a direct llama-server call (2875 vs 2836 ms in the same run) |
| 32 concurrent clients, 1 msg × 3 filters, no deadline | 2.2 to 4.6 msg/s |
| 4 clients × 32-message batches, no deadline | 3.0 to 4.8 msg/s |
| 32 clients, `deadline_ms` 3000 | 0.2 to 3.7 msg/s on time, depending on how loaded the GPU was |
| cached repeats (32-message request) | 3.6k to 4.2k msg/s, about 8 ms per request |

Expected on a dedicated 3090, not re-measured here. These estimates assume about 3.5k prompt
tok/s prefill and about 150 ms idle latency:

| Request | Prompt size | Throughput |
|---|---|---|
| 3 filters | ≈330 tokens | about 10 msg/s |
| `base` only | ≈355 tokens | about 10 msg/s |
| base + 3 filters | ≈610 tokens | about 6 msg/s |

Throughput is bound by prefill, so cost grows with the number of questions.

To benchmark a running engine:

```sh
.venv/Scripts/python bench/bench.py --url http://127.0.0.1:7377 --backend http://127.0.0.1:7379
```

## Development

```sh
python -m uv venv .venv && python -m uv pip install --python .venv/Scripts/python.exe -e ".[dev]"
.venv/Scripts/python -m pytest -q -m "not integration"
TIHO_TEST_BACKEND=http://127.0.0.1:7378 .venv/Scripts/python -m pytest -q tests/test_integration.py
```

Without uv, `python -m venv .venv` and `.venv/Scripts/python -m pip install -e ".[dev]"` work too
(on Linux and macOS the interpreter is `.venv/bin/python`).

- Unit tests use a fake in-process backend.
- `tests/test_integration.py` (marker `integration`) talks to a real llama-server running
  Clef-Flash. It is skipped if none answers.
- Process-management tests use `tests/fake_llama_server.py`, so they need no GPU.
- CI runs the unit tests on Linux (Python 3.10 and 3.12) and Windows (Python 3.12).

Code layout (`tiho_engine/`):

| File | Contents |
|---|---|
| `schema.py` | prompt and state, base schema, size estimate, splitting |
| `scheduler.py` | queue, deadlines, dedup, cache, adaptive concurrency |
| `service.py` | `/v1/classify` logic |
| `backend.py` | llama-server client |
| `llama.py` | child process |
| `download.py` | model and llama.cpp downloads |
| `gpu.py` | VRAM profiles |
| `app.py` | HTTP layer |
| `__main__.py` | CLI |

## Gotchas

- **Joint scoring.** Clef answers all questions of one request jointly. With `base: true` plus
  filters in one request:
  - base probabilities move by up to about 0.05 compared with a base-only (teacher) request
  - filter answers move by up to about 0.15

  Results are deterministic either way. `base: true` without filters is always identical to the
  teacher. `--isolate-base` sends base in its own request, which gives teacher-identical numbers
  for about 70 extra prompt tokens per message.
- **Request size limit.** llama-server rejects decision requests larger than `-ub` with
  `input (N tokens) is too large ... batch size`. The engine handles this. If you attach it to
  your own server, give that server `-ub` ≥ 1024 and a per-slot context (`-c / -np`) ≥ `-ub`.
- **`instructions` is required.** llama-server rejects any question without `instructions`,
  although the reference implementation makes it optional. The passthrough fills it in.
- **Proxy variables.** `HTTP(S)_PROXY` is ignored for engine-to-llama traffic and honoured for
  downloads.
