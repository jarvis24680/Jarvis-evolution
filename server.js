const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

const AI_PROVIDER = (process.env.AI_PROVIDER || "auto").toLowerCase(); // auto | gemini | openai
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6";

const DATA = path.join(__dirname, "data");
const LAB = path.join(__dirname, "evolution-lab");

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(LAB, { recursive: true });

const files = {
  memory: path.join(DATA, "memory.json"),
  journal: path.join(DATA, "learning-journal.json"),
  events: path.join(DATA, "evolution-events.json"),
};

const read = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const write = (file, value) => {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

if (!fs.existsSync(files.memory)) {
  write(files.memory, { facts: [], preferences: [], goals: [], projects: [] });
}
if (!fs.existsSync(files.journal)) write(files.journal, []);
if (!fs.existsSync(files.events)) write(files.events, []);

const SYSTEM = `You are JARVIS, an expandable personal AI assistant.
You can use long-term structured memory, image understanding, web search when enabled,
optional cross-model review, and a self-improvement laboratory.

You may learn useful information and save it to memory.
You may create candidate improvements in the isolated evolution lab.
Never silently overwrite production code.
Notify the user when you identify a meaningful evolution.
Never expose API keys.

Be capable, calm, concise and transparent.`;

function memoryText() {
  const memory = read(files.memory, {});
  return JSON.stringify(memory).slice(0, 16000);
}

function toDataUrl(source) {
  if (!source) return null;
  if (source.type === "url" && source.url) return source.url;
  if (source.type === "base64" && source.media_type && source.data) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}

/*
 * The existing frontend sends Anthropic-style content blocks.
 * This function accepts those blocks as well as normal text/image formats,
 * so the same frontend can talk to Gemini and OpenAI.
 */
function normalizeForGemini(messages) {
  return messages.map((m) => {
    const role = m.role === "assistant" || m.role === "model" ? "model" : "user";
    const raw = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content || "") }];

    const parts = raw.map((c) => {
      if (c.type === "text" || c.type === "input_text") {
        return { text: String(c.text || "") };
      }

      if (c.type === "image" && c.source) {
        const data = toDataUrl(c.source);
        if (data) {
          const match = data.match(/^data:(.*?);base64,(.*)$/);
          if (match) {
            return {
              inlineData: {
                mimeType: match[1],
                data: match[2],
              },
            };
          }
        }
      }

      if (c.type === "image_url" && c.image_url?.url) {
        const data = c.image_url.url;
        const match = data.match(/^data:(.*?);base64,(.*)$/);
        if (match) {
          return {
            inlineData: {
              mimeType: match[1],
              data: match[2],
            },
          };
        }
      }

      if (c.type === "input_image" && c.image_url) {
        const data = c.image_url;
        const match = data.match(/^data:(.*?);base64,(.*)$/);
        if (match) {
          return {
            inlineData: {
              mimeType: match[1],
              data: match[2],
            },
          };
        }
      }

      return { text: String(c.text || "") };
    }).filter(Boolean);

    return {
      role,
      parts: parts.length ? parts : [{ text: "" }],
    };
  });
}

function normalizeForOpenAI(messages) {
  return messages.map((m) => {
    const role = m.role === "assistant" ? "assistant" : "user";
    const raw = Array.isArray(m.content)
      ? m.content
      : [{ type: "text", text: String(m.content || "") }];

    const content = raw.map((c) => {
      if (c.type === "text" || c.type === "input_text") {
        return {
          type: "input_text",
          text: String(c.text || ""),
        };
      }

      if (c.type === "image" && c.source) {
        const url = toDataUrl(c.source);
        if (url) {
          return {
            type: "input_image",
            image_url: url,
          };
        }
      }

      if (c.type === "image_url" && c.image_url?.url) {
        return {
          type: "input_image",
          image_url: c.image_url.url,
        };
      }

      if (c.type === "input_image" && c.image_url) {
        return {
          type: "input_image",
          image_url: c.image_url,
        };
      }

      return {
        type: "input_text",
        text: String(c.text || ""),
      };
    });

    return {
      role,
      content: content.length ? content : [{ type: "input_text", text: "" }],
    };
  });
}

function wantsWebSearch(body) {
  if (body?.useWeb === false) return false;
  // Existing frontend adds an Anthropic web-search tool only when its Web toggle is on.
  if (Array.isArray(body?.tools)) return body.tools.length > 0;
  return body?.useWeb !== false;
}

async function callGemini(messages, systemExtra, useWeb) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY is not configured.");

  const body = {
    contents: normalizeForGemini(messages),
    systemInstruction: {
      parts: [{
        text: `${SYSTEM}\n\nMEMORY:\n${memoryText()}\n\n${systemExtra || ""}`,
      }],
    },
  };

  if (useWeb) {
    body.tools = [{ googleSearch: {} }];
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": GEMINI_KEY,
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Gemini request failed.");
  }

  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("");

  if (!text) {
    throw new Error("Gemini returned no text.");
  }

  return {
    text,
    raw: data,
    searched: Boolean(data.groundingMetadata),
  };
}

