const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || "main";

const JARVIS_PASSKEY = process.env.JARVIS_PASSKEY || "";

// Every /api/* route is locked behind a shared passphrase. Without this,
// anyone with the URL — not just you — can talk to Jarvis, spend your API
// credits, and now also read your repo and open pull requests through the
// GitHub tools below. /health stays open so you can always check status.
function requireAuth(req, res, next) {
  if (!JARVIS_PASSKEY) {
    return res.status(503).json({
      error: "Server misconfigured: set JARVIS_PASSKEY in your environment variables."
    });
  }
  const provided = req.get("x-jarvis-key") || "";
  if (provided !== JARVIS_PASSKEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const DATA = path.join(__dirname, "data");
const LAB = path.join(__dirname, "evolution-lab");

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(LAB, { recursive: true });

const files = {
  memory: path.join(DATA, "memory.json"),
  journal: path.join(DATA, "learning-journal.json"),
  events: path.join(DATA, "evolution-events.json")
};

const read = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};

const write = (p, value) => {
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
};

if (!fs.existsSync(files.memory)) {
  write(files.memory, { facts: [], preferences: [], goals: [], projects: [] });
}
if (!fs.existsSync(files.journal)) write(files.journal, []);
if (!fs.existsSync(files.events)) write(files.events, []);

const SYSTEM = `You are JARVIS, an expandable personal AI assistant.
You have long-term structured memory, image understanding, optional OpenAI fallback,
and a self-improvement laboratory.

You may learn useful information and save it to memory.
You may create candidate improvements in the isolated evolution lab.
Never silently overwrite production code.
Notify the user when you identify a meaningful evolution.
Never expose API keys.
Be capable, calm, concise and transparent.

When you use github_propose_change to edit your own source code, follow these
rules strictly:
- Make the smallest possible diff for the requested task. Change only the
  lines needed to accomplish exactly what the user asked for.
- Never change model identifiers, model names, or their default values
  (e.g. GEMINI_MODEL, OPENAI_MODEL, or their hardcoded fallback strings)
  unless the user's request is specifically about changing which model is
  used. You do not reliably know which model names are still valid, since
  that changes after your training — the user or the running code is the
  source of truth on this, not your own judgment.
- Never remove, weaken, or "simplify" authentication, security checks, or
  input validation as a side effect of an unrelated fix, even if it looks
  redundant or old to you.
- Never delete existing comments unless the code they describe was the
  specific thing you were asked to change.
- If a fix requires touching a section you don't fully understand the
  history of, say so in the PR description rather than rewriting it from
  scratch based on general assumptions about what that kind of code
  "usually" looks like.`;

function normalizeMessages(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: Array.isArray(m.content)
      ? m.content.map((c) => {
          if (c.type === "text") return { text: String(c.text || "") };

          if (c.type === "image_url" && c.image_url?.url) {
            const url = c.image_url.url;
            const match = url.match(/^data:(.*?);base64,/);
            if (match) {
              return {
                inline_data: {
                  mime_type: match[1] || "image/jpeg",
                  data: url.split(",")[1]
                }
              };
            }
          }

          if (c.type === "image" && c.source?.data) {
            return {
              inline_data: {
                mime_type: c.source.media_type || "image/jpeg",
                data: c.source.data
              }
            };
          }

          return { text: String(c.text || "") };
        })
      : [{ text: String(m.content || "") }]
  }));
}

