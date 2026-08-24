const express=require("express");
const path=require("path");
const fs=require("fs");
const app=express();
app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(__dirname,"public")));

const PORT=process.env.PORT||3000;
const GEMINI_KEY=process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY;
const OPENAI_KEY=process.env.OPENAI_API_KEY;
const DATA=path.join(__dirname,"data"), LAB=path.join(__dirname,"evolution-lab");
fs.mkdirSync(DATA,{recursive:true}); fs.mkdirSync(LAB,{recursive:true});
const files={memory:path.join(DATA,"memory.json"),journal:path.join(DATA,"learning-journal.json"),events:path.join(DATA,"evolution-events.json")};
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return d}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
if(!fs.existsSync(files.memory))write(files.memory,{facts:[],preferences:[],goals:[],projects:[]});
if(!fs.existsSync(files.journal))write(files.journal,[]);
if(!fs.existsSync(files.events))write(files.events,[]);

const SYSTEM=`You are JARVIS, an expandable personal AI assistant. Gemini is your primary reasoning engine.
You have long-term structured memory, image understanding, optional OpenAI review, and a self-improvement laboratory.
You may learn useful information and save it to memory. You may create candidate improvements in the isolated
evolution lab. Never silently overwrite production code. Notify the user when you identify a meaningful evolution.
Never expose API keys. Be capable, calm, concise and transparent.`;

function normalizeMessages(messages){
  return messages.map(m=>({role:m.role==="assistant"?"model":"user",parts:Array.isArray(m.content)?m.content.map(c=>{
    if(c.type==="text")return {text:c.text};
    if(c.type==="image_url"&&c.image_url?.url)return {inline_data:{mime_type:(c.image_url.url.match(/^data:(.*?);base64,/)||[])[1]||"image/jpeg",data:c.image_url.url.split(",")[1]}};
    return {text:String(c.text||"")};
  }):[{text:String(m.content||"")}]}));
}
async function gemini(messages,extra=""){
  if(!GEMINI_KEY)throw new Error("GEMINI_API_KEY is not configured.");
  const body={contents:normalizeMessages(messages),systemInstruction:{parts:[{text:`${SYSTEM}\n\nMEMORY:\n${JSON.stringify(read(files.memory,{})).slice(0,16000)}\n\n${extra}`}]}};
  const model=process.env.GEMINI_MODEL||"gemini-3.7-flash";
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:"POST",headers:{"content-type":"application/json","x-goog-api-client":"jarvis/1.0"},body:JSON.stringify(body)});
  const d=await r.json(); if(!r.ok)throw new Error(d?.error?.message||"Gemini request failed");
  const text=(d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("");
  return {text,raw:d};
}
async function openaiReview(messages){
  if(!OPENAI_KEY)return null;
  const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${OPENAI_KEY}`},
    body:JSON.stringify({model:process.env.OPENAI_MODEL||"gpt-5",instructions:SYSTEM,input:messages})});
  const d=await r.json(); if(!r.ok)throw new Error(d?.error?.message||"OpenAI request failed"); return d.output_text||"";
}
function saveMemory(category,text){
 const m=read(files.memory,{facts:[],preferences:[],goals:[],projects:[]});
 if(m[category]){m[category].push({text:String(text).slice(0,2000),savedAt:new Date().toISOString()});write(files.memory,m);}
}
function proposal(file,content,reason){
 const safe=String(file).replace(/^[/\\]+/,"").replace(/\.\./g,"");
 const target=path.join(LAB,safe);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,String(content));
 const e=read(files.events,[]);e.push({id:Date.now().toString(),type:"code-evolution-proposed",file:safe,reason:String(reason).slice(0,2000),createdAt:new Date().toISOString(),status:"awaiting-user-review"});write(files.events,e);
}
app.post("/api/chat",async(req,res)=>{
 try{
  const {messages,system="",useOpenAI=false}=req.body||{};
  if(!Array.isArray(messages)||!messages.length)return res.status(400).json({error:"Invalid messages"});
  const d=await gemini(messages,system);
  let review=null;if(useOpenAI&&OPENAI_KEY)review=await openaiReview(messages);
  res.json({assistant:d.text,gemini:d.raw,openai:review,memory:read(files.memory,{})});
 }catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/memory",(req,res)=>res.json(read(files.memory,{})));
app.get("/api/evolution",(req,res)=>res.json(read(files.events,[])));
app.post("/api/learn",async(req,res)=>{
 try{
  const {category,text}=req.body||{}; if(!category||!text)return res.status(400).json({error:"category and text required"});
  saveMemory(category,text); const j=read(files.journal,[]);j.push({type:"learning",text:String(text).slice(0,2000),createdAt:new Date().toISOString()});write(files.journal,j);
  res.json({ok:true});
 }catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/evolve",async(req,res)=>{
 try{
  const goal=String(req.body?.goal||"");if(!goal)return res.status(400).json({error:"goal required"});
  const d=await gemini([{role:"user",content:`Find a meaningful reversible improvement for JARVIS toward this goal:\n${goal}\nProvide an implementation plan and candidate code only where useful. Candidate code must remain isolated and production must not be overwritten.`}]);
  const e=read(files.events,[]);e.push({id:Date.now().toString(),type:"evolution-identified",goal,proposal:d.text,createdAt:new Date().toISOString(),status:"awaiting-user-review"});write(files.events,e);
  res.json({proposal:d.text});
 }catch(e){res.status(500).json({error:e.message});}
});
app.listen(PORT,()=>console.log(`JARVIS Gemini backend running on ${PORT}`));