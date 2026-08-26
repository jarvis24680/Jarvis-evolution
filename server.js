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
Be capable, calm, concise and transparent.`;

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

async function callGeminiModel(model, messages, extra = "", useWeb = false) {
  const memory = read(files.memory, {});
  const body = {
    contents: normalizeMessages(messages),
    systemInstruction: {
      parts: [
        {
          text:
            `${SYSTEM}\n\nMEMORY:\n${JSON.stringify(memory).slice(0, 16000)}\n\n${extra}`
        }
      ]
    }
  };

  // Real Google Search grounding, native to the Gemini API — this is what
  // actually powers the frontend's "web search" toggle.
  if (useWeb) {
    body.tools = [{ google_search: {} }];
  }

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

  if (!response.ok) {
    const message =
      data?.error?.message || `Gemini request failed (${response.status})`;

    const error = new Error(message);
    error.status = response.status;
    error.model = model;
    throw error;
  }

  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("");

  if (!text) {
    const error = new Error("Gemini returned an empty response.");
    error.status = 500;
    error.model = model;
    throw error;
  }

  // groundingMetadata is only present when Google Search was actually used
  // to answer the query, even if the tool was offered.
  const searched = !!data.candidates?.[0]?.groundingMetadata;

  return { text, raw: data, model, searched };
}

async function gemini(messages, extra = "", useWeb = false) {
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
        return await callGeminiModel(model, messages, extra, useWeb);
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
app.get("/api/github/status", async (req, res) => {
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

app.post("/api/chat", async (req, res) => {
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
      answer = await gemini(messages, system, useWeb);
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

app.get("/api/memory", (req, res) => {
  res.json(read(files.memory, {}));
});

app.get("/api/evolution", (req, res) => {
  res.json(read(files.events, []));
});

app.post("/api/learn", async (req, res) => {
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

app.post("/api/evolve", async (req, res) => {
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
app.post("/api/github/change", async (req, res) => {
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

    const branch =
      `jarvis-evolution-${Date.now()}`;

    await githubCreateBranch(branch);

    await githubUpdateFile({
      filePath,
      content,
      branch,
      message: `Jarvis evolution: ${goal}`
    });

    const pullRequest =
      await githubCreatePullRequest({
        branch,
        title: `Jarvis evolution: ${goal}`,
        body:
          `JARVIS generated a proposed code change.\n\n` +
          `Goal: ${goal}\n\n` +
          `Branch: ${branch}\n\n` +
          `This change requires human review before merging into ${GITHUB_BASE_BRANCH}.`
      });

    res.json({
      ok: true,
      branch,
      pullRequest: pullRequest.html_url,
      message:
        "Change created successfully. Review the pull request before merging."
    });

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