function isRetryableGeminiError(status, message) {
  const text = String(message || "").toLowerCase();

  return (
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    text.includes("high demand") ||
    text.includes("temporarily") ||
    text.includes("overloaded") ||
    text.includes("unavailable") ||
    text.includes("try again later")
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGeminiModel(model, messages, extra = "", useWeb = false, allowGithubTools = false) {
  const memory = read(files.memory, {});
  const contents = normalizeMessages(messages);
  const body = {
    contents,
    systemInstruction: {
      parts: [
        {
          text:
            `${SYSTEM}\n\nMEMORY:\n${JSON.stringify(memory).slice(0, 16000)}\n\n${extra}`
        }
      ]
    }
  };

  const tools = [];
  if (useWeb) tools.push({ googleSearch: {} });
  if (allowGithubTools) tools.push({ functionDeclarations: GITHUB_TOOLS });
  if (tools.length) body.tools = tools;

  // Gemini requires this flag whenever a built-in tool (googleSearch) and a
  // custom function-calling tool are both present in the same request —
  // without it, the API rejects the whole call with a 400 INVALID_ARGUMENT,
  // which is why every message failed while both Web search and the GitHub
  // tools were active at once.
  if (useWeb && allowGithubTools) {
    body.toolConfig = { includeServerSideToolInvocations: true };
  }

  let lastData = null;
  let searched = false;

  // Allow a short sequence of tool calls, then require a normal final answer.
  for (let round = 0; round < 5; round++) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-client": "jarvis/1.0",
        "x-goog-api-key": GEMINI_KEY
      },
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));
    lastData = data;
    searched = searched || !!data.candidates?.[0]?.groundingMetadata;

    if (!response.ok) {
      const message =
        data?.error?.message || `Gemini request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.model = model;
      throw error;
    }

    const candidate = data.candidates?.[0];
    const candidateContent = candidate?.content;
    const parts = candidateContent?.parts || [];
    const functionCalls = parts
      .map((part) => part.functionCall)
      .filter(Boolean);

    if (!allowGithubTools || functionCalls.length === 0) {
      const text = parts.map((p) => p.text || "").join("");
      if (!text) {
        const error = new Error("Gemini returned an empty response.");
        error.status = 500;
        error.model = model;
        throw error;
      }
      return { text, raw: lastData, model, searched };
    }

    // Preserve Gemini's tool-call message exactly, then return each tool result.
    contents.push(candidateContent);
    const resultParts = [];

    for (const call of functionCalls) {
      try {
        const result = await executeGithubTool(call.name, call.args || {});
        resultParts.push({
          functionResponse: {
            name: call.name,
            response: { result },
            ...(call.id ? { id: call.id } : {})
          }
        });
      } catch (error) {
        resultParts.push({
          functionResponse: {
            name: call.name,
            response: { error: error.message },
            ...(call.id ? { id: call.id } : {})
          }
        });
      }
    }

    contents.push({ role: "user", parts: resultParts });
    body.contents = contents;
  }

  throw new Error("GitHub tool loop exceeded the safety limit.");
}

async function gemini(messages, extra = "", useWeb = false, allowGithubTools = false) {
  if (!GEMINI_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const primary = process.env.GEMINI_MODEL || "gemini-3.7-flash";

  const configuredFallbacks = String(
    process.env.GEMINI_FALLBACK_MODELS ||
      "gemini-3.6-flash,gemini-3.5-flash-lite"
  )
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const models = [...new Set([primary, ...configuredFallbacks])];
  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callGeminiModel(model, messages, extra, useWeb, allowGithubTools);
      } catch (error) {
        lastError = error;

        if (!isRetryableGeminiError(error.status, error.message)) {
          break;
        }

        if (attempt < 2) {
          const delay = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
          console.log(
            `Gemini ${model} unavailable; retrying in ${delay}ms...`
          );
          await sleep(delay);
        }
      }
    }

    console.log(`Gemini model ${model} failed; trying next fallback model.`);
  }

  throw lastError || new Error("All Gemini models failed.");
}

function toOpenAIInput(messages) {
  return messages.map((m) => {
    const role = m.role === "assistant" ? "assistant" : "user";

    if (!Array.isArray(m.content)) {
      return {
        role,
        content: String(m.content || "")
      };
    }

    const content = [];

    for (const c of m.content) {
      if (c.type === "text") {
        content.push({
          type: "input_text",
          text: String(c.text || "")
        });
      } else if (c.type === "image_url" && c.image_url?.url) {
        content.push({
          type: "input_image",
          image_url: c.image_url.url
        });
      } else if (c.type === "image" && c.source?.data) {
        content.push({
          type: "input_image",
          image_url:
            `data:${c.source.media_type || "image/jpeg"};base64,${c.source.data}`
        });
      }
    }

    return { role, content };
  });
}

async function openaiFallback(messages, extra = "") {
  if (!OPENAI_KEY) {
    throw new Error("OpenAI fallback is not configured.");
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.6";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model,
      instructions: `${SYSTEM}\n\n${extra}`,
      input: toOpenAIInput(messages)
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.error?.message || `OpenAI request failed (${response.status})`
    );
  }

  const text = data.output_text || "";

  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }

  return {
    text,
    raw: data,
    model
  };
}
async function githubRequest(endpoint, options = {}) {
  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not configured.");
  }

  if (!GITHUB_REPO) {
    throw new Error("GITHUB_REPO is not configured.");
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}${endpoint}`,
    {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.message || `GitHub API error: ${response.status}`
    );
  }

  return data;
}


async function githubGetBranch(branch) {
  return githubRequest(
    `/git/ref/heads/${encodeURIComponent(branch)}`
  );
}


async function githubCreateBranch(branch) {
  const base = await githubGetBranch(
    GITHUB_BASE_BRANCH
  );

  return githubRequest("/git/refs", {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branch}`,
      sha: base.object.sha
    })
  });
}


async function githubGetFile(filePath, branch) {
  const encodedPath = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  return githubRequest(
    `/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
  );
}