async function callOpenAI(messages, systemExtra, useWeb) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is not configured.");

  const body = {
    model: OPENAI_MODEL,
    instructions: `${SYSTEM}\n\nMEMORY:\n${memoryText()}\n\n${systemExtra || ""}`,
    input: normalizeForOpenAI(messages),
  };

  if (useWeb) {
    body.tools = [{ type: "web_search" }];
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenAI request failed.");
  }

  const text = data.output_text || "";

  if (!text) {
    throw new Error("OpenAI returned no text.");
  }

  const searched = Array.isArray(data.output)
    ? data.output.some((item) =>
        item.type === "web_search_call" ||
        item.type === "web_search_preview_call"
      )
    : false;

  return {
    text,
    raw: data,
    searched,
  };
}

function providerOrder(requested) {
  const choice = (requested || AI_PROVIDER || "auto").toLowerCase();

  if (choice === "openai") return ["openai"];
  if (choice === "gemini") return ["gemini"];

  // Auto = Gemini first, then OpenAI as a fallback.
  const order = [];
  if (GEMINI_KEY) order.push("gemini");
  if (OPENAI_KEY) order.push("openai");
  return order;
}

async function generate(messages, systemExtra, useWeb, requestedProvider) {
  const order = providerOrder(requestedProvider);

  if (!order.length) {
    throw new Error(
      "No AI API key is configured. Add GEMINI_API_KEY and/or OPENAI_API_KEY in Render."
    );
  }

  const failures = [];

  for (const provider of order) {
    try {
      if (provider === "gemini") {
        const result = await callGemini(messages, systemExtra, useWeb);
        return { ...result, provider: "gemini", model: GEMINI_MODEL };
      }

      const result = await callOpenAI(messages, systemExtra, useWeb);
      return { ...result, provider: "openai", model: OPENAI_MODEL };
    } catch (error) {
      failures.push(`${provider}: ${error.message}`);
    }
  }

  throw new Error(`All configured AI providers failed. ${failures.join(" | ")}`);
}

function saveMemory(category, text) {
  const memory = read(files.memory, {
    facts: [],
    preferences: [],
    goals: [],
    projects: [],
  });

  if (!memory[category]) return false;

  memory[category].push({
    text: String(text).slice(0, 2000),
    savedAt: new Date().toISOString(),
  });

  write(files.memory, memory);
  return true;
}

function proposal(file, content, reason) {
  const safe = String(file)
    .replace(/^[/\\]+/, "")
    .replace(/\.\./g, "");

  const target = path.join(LAB, safe);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, String(content));

  const events = read(files.events, []);
  events.push({
    id: Date.now().toString(),
    type: "code-evolution-proposed",
    file: safe,
    reason: String(reason).slice(0, 2000),
    createdAt: new Date().toISOString(),
    status: "awaiting-user-review",
  });
  write(files.events, events);
}

app.get("/api/providers", (req, res) => {
  res.json({
    providerMode: AI_PROVIDER,
    available: {
      gemini: Boolean(GEMINI_KEY),
      openai: Boolean(OPENAI_KEY),
    },
    defaultOrder: providerOrder("auto"),
    models: {
      gemini: GEMINI_MODEL,
      openai: OPENAI_MODEL,
    },
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const {
      messages,
      system = "",
      provider = "auto",
    } = req.body || {};

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "Invalid messages." });
    }

    const useWeb = wantsWebSearch(req.body);
    const result = await generate(messages, system, useWeb, provider);

    // Keep both the new normalized response and the old assistant field.
    // This lets the current frontend read data.content[0].text without a rewrite.
    return res.json({
      content: [{ type: "text", text: result.text }],
      assistant: result.text,
      provider: result.provider,
      model: result.model,
      searched: result.searched,
      memory: read(files.memory, {}),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || "AI request failed.",
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
        error: "category and text required",
      });
    }

    if (!saveMemory(category, text)) {
      return res.status(400).json({
        error: "Unknown memory category.",
      });
    }

    const journal = read(files.journal, []);
    journal.push({
      type: "learning",
      text: String(text).slice(0, 2000),
      createdAt: new Date().toISOString(),
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
      return res.status(400).json({ error: "goal required" });
    }

    const result = await generate(
      [{
        role: "user",
        content:
          `Find a meaningful reversible improvement for JARVIS toward this goal:\n${goal}\n\n` +
          `Provide an implementation plan and candidate code only where useful. ` +
          `Candidate code must remain isolated and production must not be overwritten.`,
      }],
      "",
      false,
      req.body?.provider || "auto"
    );

    const events = read(files.events, []);
    events.push({
      id: Date.now().toString(),
      type: "evolution-identified",
      goal,
      provider: result.provider,
      model: result.model,
      proposal: result.text,
      createdAt: new Date().toISOString(),
      status: "awaiting-user-review",
    });
    write(files.events, events);

    res.json({
      proposal: result.text,
      provider: result.provider,
      model: result.model,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(
    `JARVIS backend running on ${PORT} | provider=${AI_PROVIDER} | ` +
    `Gemini=${Boolean(GEMINI_KEY)} | OpenAI=${Boolean(OPENAI_KEY)}`
  );
});
