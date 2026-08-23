const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(__dirname,"public")));

const PORT = process.env.PORT || 3000;
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const DATA = path.join(__dirname,"data");
const LAB = path.join(__dirname,"evolution-lab");
fs.mkdirSync(DATA,{recursive:true}); fs.mkdirSync(LAB,{recursive:true});

const files = {
  memory:path.join(DATA,"memory.json"),
  journal:path.join(DATA,"learning-journal.json"),
  events:path.join(DATA,"evolution-events.json")
};
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return d}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
if(!fs.existsSync(files.memory)) write(files.memory,{facts:[],preferences:[],goals:[],projects:[]});
if(!fs.existsSync(files.journal)) write(files.journal,[]);
if(!fs.existsSync(files.events)) write(files.events,[]);

const baseSystem = `You are JARVIS, a capable personal AI assistant.
Your primary model is Claude. You have long-term structured memory, optional web research,
multimodal image understanding, optional second-model review, and a self-improvement laboratory.
You may learn useful information and save it to memory. You may design and write candidate improvements
in the isolated evolution lab. Never pretend a proposed change is active until it has passed tests and
the user has approved promotion. Never expose secrets. Be concise, capable, and transparent.`;

async function claude(messages,system,tools=[]){
  if(!CLAUDE_KEY) throw new Error("ANTHROPIC_API_KEY is not configured on the server.");
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
    headers:{"content-type":"application/json","x-api-key":CLAUDE_KEY,"anthropic-version":"2023-06-01"},
    body:JSON.stringify({model:process.env.CLAUDE_MODEL||"claude-sonnet-4-6",max_tokens:4096,system,messages,...(tools.length?{tools}:{})})});
  const d=await r.json(); if(!r.ok) throw new Error(d?.error?.message||"Claude request failed"); return d;
}
async function openai(messages,system){
  if(!OPENAI_KEY)return null;
  const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",
    headers:{"content-type":"application/json","authorization":`Bearer ${OPENAI_KEY}`},
    body:JSON.stringify({model:process.env.OPENAI_MODEL||"gpt-5",instructions:system,input:messages})});
  const d=await r.json(); if(!r.ok) throw new Error(d?.error?.message||"OpenAI request failed"); return d;
}
const text=d=>(d?.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n");

const tools=[
 {name:"remember",description:"Save useful information for future conversations.",
  input_schema:{type:"object",properties:{category:{type:"string",enum:["facts","preferences","goals","projects"]},text:{type:"string"}},required:["category","text"]}},
 {name:"propose_evolution",description:"Write a candidate code improvement to the isolated evolution lab; never modify production.",
  input_schema:{type:"object",properties:{file:{type:"string"},content:{type:"string"},reason:{type:"string"}},required:["file","content","reason"]}}
];

async function applyTools(blocks){
  const results=[];
  for(const b of blocks||[]){
    if(b.type!=="tool_use") continue;
    if(b.name==="remember"){
      const m=read(files.memory,{facts:[],preferences:[],goals:[],projects:[]});
      if(m[b.input.category]) m[b.input.category].push({text:String(b.input.text).slice(0,2000),savedAt:new Date().toISOString()});
      write(files.memory,m);
      results.push({type:"tool_result",tool_use_id:b.id,content:"Saved to JARVIS memory."});
    }
    if(b.name==="propose_evolution"){
      const safe=String(b.input.file).replace(/^[/\\]+/,"").replace(/\.\./g,"");
      const target=path.join(LAB,safe);
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,String(b.input.content));
      const event={id:Date.now().toString(),type:"code-evolution-proposed",file:safe,reason:String(b.input.reason).slice(0,2000),createdAt:new Date().toISOString(),status:"awaiting-user-review"};
      const ev=read(files.events,[]); ev.push(event); write(files.events,ev);
      results.push({type:"tool_result",tool_use_id:b.id,content:"Evolution proposal created and queued for user review. Production code was not changed."});
    }
  }
  return results;
}

function systemWithMemory(extra=""){
  return `${baseSystem}\n\nMEMORY:\n${JSON.stringify(read(files.memory,{})).slice(0,16000)}\n\n${extra}`;
}

// Chat supports text and Anthropic image blocks passed by the client.
app.post("/api/chat",async(req,res)=>{
  try{
    const {messages,system="",useOpenAI=false}=req.body||{};
    if(!Array.isArray(messages)||!messages.length)return res.status(400).json({error:"Invalid messages"});
    let d=await claude(messages,systemWithMemory(system),tools);
    if((d.content||[]).some(x=>x.type==="tool_use")){
      const tr=await applyTools(d.content);
      d=await claude([...messages,{role:"assistant",content:d.content},{role:"user",content:tr}],systemWithMemory(system),tools);
    }
    let review=null;
    if(useOpenAI && OPENAI_KEY) review=(await openai(messages,systemWithMemory(system)))?.output_text||"";
    res.json({assistant:text(d),claude:d,openai:review,memory:read(files.memory,{})});
  }catch(e){console.error(e);res.status(500).json({error:e.message});}
});

app.get("/api/memory",(req,res)=>res.json(read(files.memory,{})));
app.get("/api/evolution",(req,res)=>res.json(read(files.events,[])));

app.post("/api/evolve",async(req,res)=>{
  try{
    const goal=String(req.body?.goal||"");
    if(!goal)return res.status(400).json({error:"Describe the improvement goal."});
    const prompt=[{role:"user",content:`Find a meaningful way to improve JARVIS toward this goal:
${goal}
Analyze current architecture conceptually. Produce a reversible implementation plan and candidate changes.
Any code must be written only to the isolated evolution lab. Explain how it should be tested and what notification
the user should receive. Do not overwrite production.`}];
    const d=await claude(prompt,systemWithMemory(),tools);
    res.json({proposal:text(d),raw:d});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/research",async(req,res)=>{
  // Research adapter: accepts fetched page text supplied by a client/tool and lets JARVIS learn from it.
  // This endpoint deliberately does not pretend to have browser access if no web provider is configured.
  try{
    const {title="",url="",content=""}=req.body||{};
    if(!content)return res.status(400).json({error:"No source content supplied."});
    const d=await claude([{role:"user",content:`Analyze this web source and extract durable, useful knowledge for JARVIS.
Title: ${title}\nURL: ${url}\nContent:\n${String(content).slice(0,30000)}`}],systemWithMemory(),tools);
    res.json({analysis:text(d)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.listen(PORT,()=>console.log(`JARVIS running on port ${PORT}`));