async function githubListFiles(branch = GITHUB_BASE_BRANCH) {
  const data = await githubRequest(
    `/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );

  return {
    branch,
    files: (data.tree || [])
      .filter((item) => item.type === "blob")
      .map((item) => item.path)
  };
}


async function githubUpdateFile({
  filePath,
  content,
  branch,
  message
}) {
  let existing = null;

  try {
    existing = await githubGetFile(
      filePath,
      branch
    );
  } catch (error) {
    if (!String(error.message).includes("Not Found")) {
      throw error;
    }
  }

  const body = {
    message,
    content: Buffer.from(
      content,
      "utf8"
    ).toString("base64"),
    branch
  };

  if (existing?.sha) {
    body.sha = existing.sha;
  }

  return githubRequest(
    `/contents/${filePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    {
      method: "PUT",
      body: JSON.stringify(body)
    }
  );
}


async function githubCreatePullRequest({
  branch,
  title,
  body
}) {
  return githubRequest("/pulls", {
    method: "POST",
    body: JSON.stringify({
      title,
      head: branch,
      base: GITHUB_BASE_BRANCH,
      body
    })
  });
}

const GITHUB_TOOLS = [
  {
    name: "github_status",
    description: "Check whether JARVIS can access its configured GitHub repository. Use this when the user asks whether GitHub is connected.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "github_list_files",
    description: "List files in the configured GitHub repository. Use this to inspect the repository structure before proposing a code change.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch to inspect. Defaults to the configured main branch." }
      }
    }
  },
  {
    name: "github_read_file",
    description: "Read the text of a file from the configured GitHub repository. Use this before proposing changes to that file.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Repository-relative file path, such as server.js or public/app.js." },
        branch: { type: "string", description: "Branch to read. Defaults to the configured main branch." }
      },
      required: ["filePath"]
    }
  },
  {
    name: "github_propose_change",
    description: "Create a proposed code change on a new branch and open a GitHub Pull Request for human review. ONLY use this when the user explicitly asks JARVIS to modify, implement, fix, or commit code. Never use it merely to explain or suggest code. Never modify .github files, environment files, or secret files.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Repository-relative file path to change." },
        content: { type: "string", description: "The complete replacement file content." },
        goal: { type: "string", description: "Short description of the requested change." }
      },
      required: ["filePath", "content"]
    }
  }
];

async function executeGithubTool(name, args = {}) {
  switch (name) {
    case "github_status": {
      const repo = await githubRequest("");
      return {
        ok: true,
        repository: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        github: true
      };
    }

    case "github_list_files":
      return await githubListFiles(args.branch || GITHUB_BASE_BRANCH);

    case "github_read_file": {
      const filePath = String(args.filePath || "").trim();
      if (!filePath) throw new Error("filePath is required.");
      const branch = String(args.branch || GITHUB_BASE_BRANCH);
      const file = await githubGetFile(filePath, branch);
      if (!file?.content) throw new Error("GitHub did not return file content.");
      const content = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
      return { filePath, branch, content: content.slice(0, 30000) };
    }

    case "github_propose_change": {
      const filePath = String(args.filePath || "").trim();
      const content = String(args.content || "");
      const goal = String(args.goal || "Jarvis code improvement");

      if (!filePath || !content) throw new Error("filePath and content are required.");
      if (filePath.startsWith(".github/") || filePath.includes(".env") || filePath.toLowerCase().includes("secret")) {
        throw new Error("This file is protected.");
      }

      const branch = `jarvis-evolution-${Date.now()}`;
      await githubCreateBranch(branch);
      await githubUpdateFile({ filePath, content, branch, message: `Jarvis evolution: ${goal}` });

      const pullRequest = await githubCreatePullRequest({
        branch,
        title: `Jarvis evolution: ${goal}`,
        body:
          `JARVIS generated a proposed code change.\n\n` +
          `Goal: ${goal}\n\n` +
          `Branch: ${branch}\n\n` +
          `This change requires human review before merging into ${GITHUB_BASE_BRANCH}.`
      });

      return {
        ok: true,
        branch,
        pullRequest: pullRequest.html_url,
        message: "Change created successfully. Review the pull request before merging."
      };
    }

    default:
      throw new Error(`Unknown GitHub tool: ${name}`);
  }
}


