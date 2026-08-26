"use strict";
const { useState, useEffect, useRef, useCallback } = React;
const STORAGE_KEY = "jarvis:session-v1";
const MAX_INPUT_CHARS = 6000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_MEMORY_ITEMS = 60;
const MAX_HISTORY = 100;
const SYSTEM_PROMPT = `You are Jarvis, a general-purpose personal assistant built for one user.
Your job: accumulate useful context about the user's goals and projects over time, and give
answers that are precise but not bloated. Adapt explanation depth to what's asked — quick
when a quick answer is wanted, a full teaching pass when the user wants to actually learn.

Rules:
- Be direct. No filler preambles.
- When you use web search, summarize findings in plain language, don't dump raw links.
- When the user shares something durable worth remembering (a project, a goal, a
  preference), end your reply with a line starting exactly with "MEMORY:" followed by a
  short third-person fact. Only include it when something is genuinely worth keeping.
- You do not have unlimited capability and you're honest about that — but be maximally
  useful, thorough when warranted, and willing to go deep on any subject.`;
function useWindowSize() {
    const [w, setW] = useState(window.innerWidth);
    useEffect(() => {
        const onResize = () => setW(window.innerWidth);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
    return w;
}
function GrowthRing({ count }) {
    const angle = Math.min(100, count * 6) * 3.6;
    return (React.createElement("div", { style: { width: 46, height: 46, borderRadius: "50%",
            background: `conic-gradient(#00F2FE ${angle}deg, rgba(0,242,254,0.09) ${angle}deg)`,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } },
        React.createElement("div", { style: { width: 36, height: 36, borderRadius: "50%", background: "#07090E",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#00F2FE" } }, count)));
}
// Minimal inline icon set (no external icon library dependency)
const Icon = ({ path, size = 17 }) => (React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, path));
const SendIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement("path", { d: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" }) });
const MicIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" }),
        React.createElement("path", { d: "M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" })) });
const MicOffIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "m1 1 22 22" }),
        React.createElement("path", { d: "M9 9v3a3 3 0 0 0 4.6 2.5M15 9V5a3 3 0 0 0-5.9-.8" }),
        React.createElement("path", { d: "M19 10v1a7 7 0 0 1-.98 3.6M12 18v4M8 22h8" })) });
const ImgIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }),
        React.createElement("circle", { cx: "8.5", cy: "8.5", r: "1.5" }),
        React.createElement("path", { d: "m21 15-5-5L5 21" })) });
const GlobeIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: "12", cy: "12", r: "10" }),
        React.createElement("path", { d: "M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z" })) });
const VolIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M11 5 6 9H2v6h4l5 4V5Z" }),
        React.createElement("path", { d: "M19 5a10 10 0 0 1 0 14M15.5 8.5a5 5 0 0 1 0 7" })) });
const VolOffIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M11 5 6 9H2v6h4l5 4V5Z" }),
        React.createElement("path", { d: "m22 9-6 6M16 9l6 6" })) });
const BookIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20" }),
        React.createElement("path", { d: "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" })) });
const XIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement("path", { d: "M18 6 6 18M6 6l12 12" }) });
const CompassIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: "12", cy: "12", r: "10" }),
        React.createElement("path", { d: "m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12Z" })) });
const SparkIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement("path", { d: "M12 2 9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2Z" }) });
const TrashIcon = (p) => React.createElement(Icon, { ...p, path: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" })) });
function Jarvis() {
    const [messages, setMessages] = useState([]);
    const [memory, setMemory] = useState([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [useWeb, setUseWeb] = useState(true);
    const [depth, setDepth] = useState("auto");
    const [showMemory, setShowMemory] = useState(false);
    const [voiceOn, setVoiceOn] = useState(false);
    const [listening, setListening] = useState(false);
    const [speaking, setSpeaking] = useState(false);
    const [voiceSupport, setVoiceSupport] = useState({ tts: false, stt: false });
    const [attachedImage, setAttachedImage] = useState(null);
    const [attachError, setAttachError] = useState("");
    const [errorBanner, setErrorBanner] = useState("");
    const scrollRef = useRef(null);
    const recognitionRef = useRef(null);
    const chosenVoiceRef = useRef(null);
    const fileInputRef = useRef(null);
    const width = useWindowSize();
    const isMobile = width < 780;
    useEffect(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                setMessages(data.messages || []);
                setMemory(data.memory || []);
            }
        }
        catch (e) { }
        const tts = "speechSynthesis" in window;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        setVoiceSupport({ tts, stt: !!SR });
        if (tts) {
            const pickVoice = () => {
                const voices = window.speechSynthesis.getVoices();
                if (!voices.length)
                    return;
                const priority = [
                    v => /Google UK English Male/i.test(v.name),
                    v => /Daniel/i.test(v.name),
                    v => /Microsoft (Ryan|Guy)/i.test(v.name),
                    v => /Google US English/i.test(v.name),
                    v => { var _a; return ((_a = v.lang) === null || _a === void 0 ? void 0 : _a.startsWith("en")) && /male/i.test(v.name); },
                    v => { var _a; return (_a = v.lang) === null || _a === void 0 ? void 0 : _a.startsWith("en"); },
                ];
                for (const test of priority) {
                    const m = voices.find(test);
                    if (m) {
                        chosenVoiceRef.current = m;
                        return;
                    }
                }
                chosenVoiceRef.current = voices[0];
            };
            pickVoice();
            window.speechSynthesis.onvoiceschanged = pickVoice;
        }
        if (SR) {
            const rec = new SR();
            rec.continuous = false;
            rec.interimResults = false;
            rec.lang = "en-US";
            rec.onresult = (e) => {
                const t = e.results[0][0].transcript;
                setInput(prev => prev ? prev + " " + t : t);
            };
            rec.onend = () => setListening(false);
            rec.onerror = () => setListening(false);
            recognitionRef.current = rec;
        }
        if ("serviceWorker" in navigator) {
            window.addEventListener("load", () => {
                navigator.serviceWorker.register("/sw.js").catch(() => { });
            });
        }
    }, []);
    useEffect(() => {
        try {
            const trimmed = messages.slice(-MAX_HISTORY).map(({ apiContent, imagePreview, ...rest }) => ({
                ...rest, hadImage: !!imagePreview,
            }));
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: trimmed, memory }));
        }
        catch (e) { }
    }, [messages, memory]);
    useEffect(() => {
        if (scrollRef.current)
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [messages, loading]);
    const depthInstruction = {
        auto: "",
        simple: "\n\nFor this message: keep it short and simple, plain language, minimal jargon.",
        deep: "\n\nFor this message: go deep — full explanation, build from fundamentals, use examples.",
    }[depth];
    const speak = useCallback((text) => {
        if (!voiceSupport.tts || !text)
            return;
        window.speechSynthesis.cancel();
        const clean = text.replace(/[*_#`]/g, "").replace(/\n{2,}/g, ". ");
        const u = new SpeechSynthesisUtterance(clean);
        if (chosenVoiceRef.current)
            u.voice = chosenVoiceRef.current;
        u.rate = 1.0;
        u.pitch = 0.92;
        u.onstart = () => setSpeaking(true);
        u.onend = () => setSpeaking(false);
        u.onerror = () => setSpeaking(false);
        window.speechSynthesis.speak(u);
    }, [voiceSupport.tts]);
    const toggleListening = useCallback(() => {
        if (!recognitionRef.current)
            return;
        if (listening) {
            recognitionRef.current.stop();
            setListening(false);
        }
        else {
            window.speechSynthesis.cancel();
            setSpeaking(false);
            try {
                recognitionRef.current.start();
                setListening(true);
            }
            catch (e) { }
        }
    }, [listening]);
    const handleFileSelect = useCallback((e) => {
        var _a;
        const file = (_a = e.target.files) === null || _a === void 0 ? void 0 : _a[0];
        e.target.value = "";
        if (!file)
            return;
        setAttachError("");
        if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
            setAttachError("Unsupported file type — use PNG, JPEG, WEBP, or GIF.");
            return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
            setAttachError("Image is too large — 5MB max.");
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            setAttachedImage({ dataUrl, mediaType: file.type, base64: dataUrl.split(",")[1] });
        };
        reader.onerror = () => setAttachError("Couldn't read that file — try again.");
        reader.readAsDataURL(file);
    }, []);
    const sendMessage = useCallback(async () => {
        const text = input.trim().slice(0, MAX_INPUT_CHARS);
        if ((!text && !attachedImage) || loading)
            return;
        setErrorBanner("");
        const content = [];
        if (attachedImage) {
            content.push({ type: "image_url", image_url: { url: attachedImage.dataUrl } });
        }
        content.push({ type: "text", text: text || "What's in this image?" });
        const newUserMsg = { role: "user", content: text || "(image)", imagePreview: (attachedImage === null || attachedImage === void 0 ? void 0 : attachedImage.dataUrl) || null, apiContent: content };
        const updated = [...messages, newUserMsg];
        setMessages(updated);
        setInput("");
        setAttachedImage(null);
        setAttachError("");
        setLoading(true);
        try {
            const memoryBlock = memory.length > 0
                ? `\n\nWhat you already know about the user:\n${memory.map(m => `- ${m}`).join("\n")}`
                : "";
            const apiMessages = updated.map((m, i) => ({
                role: m.role,
                content: (i === updated.length - 1 && m.apiContent) ? m.apiContent : m.content,
            }));
            const body = {
                system: SYSTEM_PROMPT + memoryBlock + depthInstruction,
                messages: apiMessages,
            };
            body.useWeb = useWeb;
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (response.status === 429) {
                setErrorBanner("You're sending messages a bit fast — give it a few seconds.");
                setLoading(false);
                return;
            }
            if (!response.ok)
                throw new Error("bad status");
            const data = await response.json();
            const replyTextFromServer = typeof data.assistant === "string" ? data.assistant : "";
            const textBlocks = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n\n");
            const usedSearch = !!data.searched;
            let replyText = replyTextFromServer || textBlocks || data.error || "(no response)";
            let newMemoryLine = null;
            const memMatch = replyText.match(/\nMEMORY:\s*(.+)$/);
            if (memMatch) {
                newMemoryLine = memMatch[1].trim();
                replyText = replyText.replace(/\nMEMORY:\s*(.+)$/, "").trim();
            }
            setMessages(prev => [...prev, { role: "assistant", content: replyText, searched: usedSearch }]);
            if (newMemoryLine) {
                setMemory(prev => {
                    const next = [...prev, newMemoryLine];
                    return next.length > MAX_MEMORY_ITEMS ? next.slice(next.length - MAX_MEMORY_ITEMS) : next;
                });
            }
            if (voiceOn)
                speak(replyText);
        }
        catch (e) {
            setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong reaching the server — check your connection and try again.", error: true }]);
        }
        finally {
            setLoading(false);
        }
    }, [input, loading, messages, memory, useWeb, depthInstruction, voiceOn, speak, attachedImage]);
    const clearMemory = () => setMemory([]);
    const clearAll = () => { setMessages([]); setMemory([]); try {
        localStorage.removeItem(STORAGE_KEY);
    }
    catch (e) { } };
    return (React.createElement("div", { style: { height: "100%", background: "transparent", color: "#F0F6FC", display: "flex", flexDirection: isMobile ? "column" : "row" } },
        React.createElement("aside", { style: {
                width: isMobile ? "100%" : 280,
                borderRight: isMobile ? "none" : "1px solid rgba(0,242,254,0.14)",
                borderBottom: isMobile ? "1px solid rgba(0,242,254,0.14)" : "none",
                padding: "20px 22px", display: "flex",
                flexDirection: isMobile ? "row" : "column",
                alignItems: isMobile ? "center" : "stretch",
                justifyContent: isMobile ? "space-between" : "flex-start", gap: 18,
                overflowY: isMobile ? "visible" : "auto",
            } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
                React.createElement(GrowthRing, { count: memory.length }),
                React.createElement("div", null,
                    React.createElement("div", { style: { fontFamily: "'Fraunces', serif", fontSize: 21, fontWeight: 600 } }, "Jarvis"),
                    !isMobile && React.createElement("div", { style: { fontSize: 12, color: "#8B949E", fontFamily: "'IBM Plex Mono', monospace" } }, speaking ? "speaking…" : `${memory.length} thing${memory.length === 1 ? "" : "s"} remembered`))),
            !isMobile && React.createElement(React.Fragment, null,
                React.createElement("div", { style: { height: 1, background: "rgba(0,242,254,0.14)" } }),
                React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                    React.createElement("div", { style: { fontSize: 11, letterSpacing: "0.08em", color: "#8B949E", textTransform: "uppercase", fontFamily: "'IBM Plex Mono', monospace" } }, "Explanation depth"),
                    [{ id: "auto", label: "Auto" }, { id: "simple", label: "Keep it simple" }, { id: "deep", label: "Go deep" }].map(opt => (React.createElement("button", { key: opt.id, onClick: () => setDepth(opt.id), style: {
                            textAlign: "left", padding: "9px 12px", borderRadius: 8,
                            border: "1px solid " + (depth === opt.id ? "#00F2FE" : "rgba(0,242,254,0.14)"),
                            background: depth === opt.id ? "rgba(0,242,254,0.09)" : "transparent",
                            color: depth === opt.id ? "#F0F6FC" : "#8B949E", cursor: "pointer", fontSize: 13.5,
                        } }, opt.label)))),
                React.createElement("div", { style: { height: 1, background: "rgba(0,242,254,0.14)" } }),
                React.createElement("button", { onClick: () => setUseWeb(v => !v), style: {
                        display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderRadius: 8,
                        border: "1px solid " + (useWeb ? "#00F2FE" : "rgba(0,242,254,0.14)"),
                        background: useWeb ? "rgba(0,242,254,0.09)" : "transparent",
                        color: useWeb ? "#F0F6FC" : "#8B949E", cursor: "pointer", fontSize: 13.5,
                    } },
                    React.createElement(GlobeIcon, { size: 15 }),
                    " Web search ",
                    useWeb ? "on" : "off"),
                voiceSupport.tts && React.createElement("button", { onClick: () => { if (voiceOn)
                        window.speechSynthesis.cancel(); setSpeaking(false); setVoiceOn(v => !v); }, style: {
                        display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderRadius: 8,
                        border: "1px solid " + (voiceOn ? "#00F2FE" : "rgba(0,242,254,0.14)"),
                        background: voiceOn ? "rgba(0,242,254,0.09)" : "transparent",
                        color: voiceOn ? "#F0F6FC" : "#8B949E", cursor: "pointer", fontSize: 13.5,
                    } },
                    voiceOn ? React.createElement(VolIcon, { size: 15 }) : React.createElement(VolOffIcon, { size: 15 }),
                    " Voice replies ",
                    voiceOn ? "on" : "off"),
                React.createElement("button", { onClick: () => setShowMemory(v => !v), style: {
                        display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderRadius: 8,
                        border: "1px solid rgba(0,242,254,0.14)", background: "transparent",
                        color: "#8B949E", cursor: "pointer", fontSize: 13.5,
                    } },
                    React.createElement(BookIcon, { size: 15 }),
                    " ",
                    showMemory ? "Hide" : "Show",
                    " memory"),
                showMemory && React.createElement("div", { style: { maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }, className: "scroll" },
                    memory.length === 0 && React.createElement("div", { style: { fontSize: 12.5, color: "#556", fontStyle: "italic" } }, "Nothing stored yet."),
                    memory.map((m, i) => (React.createElement("div", { key: i, style: { fontSize: 12.5, color: "#B8BFD6", padding: "6px 8px", background: "rgba(255,255,255,0.03)", borderRadius: 6, borderLeft: "2px solid #00F2FE" } }, m))),
                    memory.length > 0 && React.createElement("button", { onClick: clearMemory, style: { marginTop: 4, display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#C1512D", background: "none", border: "none", cursor: "pointer" } },
                        React.createElement(TrashIcon, { size: 12 }),
                        " Clear memory")),
                React.createElement("div", { style: { flex: 1 } }),
                React.createElement("button", { onClick: clearAll, style: { fontSize: 12, color: "#556", background: "none", border: "none", cursor: "pointer", textAlign: "left" } }, "Reset session"))),
        React.createElement("main", { style: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 } },
            React.createElement("div", { style: { height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", borderBottom: "1px solid rgba(255,255,255,.08)", background: "rgba(13,17,23,.62)", backdropFilter: "blur(18px)" } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#8B949E" } },
                    React.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: "#238636", boxShadow: "0 0 8px #238636" } }),
                    React.createElement("span", null, "JARVIS CORE"),
                    React.createElement("span", { style: { fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#00F2FE", padding: "3px 7px", border: "1px solid rgba(0,242,254,.22)", borderRadius: 5 } }, "ONLINE")),
                React.createElement("div", { style: { fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#484F58" } }, "PROD \u2022 v2.0")),
            React.createElement("div", { ref: scrollRef, className: "scroll", style: { flex: 1, overflowY: "auto", padding: isMobile ? "18px 14px" : "32px 44px", display: "flex", flexDirection: "column", gap: 20 } },
                messages.length === 0 && (React.createElement("div", { style: { margin: "auto", textAlign: "center", maxWidth: 420, color: "#8B949E" } },
                    React.createElement(CompassIcon, { size: 26, style: { color: "#00F2FE", marginBottom: 12 } }),
                    React.createElement("div", { style: { fontFamily: "'Fraunces', serif", fontSize: 19, color: "#F0F6FC", marginBottom: 8 } }, "Ask anything. I'll adapt as I go."),
                    React.createElement("div", { style: { fontSize: 13.5, lineHeight: 1.6 } }, "Search the web, attach a photo, talk with your voice, or just type \u2014 I'll hold onto what matters."))),
                messages.map((m, i) => (React.createElement("div", { key: i, style: { display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" } },
                    React.createElement("div", { style: {
                            maxWidth: isMobile ? "88%" : "68%", padding: "12px 15px", borderRadius: 14, fontSize: 14.5, lineHeight: 1.6, whiteSpace: "pre-wrap",
                            background: m.role === "user" ? "rgba(201,162,39,0.14)" : m.error ? "rgba(193,81,45,0.12)" : "rgba(255,255,255,0.04)",
                            border: "1px solid " + (m.role === "user" ? "rgba(0,242,254,0.24)" : "rgba(255,255,255,0.06)"),
                            color: m.error ? "#E0A38A" : "#F0F6FC",
                        } },
                        m.imagePreview && React.createElement("img", { src: m.imagePreview, alt: "Attached", style: { maxWidth: "100%", maxHeight: 220, borderRadius: 8, marginBottom: 8, display: "block" } }),
                        m.role === "assistant" && m.searched && React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "#8B949E", marginBottom: 6, fontFamily: "'IBM Plex Mono', monospace", textTransform: "uppercase" } },
                            React.createElement(GlobeIcon, { size: 11 }),
                            " searched the web"),
                        m.content)))),
                loading && React.createElement("div", { style: { display: "flex", justifyContent: "flex-start" } },
                    React.createElement("div", { style: { padding: "12px 15px", borderRadius: 14, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", color: "#8B949E", fontSize: 13.5, display: "flex", alignItems: "center", gap: 8 } },
                        React.createElement(SparkIcon, { size: 14, style: { color: "#00F2FE" } }),
                        " thinking\u2026"))),
            React.createElement("div", { style: { padding: isMobile ? "10px 14px 16px" : "14px 44px 24px", borderTop: "1px solid rgba(0,242,254,0.09)" } },
                errorBanner && React.createElement("div", { style: { fontSize: 12.5, color: "#E0A38A", marginBottom: 8 } }, errorBanner),
                isMobile && React.createElement("div", { style: { display: "flex", gap: 8, marginBottom: 10, overflowX: "auto" } },
                    React.createElement("button", { onClick: () => setUseWeb(v => !v), style: { display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", borderRadius: 20, border: "1px solid " + (useWeb ? "#00F2FE" : "rgba(201,162,39,0.2)"), background: useWeb ? "rgba(0,242,254,0.09)" : "transparent", color: useWeb ? "#F0F6FC" : "#8B949E", fontSize: 12, whiteSpace: "nowrap" } },
                        React.createElement(GlobeIcon, { size: 12 }),
                        " Web ",
                        useWeb ? "on" : "off"),
                    voiceSupport.tts && React.createElement("button", { onClick: () => setVoiceOn(v => !v), style: { display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", borderRadius: 20, border: "1px solid " + (voiceOn ? "#00F2FE" : "rgba(201,162,39,0.2)"), background: voiceOn ? "rgba(0,242,254,0.09)" : "transparent", color: voiceOn ? "#F0F6FC" : "#8B949E", fontSize: 12, whiteSpace: "nowrap" } },
                        React.createElement(VolIcon, { size: 12 }),
                        " Voice ",
                        voiceOn ? "on" : "off"),
                    ["auto", "simple", "deep"].map(d => (React.createElement("button", { key: d, onClick: () => setDepth(d), style: { padding: "6px 10px", borderRadius: 20, border: "1px solid " + (depth === d ? "#00F2FE" : "rgba(201,162,39,0.2)"), background: depth === d ? "rgba(0,242,254,0.09)" : "transparent", color: depth === d ? "#F0F6FC" : "#8B949E", fontSize: 12, whiteSpace: "nowrap", textTransform: "capitalize" } }, d)))),
                attachedImage && React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 } },
                    React.createElement("div", { style: { position: "relative" } },
                        React.createElement("img", { src: attachedImage.dataUrl, alt: "To send", style: { width: 52, height: 52, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(201,162,39,0.3)" } }),
                        React.createElement("button", { onClick: () => setAttachedImage(null), style: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "#C1512D", border: "none", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" } },
                            React.createElement(XIcon, { size: 12 }))),
                    React.createElement("div", { style: { fontSize: 12, color: "#8B949E" } }, "Image attached \u2014 add a note or just send")),
                attachError && React.createElement("div", { style: { fontSize: 12, color: "#E0A38A", marginBottom: 8 } }, attachError),
                React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "flex-end" } },
                    React.createElement("input", { ref: fileInputRef, type: "file", accept: ALLOWED_IMAGE_TYPES.join(","), onChange: handleFileSelect, style: { display: "none" } }),
                    React.createElement("button", { onClick: () => { var _a; return (_a = fileInputRef.current) === null || _a === void 0 ? void 0 : _a.click(); }, title: "Attach an image", style: { width: 42, height: 42, borderRadius: 10, border: "1px solid " + (attachedImage ? "#00F2FE" : "rgba(201,162,39,0.2)"), background: attachedImage ? "rgba(0,242,254,0.09)" : "rgba(255,255,255,0.04)", color: attachedImage ? "#F0F6FC" : "#8B949E", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 } },
                        React.createElement(ImgIcon, { size: 17 })),
                    React.createElement("textarea", { value: input, onChange: e => setInput(e.target.value), onKeyDown: e => { if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                        } }, placeholder: attachedImage ? "Add a note (optional)…" : "Ask Jarvis anything…", rows: 1, maxLength: MAX_INPUT_CHARS, style: { flex: 1, resize: "none", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(201,162,39,0.2)", borderRadius: 12, padding: "12px 14px", color: "#F0F6FC", fontSize: 14.5, fontFamily: "'Inter', sans-serif", maxHeight: 140 } }),
                    voiceSupport.stt && React.createElement("button", { onClick: toggleListening, title: listening ? "Stop listening" : "Speak to Jarvis", style: { width: 42, height: 42, borderRadius: 10, border: "1px solid " + (listening ? "#C1512D" : "rgba(201,162,39,0.2)"), background: listening ? "rgba(193,81,45,0.15)" : "rgba(255,255,255,0.04)", color: listening ? "#E0A38A" : "#8B949E", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, animation: listening ? "pulse 1.2s infinite" : "none" } }, listening ? React.createElement(MicOffIcon, { size: 17 }) : React.createElement(MicIcon, { size: 17 })),
                    React.createElement("button", { onClick: sendMessage, disabled: loading || (!input.trim() && !attachedImage), style: { width: 42, height: 42, borderRadius: 10, border: "none", background: (loading || (!input.trim() && !attachedImage)) ? "rgba(0,242,254,0.24)" : "#00F2FE", color: "#07090E", display: "flex", alignItems: "center", justifyContent: "center", cursor: (loading || (!input.trim() && !attachedImage)) ? "default" : "pointer", flexShrink: 0 } },
                        React.createElement(SendIcon, { size: 17 })))))));
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Jarvis, null));