function saveMemory(category, text) {
  const memory = read(files.memory, {
    facts: [],
    preferences: [],
    goals: [],
    projects: []
  });

  if (memory[category]) {
    memory[category].push({
      text: String(text).slice(0, 2000),
      savedAt: new Date().toISOString()
    });

    write(files.memory, memory);
  }
}
app.get("/api/github/status", requireAuth, async (req, res) => {
  try {
    const repo = await githubRequest("");

    res.json({
      ok: true,
      repository: repo.full_name,
      private: repo.private,
      github: true
    });

  } catch (error) {
    console.error("GITHUB STATUS ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    const {
      messages,
      system = "",
      useOpenAI = false,
      useWeb = false
    } = req.body || {};

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "Invalid messages" });
    }

    let answer;
    let provider = "gemini";
    let geminiError = null;

    try {
      answer = await gemini(messages, system, useWeb, true);
    } catch (error) {
      geminiError = error;
      console.error("Gemini exhausted:", error.message);

      if (!OPENAI_KEY) {
        throw error;
      }

      console.log("Falling back to OpenAI...");
      answer = await openaiFallback(messages, system);
      provider = "openai";
    }

    let review = null;

    // Optional explicit OpenAI review, if the frontend/server caller requests it.
    if (useOpenAI && OPENAI_KEY && provider !== "openai") {
      try {
        review = await openaiFallback(messages, system);
      } catch (error) {
        console.error("OpenAI review failed:", error.message);
      }
    }

    // IMPORTANT: The existing Jarvis frontend expects data.content.
    res.json({
      content: [
        {
          type: "text",
          text: answer.text
        }
      ],
      assistant: answer.text,
      provider,
      model: answer.model,
      searched: !!answer.searched,
      fallbackUsed: provider === "openai",
      geminiError: geminiError ? String(geminiError.message) : null,
      openai: review,
      memory: read(files.memory, {})
    });
  } catch (error) {
    console.error("CHAT ERROR:", error);

    res.status(500).json({
      error: error.message || "Unable to reach an AI provider.",
      provider: "none"
    });
  }
});

app.get("/api/memory", requireAuth, (req, res) => {
  res.json(read(files.memory, {}));
});

app.get("/api/evolution", requireAuth, (req, res) => {
  res.json(read(files.events, []));
});

app.post("/api/learn", requireAuth, async (req, res) => {
  try {
    const { category, text } = req.body || {};

    if (!category || !text) {
      return res.status(400).json({
        error: "category and text required"
      });
    }

    saveMemory(category, text);

    const journal = read(files.journal, []);

    journal.push({
      type: "learning",
      text: String(text).slice(0, 2000),
      createdAt: new Date().toISOString()
    });

    write(files.journal, journal);

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/evolve", requireAuth, async (req, res) => {
  try {
    const goal = String(req.body?.goal || "");

    if (!goal) {
      return res.status(400).json({
        error: "goal required"
      });
    }

    const answer = await gemini([
      {
        role: "user",
        content:
          `Find a meaningful reversible improvement for JARVIS toward this goal:\n${goal}\n\n` +
          `Provide an implementation plan and candidate code only where useful. ` +
          `Candidate code must remain isolated and production must not be overwritten.`
      }
    ]);

    const events = read(files.events, []);

    events.push({
      id: Date.now().toString(),
      type: "evolution-identified",
      goal,
      proposal: answer.text,
      createdAt: new Date().toISOString(),
      status: "awaiting-user-review"
    });

    write(files.events, events);

    res.json({
      proposal: answer.text,
      provider: answer.model
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});
app.post("/api/github/change", requireAuth, async (req, res) => {
  try {
    const {
      filePath,
      content,
      goal = "Jarvis code improvement"
    } = req.body || {};

    if (!filePath || typeof content !== "string") {
      return res.status(400).json({
        error: "filePath and content are required"
      });
    }

    if (
      filePath.startsWith(".github/") ||
      filePath.includes(".env") ||
      filePath.toLowerCase().includes("secret")
    ) {
      return res.status(403).json({
        error: "This file is protected."
      });
    }

    const result = await executeGithubTool("github_propose_change", {
      filePath,
      content,
      goal
    });

    res.json(result);

  } catch (error) {
    console.error("GITHUB CHANGE ERROR:", error);

    res.status(500).json({
      error: error.message ||
        "GitHub operation failed."
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    authConfigured: !!JARVIS_PASSKEY,
    githubConfigured: !!(GITHUB_TOKEN && GITHUB_REPO),
    gemini: !!GEMINI_KEY,
    openai: !!OPENAI_KEY,
    providerMode: "gemini-with-openai-fallback",
    primaryModel: process.env.GEMINI_MODEL || "gemini-3.7-flash",
    fallbackModels: String(
      process.env.GEMINI_FALLBACK_MODELS ||
        "gemini-3.6-flash,gemini-3.5-flash-lite"
    )
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    openaiModel: process.env.OPENAI_MODEL || "gpt-5.6"
  });
});

app.listen(PORT, () => {
  console.log(`JARVIS backend running on ${PORT}`);
});
