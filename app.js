// QuizCraft (static, no npm). No premade questions.
// You generate questions by asking ChatGPT using the prompt template, then paste output.

const STORAGE_KEY = "quizcraft_static_v1";

const $ = (sel, root=document) => root.querySelector(sel);

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function nowMs(){ return Date.now(); }

function saveState(s){ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }catch{} }
function loadState(){ try{ const raw = localStorage.getItem(STORAGE_KEY); return raw? JSON.parse(raw): null; }catch{ return null; } }
function clearState(){ try{ localStorage.removeItem(STORAGE_KEY); }catch{} }

function downloadJson(filename, obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function copyToClipboard(text){
  try{ await navigator.clipboard.writeText(text); return true; }catch{ return false; }
}

// ---- share code (gzip if supported) ----
function base64UrlEncode(bytes){
  let bin=""; for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function base64UrlDecodeToBytes(b64url){
  const b64 = b64url.replace(/-/g,"+").replace(/_/g,"/") + "===".slice((b64url.length+3)%4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function gzipCompress(bytes){
  if (!("CompressionStream" in window)) return null;
  const cs = new CompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}
async function gzipDecompress(bytes){
  if (!("DecompressionStream" in window)) return null;
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}
async function encodeToHash(obj){
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  const gz = await gzipCompress(bytes);
  const payload = gz ?? bytes;
  const mode = gz ? "g" : "p";
  return `${mode}.${base64UrlEncode(payload)}`;
}
async function decodeFromHash(str){
  const [mode, data] = str.split(".", 2);
  if (!mode || !data) return null;
  const bytes = base64UrlDecodeToBytes(data);
  if (mode === "g"){
    const raw = await gzipDecompress(bytes);
    if (!raw) return null;
    return JSON.parse(new TextDecoder().decode(raw));
  }
  if (mode === "p"){
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  return null;
}

// ---- parsing format ----
const OPTS = ["A","B","C","D"];
const KEY_ALIASES = { "ANSWER:":"ANS:", "ANS:":"ANS:", "EXPLAIN:":"EXP_CORRECT:", "EXP_CORRECT:":"EXP_CORRECT:", "TAGS:":"TAGS:", "EVID:":"EVID:" };

function isIndented(line){ return line.startsWith("  "); }
function normalizeKey(raw){
  const t = raw.trim().toUpperCase();
  return KEY_ALIASES[t] ?? t;
}
function parseChoiceLine(line){
  const m = line.match(/^([A-D])\s*[\)\:]\s*(.*)$/i);
  if (!m) return null;
  return { key:m[1].toUpperCase(), value:m[2] ?? "" };
}
function parseFieldLine(line){
  const m = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
  if (!m) return null;
  return { key:(m[1]+":").toUpperCase(), value:m[2] ?? "" };
}
function autoFixText(text){
  let t = text.replace(/\r\n/g,"\n");
  t = t.replace(/^\s*ans\s*:/gim,"ANS:");
  t = t.replace(/^\s*answer\s*:/gim,"ANS:");
  t = t.replace(/^\s*exp_correct\s*:/gim,"EXP_CORRECT:");
  t = t.replace(/^\s*explain\s*:/gim,"EXP_CORRECT:");
  t = t.replace(/^\s*tags\s*:/gim,"TAGS:");
  t = t.replace(/^\s*evid\s*:/gim,"EVID:");
  const trimmed = t.trim();
  if (trimmed && !trimmed.endsWith("---")) t = trimmed + "\n---\n";
  return t;
}
function countBlocks(text){
  return text.replace(/\r\n/g,"\n").split("\n").filter(l => l.trim()==="---").length;
}

function parseQuizText(text){
  const raw = text.replace(/\r\n/g,"\n");
  const lines = raw.split("\n");

  const blocks = [];
  let cur=[], nums=[];
  for (let i=0;i<lines.length;i++){
    const line=lines[i], ln=i+1;
    if (line.trim()==="---"){
      if (cur.some(x=>x.trim()!=="")) blocks.push({lines:cur, lineNums:nums});
      cur=[]; nums=[];
      continue;
    }
    cur.push(line); nums.push(ln);
  }

  const errors=[], questions=[];
  blocks.forEach((block, idx) => {
    const fields = {
      Q:"",
      choices:{A:"",B:"",C:"",D:""},
      ANS:"",
      EXP_CORRECT:"",
      EXP:{A:"",B:"",C:"",D:""},
      TAGS:[],
      EVID:""
    };

    let last=null;
    const nonEmpty=[];
    for (let j=0;j<block.lines.length;j++){
      const line=block.lines[j], ln=block.lineNums[j];
      if (line.trim()==="") continue;

      if (isIndented(line) && last){
        const extra = line.slice(2);
        if (last==="Q") fields.Q += (fields.Q ? "\n":"") + extra;
        else if (last==="EXP_CORRECT") fields.EXP_CORRECT += (fields.EXP_CORRECT ? "\n":"") + extra;
        else if (last==="EVID") fields.EVID += (fields.EVID ? "\n":"") + extra;
        else if (last.startsWith("EXP_")){
          const k = last.split("_")[1];
          fields.EXP[k] += (fields.EXP[k] ? "\n":"") + extra;
        } else if (last==="TAGS"){
          fields.TAGS.push(...extra.split(",").map(s=>s.trim()).filter(Boolean));
        }
        continue;
      }

      nonEmpty.push({line, ln});

      const fl = parseFieldLine(line.trim());
      if (fl){
        const key = normalizeKey(fl.key);
        const v = fl.value ?? "";
        if (key==="Q:"){ fields.Q=v; last="Q"; continue; }
        if (key==="ANS:"){ fields.ANS=v.trim().toUpperCase(); last="ANS"; continue; }
        if (key==="EXP_CORRECT:"){ fields.EXP_CORRECT=v; last="EXP_CORRECT"; continue; }
        if (key==="TAGS:"){ fields.TAGS=v.split(",").map(s=>s.trim()).filter(Boolean); last="TAGS"; continue; }
        if (key==="EVID:"){ fields.EVID=v; last="EVID"; continue; }
        const expm = key.match(/^EXP_([A-D])\:\s*$/);
        if (expm){
          const k = expm[1];
          fields.EXP[k]=v; last=`EXP_${k}`; continue;
        }
      }

      const ch = parseChoiceLine(line.trim());
      if (ch){
        fields.choices[ch.key]=ch.value;
        last=`CHOICE_${ch.key}`;
        continue;
      }

      errors.push({ qIndex: idx+1, line: ln, message:`Unrecognized line: "${line.trim().slice(0,80)}${line.trim().length>80?"…":""}"` });
    }

    const qNo=idx+1;
    const pickLine = (prefix)=> nonEmpty.find(x=>x.line.trim().toUpperCase().startsWith(prefix))?.ln ?? (block.lineNums[0] ?? 1);

    if (!fields.Q.trim()) errors.push({ qIndex:qNo, line:pickLine("Q:"), message:"Missing Q: (question text)." });
    for (const k of OPTS){
      if (!fields.choices[k].trim()) errors.push({ qIndex:qNo, line:pickLine(`${k})`), message:`Missing choice ${k})` });
    }
    if (!OPTS.includes(fields.ANS)) errors.push({ qIndex:qNo, line:pickLine("ANS:"), message:"ANS must be A, B, C, or D." });
    if (!fields.EXP_CORRECT.trim()) errors.push({ qIndex:qNo, line:pickLine("EXP_CORRECT:"), message:"Missing EXP_CORRECT:" });
    for (const k of OPTS){
      if (!fields.EXP[k].trim()) errors.push({ qIndex:qNo, line:pickLine(`EXP_${k}:`), message:`Missing EXP_${k}:` });
    }

    if (errors.some(e=>e.qIndex===qNo)) return;

    questions.push({
      id: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${qNo}-${Math.random()}`,
      q: fields.Q,
      choices: fields.choices,
      ans: fields.ANS,
      expCorrect: fields.EXP_CORRECT,
      expEach: fields.EXP,
      tags: fields.TAGS,
      evid: fields.EVID
    });
  });

  return {questions, errors};
}

// ---- prompt builder ----
function buildPrompt(form){
  const { topic, count, difficulty, style, includeTags, tagHint, includeEvidence, evidenceHint } = form;

  return `You are generating a multiple-choice quiz for a student.

TOPIC:
${topic || "<YOUR TOPIC HERE>"}${includeEvidence ? `

SOURCE / NOTES (use ONLY this; do not invent facts):
${evidenceHint || "<PASTE EXCERPT OR NOTES HERE>"}` : ""}

Number of questions: ${count}
Difficulty: ${difficulty}
Style focus: ${style}

Distractor design rules (required):
- Each question must have 1 correct answer.
- Include 1 strong distractor (sounds right but has a subtle mistake).
- Include 2 wrong answers that are wrong by time period / concept / cause / location (pick what fits the topic).
- Keep distractors plausible (not silly).
- Keep correct letters balanced across the quiz.
- No long copyrighted quotes; paraphrase.

Output ONLY in this exact format (repeat for every question):
Q: <question text>
A) <choice text>
B) <choice text>
C) <choice text>
D) <choice text>
ANS: <A|B|C|D>
EXP_CORRECT: <why correct is correct (2–4 sentences)>
EXP_A: <feedback for option A (1–2 sentences)>
EXP_B: <feedback for option B (1–2 sentences)>
EXP_C: <feedback for option C (1–2 sentences)>
EXP_D: <feedback for option D (1–2 sentences)>
${includeEvidence ? "EVID: <short source cue like “Doc p.3” or “Paragraph 5”>" : ""}
${includeTags ? `TAGS: ${tagHint || "<comma-separated tags>"}` : ""}
---

Now generate ${count} questions.`.trim();
}

// ---- app state ----
const defaultState = {
  version: 1,
  route: "import",          // import | quiz | results
  activeTab: "generator",   // generator | paste
  importText: "",
  pasteText: "",
  parseErrors: [],
  preview: { blocks: 0, valid: 0 },
  quiz: null,
  order: [],
  index: 0,
  answers: {},              // qid -> {pick, correct}
  flags: {},                // qid -> true
  settings: { mode:"study", shuffleQuestions:false, shuffleAnswers:false, timerOn:true, showAllOptionFeedback:true, tagFilter:"All" },
  genForm: {
    topic: "",
    count: 12,
    difficulty: "Medium",
    style: "Mixed (definition + inference + cause/effect)",
    includeTags: true,
    tagHint: "Unit, theme, vocab",
    includeEvidence: true,
    evidenceHint: ""
  },
  startMs: null,
  elapsed: 0
};

let state = structuredClone(defaultState);

// ---- quiz helpers ----
function fmtTime(ms){
  const s = Math.floor(ms/1000);
  const mm = Math.floor(s/60);
  const ss = s%60;
  return `${mm}:${String(ss).padStart(2,"0")}`;
}
function shuffleArray(arr){
  const a=[...arr];
  for (let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function currentQuestion(){
  if (!state.quiz?.questions?.length) return null;
  const qi = state.order[state.index];
  return state.quiz.questions[qi] || null;
}
function getAllTags(){
  if (!state.quiz?.questions?.length) return [];
  const set=new Set();
  state.quiz.questions.forEach(q => (q.tags||[]).forEach(t=>set.add(t)));
  return Array.from(set).sort((a,b)=>a.localeCompare(b));
}
function getDisplayedLetters(){
  // for simplicity, we only shuffle on display (no persistent per-question shuffle)
  return state.settings.shuffleAnswers ? shuffleArray(["A","B","C","D"]) : ["A","B","C","D"];
}
function stats(){
  const total = state.quiz?.questions?.length || 0;
  let right=0, wrong=0;
  if (state.quiz){
    for (const q of state.quiz.questions){
      const a = state.answers[q.id];
      if (!a) continue;
      if (a.correct) right++; else wrong++;
    }
  }
  return { total, right, wrong, unanswered: total-right-wrong };
}

// ---- navigation ----
function chooseAnswer(qid, pick){
  if (state.answers[qid]) return;
  const q = state.quiz.questions.find(x=>x.id===qid);
  const correct = pick === q.ans;
  state.answers[qid] = { pick, correct, at: new Date().toISOString() };
  saveState(state);
  render();
}
function toggleFlag(qid){
  state.flags[qid] = !state.flags[qid];
  saveState(state);
  render();
}
function goPrev(){ state.index = clamp(state.index-1, 0, state.order.length-1); saveState(state); render(); }
function goNext(){ state.index = clamp(state.index+1, 0, state.order.length-1); saveState(state); render(); }

// ---- screens ----
function renderImport(){
  const app = $("#app");
  const active = state.activeTab;

  const t = active==="generator" ? state.importText : state.pasteText;
  const parsed = parseQuizText(t);
  state.preview = { blocks: countBlocks(t), valid: parsed.questions.length };
  state.parseErrors = parsed.errors.slice(0, 8);
  saveState(state);

  const prompt = buildPrompt(state.genForm);

  app.innerHTML = `
    <section class="card">
      <div class="cardHeader">
        <div>
          <p class="title">Create a quiz</p>
          <p class="desc">Copy the prompt → ask ChatGPT → paste output → load quiz.</p>
        </div>
        <div class="tabs">
          <button class="tab ${active==="generator"?"active":""}" id="tabGen">AI Generator</button>
          <button class="tab ${active==="paste"?"active":""}" id="tabPaste">Paste Import</button>
        </div>
      </div>

      <div class="kv">
        <small>Detected blocks: <b>${state.preview.blocks}</b> • Valid questions: <b>${state.preview.valid}</b></small>
        <div class="actions" style="margin-top:0">
          <button class="btn small" id="btnShareCurrent" ${state.quiz?.questions?.length?"":"disabled"}>Share Link (current)</button>
        </div>
      </div>

      ${active==="generator" ? `
        <div class="row">
          <div class="col">
            <div class="card flat">
              <div class="cardHeader">
                <div>
                  <p class="title">Prompt Builder</p>
                  <p class="desc">You tell ChatGPT what you want; it generates the quiz in the exact format.</p>
                </div>
                <button class="btn small" id="btnCopyPrompt">Copy prompt</button>
              </div>

              <div class="twoCol">
                <div>
                  <label class="desc">Topic</label>
                  <input id="genTopic" value="${escapeHtml(state.genForm.topic)}" placeholder="ex: APUSH Unit 5 — Reconstruction" />
                </div>
                <div>
                  <label class="desc"># Questions</label>
                  <input id="genCount" type="number" min="1" max="80" value="${state.genForm.count}" />
                </div>
                <div>
                  <label class="desc">Difficulty</label>
                  <select id="genDiff">
                    ${["Easy","Medium","Hard"].map(x=>`<option ${state.genForm.difficulty===x?"selected":""}>${x}</option>`).join("")}
                  </select>
                </div>
                <div>
                  <label class="desc">Style</label>
                  <input id="genStyle" value="${escapeHtml(state.genForm.style)}" />
                </div>
                <div>
                  <label class="desc">Use document-only facts?</label>
                  <select id="genEvidenceOn">
                    <option value="yes" ${state.genForm.includeEvidence?"selected":""}>Yes</option>
                    <option value="no" ${!state.genForm.includeEvidence?"selected":""}>No</option>
                  </select>
                </div>
                <div>
                  <label class="desc">Include tags</label>
                  <select id="genTagsOn">
                    <option value="yes" ${state.genForm.includeTags?"selected":""}>Yes</option>
                    <option value="no" ${!state.genForm.includeTags?"selected":""}>No</option>
                  </select>
                </div>
              </div>

              <div class="hr"></div>

              <label class="desc">Source/Notes (paste excerpt or bullet notes)</label>
              <textarea id="genEvidence" placeholder="If you upload a document later, paste key excerpt here or paste notes.">${escapeHtml(state.genForm.evidenceHint)}</textarea>

              <div class="hr"></div>

              <label class="desc">Prompt to copy</label>
              <textarea id="promptBox" readonly>${escapeHtml(prompt)}</textarea>
            </div>
          </div>

          <div class="col">
            <div class="card flat">
              <div class="cardHeader">
                <div>
                  <p class="title">Paste ChatGPT output</p>
                  <p class="desc">No premade questions — paste your generated quiz here.</p>
                </div>
                <div class="actions" style="margin-top:0">
                  <button class="btn small" id="btnInsertTemplate">Insert format template</button>
                  <button class="btn small" id="btnAutoFixImport">Auto-fix</button>
                  <button class="btn small" id="btnClearImport">Clear</button>
                </div>
              </div>

              <textarea id="importText" placeholder="Paste formatted blocks here...">${escapeHtml(state.importText)}</textarea>

              <div class="actions">
                <button class="btn primary" id="btnLoadImport">Validate & Load Quiz</button>
                <button class="btn" id="btnShareFromText">Share link from this text</button>
              </div>

              <div id="errWrap"></div>
            </div>
          </div>
        </div>
      ` : `
        <div style="margin-top:12px">
          <label class="desc">Paste formatted quiz text</label>
          <textarea id="pasteText" placeholder="Paste formatted blocks here...">${escapeHtml(state.pasteText)}</textarea>
          <div class="actions">
            <button class="btn primary" id="btnLoadPaste">Validate & Load Quiz</button>
            <button class="btn" id="btnInsertTemplate2">Insert format template</button>
            <button class="btn" id="btnAutoFixPaste">Auto-fix</button>
            <button class="btn" id="btnClearPaste">Clear</button>
            <button class="btn" id="btnShareFromPaste">Share link from this text</button>
          </div>
          <div id="errWrap"></div>
        </div>
      `}
    </section>
  `;

  $("#tabGen").onclick = ()=>{ state.activeTab="generator"; saveState(state); render(); };
  $("#tabPaste").onclick = ()=>{ state.activeTab="paste"; saveState(state); render(); };

  $("#btnShareCurrent").onclick = shareLinkCurrent;

  // generator tab hooks
  if (active==="generator"){
    $("#genTopic").oninput = (e)=>{ state.genForm.topic=e.target.value; saveState(state); render(); };
    $("#genCount").oninput = (e)=>{ state.genForm.count=clamp(parseInt(e.target.value||"12",10),1,80); saveState(state); render(); };
    $("#genDiff").onchange = (e)=>{ state.genForm.difficulty=e.target.value; saveState(state); render(); };
    $("#genStyle").oninput = (e)=>{ state.genForm.style=e.target.value; saveState(state); render(); };
    $("#genEvidenceOn").onchange = (e)=>{ state.genForm.includeEvidence=(e.target.value==="yes"); saveState(state); render(); };
    $("#genTagsOn").onchange = (e)=>{ state.genForm.includeTags=(e.target.value==="yes"); saveState(state); render(); };
    $("#genEvidence").oninput = (e)=>{ state.genForm.evidenceHint=e.target.value; saveState(state); render(); };

    $("#btnCopyPrompt").onclick = async ()=>{
      const ok = await copyToClipboard(buildPrompt(state.genForm));
      alert(ok ? "Prompt copied!" : "Couldn’t copy (browser blocked clipboard).");
    };

    $("#importText").oninput = (e)=>{ state.importText=e.target.value; saveState(state); renderErrorsIfAny(); };
    $("#btnAutoFixImport").onclick = ()=>{ state.importText=autoFixText(state.importText); saveState(state); render(); };
    $("#btnClearImport").onclick = ()=>{ state.importText=""; saveState(state); render(); };

    $("#btnInsertTemplate").onclick = ()=>{
      state.importText =
`Q: <question text>
A) <choice text>
B) <choice text>
C) <choice text>
D) <choice text>
ANS: <A|B|C|D>
EXP_CORRECT: <why correct is correct>
EXP_A: <why A is right/wrong>
EXP_B: <why B is right/wrong>
EXP_C: <why C is right/wrong>
EXP_D: <why D is right/wrong>
EVID: <optional source cue>
TAGS: <optional tags>
---
`;
      saveState(state); render();
    };

    $("#btnLoadImport").onclick = ()=> loadQuizFromText(state.importText, "ai-output");
    $("#btnShareFromText").onclick = ()=> shareLinkFromText(state.importText);
  }

  // paste tab hooks
  if (active==="paste"){
    $("#pasteText").oninput = (e)=>{ state.pasteText=e.target.value; saveState(state); renderErrorsIfAny(); };
    $("#btnAutoFixPaste").onclick = ()=>{ state.pasteText=autoFixText(state.pasteText); saveState(state); render(); };
    $("#btnClearPaste").onclick = ()=>{ state.pasteText=""; saveState(state); render(); };
    $("#btnInsertTemplate2").onclick = ()=>{
      state.pasteText =
`Q: <question text>
A) <choice text>
B) <choice text>
C) <choice text>
D) <choice text>
ANS: <A|B|C|D>
EXP_CORRECT: <why correct is correct>
EXP_A: <why A is right/wrong>
EXP_B: <why B is right/wrong>
EXP_C: <why C is right/wrong>
EXP_D: <why D is right/wrong>
---
`;
      saveState(state); render();
    };
    $("#btnLoadPaste").onclick = ()=> loadQuizFromText(state.pasteText, "paste");
    $("#btnShareFromPaste").onclick = ()=> shareLinkFromText(state.pasteText);
  }

  renderErrorsIfAny();
}

function escapeHtml(s){
  return (s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function renderErrorsIfAny(){
  const wrap = $("#errWrap");
  if (!wrap) return;

  const t = state.activeTab==="generator" ? state.importText : state.pasteText;
  const parsed = parseQuizText(t);
  state.preview = { blocks: countBlocks(t), valid: parsed.questions.length };
  state.parseErrors = parsed.errors.slice(0, 8);
  saveState(state);

  if (!state.parseErrors.length){
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = `
    <div class="errorBox">
      <b>Formatting issues found:</b>
      <ul>
        ${state.parseErrors.map(e => `<li><span style="color:var(--bad)">Q${e.qIndex}</span> • line <b>${e.line}</b> — ${escapeHtml(e.message)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function loadQuizFromText(text, source){
  const {questions, errors} = parseQuizText(text);
  state.parseErrors = errors.slice(0, 8);
  state.preview = { blocks: countBlocks(text), valid: questions.length };

  if (errors.length){
    saveState(state);
    render();
    return false;
  }

  state.quiz = { questions, meta: { source, createdAt: new Date().toISOString() } };
  const baseOrder = questions.map((_,i)=>i);
  state.order = state.settings.shuffleQuestions ? shuffleArray(baseOrder) : baseOrder;
  state.index = 0;
  state.answers = {};
  state.flags = {};
  state.startMs = nowMs();
  state.elapsed = 0;
  state.route = "quiz";
  saveState(state);
  render();
  return true;
}

async function shareLinkCurrent(){
  if (!state.quiz?.questions?.length) return alert("Nothing loaded yet.");
  const pkg = state;
  const code = await encodeToHash(pkg);
  const url = `${location.origin}${location.pathname}#q=${code}`;
  await copyToClipboard(url);
  alert("Share link copied!");
}
async function shareLinkFromText(text){
  const {questions, errors} = parseQuizText(text);
  if (errors.length) return alert("Fix formatting errors first.");
  const pkg = structuredClone(defaultState);
  pkg.quiz = { questions, meta: { source:"shared-text", createdAt:new Date().toISOString() } };
  pkg.order = questions.map((_,i)=>i);
  pkg.route = "quiz";
  pkg.startMs = nowMs();
  const code = await encodeToHash(pkg);
  const url = `${location.origin}${location.pathname}#q=${code}`;
  await copyToClipboard(url);
  alert("Share link copied (opens quiz)!");
}

function renderQuiz(){
  const app = $("#app");
  const q = currentQuestion();
  if (!q) { state.route="import"; saveState(state); return render(); }

  if (state.settings.timerOn && state.startMs){
    state.elapsed = nowMs() - state.startMs;
  }

  const st = stats();
  const pct = st.total ? Math.round((st.right / st.total) * 100) : 0;

  const answered = state.answers[q.id];
  const picked = answered?.pick || null;

  const letters = ["A","B","C","D"]; // keep stable display
  const isTestMode = state.settings.mode === "test";
  const reveal = !isTestMode ? !!answered : false;

  app.innerHTML = `
    <section class="card">
      <div class="quizHeader">
        <div class="actions" style="margin-top:0">
          <button class="btn small" id="btnBackImport">← Import</button>
          <button class="btn small" id="btnShareLink">Share Link</button>
          <button class="btn small" id="btnFinish">${isTestMode ? "Finish (Reveal)" : "Results"}</button>
        </div>

        <div class="progressWrap">
          <div class="progressTop">
            <div class="muted">Question <b>${state.index+1}</b> of <b>${state.order.length}</b></div>
            <div class="muted">${state.settings.timerOn ? `⏱ ${fmtTime(state.elapsed)}` : ""}</div>
          </div>
          <div class="progressBar" aria-hidden="true">
            <div class="progressFill" style="width:${Math.round(((state.index+1)/state.order.length)*100)}%"></div>
          </div>
        </div>

        <div class="muted">Score: <b>${st.right}/${st.total}</b> (${pct}%)</div>
      </div>

      <p class="qText">${escapeHtml(q.q)}</p>

      <div class="actions" style="margin-top:0">
        <button class="btn small ${state.flags[q.id] ? "danger":""}" id="btnFlag">${state.flags[q.id] ? "🚩 Flagged" : "🏳️ Flag"}</button>
        ${(q.tags||[]).length ? `<span class="pill">${escapeHtml((q.tags||[]).join(", "))}</span>` : ""}
        ${q.evid ? `<span class="pill">EVID: ${escapeHtml(q.evid)}</span>` : ""}
      </div>

      <div id="choices"></div>

      ${reveal ? renderExplain(q, picked) : (isTestMode && answered ? `<div class="notice">Answered. In Test Mode, feedback reveals on Finish.</div>` : "")}

      <div class="actions">
        <button class="btn" id="btnPrev" ${state.index===0?"disabled":""}>← Back</button>
        <button class="btn" id="btnNext" ${state.index===state.order.length-1?"disabled":""}>Next →</button>
        <button class="btn" id="btnSkip" ${state.index===state.order.length-1?"disabled":""}>Skip</button>
      </div>

      <div class="hr"></div>

      <p class="desc">Minimap (click to jump)</p>
      <div class="grid" id="minimap"></div>
    </section>
  `;

  // choices
  const wrap = $("#choices");
  letters.forEach(L => {
    const txt = q.choices[L];
    const isPick = picked === L;
    const isCorrect = q.ans === L;

    let cls = "choice";
    if (answered && isPick) cls += " selected";
    if (reveal && isCorrect) cls += " correct";
    if (reveal && isPick && !isCorrect) cls += " wrong";

    const rightIcon = reveal
      ? (isCorrect ? "✅" : (isPick && !isCorrect ? "❌" : ""))
      : "";

    const btn = document.createElement("button");
    btn.className = cls;
    btn.type = "button";
    btn.disabled = !!answered;
    btn.innerHTML = `
      <div class="label">
        <div class="badge">${L}</div>
        <div>${escapeHtml(txt)}</div>
      </div>
      <div class="iconDot">${rightIcon || " "}</div>
    `;
    btn.onclick = ()=> chooseAnswer(q.id, L);
    wrap.appendChild(btn);
  });

  // minimap
  const mini = $("#minimap");
  const indices = state.order;
  indices.forEach((qi, i) => {
    const qq = state.quiz.questions[qi];
    const a = state.answers[qq.id];
    const flagged = !!state.flags[qq.id];

    let cls = "gridBtn";
    if (i === state.index) cls += " active";
    if (flagged) cls += " warn";
    if (a?.correct) cls += " good";
    if (a && !a.correct) cls += " bad";

    const b = document.createElement("button");
    b.className = cls;
    b.type = "button";
    b.textContent = String(i+1);
    b.onclick = ()=>{ state.index=i; saveState(state); render(); };
    mini.appendChild(b);
  });

  // buttons
  $("#btnPrev").onclick = goPrev;
  $("#btnNext").onclick = goNext;
  $("#btnSkip").onclick = goNext;
  $("#btnFlag").onclick = ()=> toggleFlag(q.id);
  $("#btnBackImport").onclick = ()=>{ state.route="import"; saveState(state); render(); };
  $("#btnShareLink").onclick = shareLinkCurrent;
  $("#btnFinish").onclick = ()=>{ state.route="results"; saveState(state); render(); };
}

function renderExplain(q, picked){
  const showAll = state.settings.showAllOptionFeedback;
  const lines = [];
  lines.push(`<h3>Why the correct answer is correct</h3>`);
  lines.push(`<p>${escapeHtml(q.expCorrect)}</p>`);
  if (!showAll) return `<div class="explain">${lines.join("")}</div>`;

  lines.push(`<h3>Option feedback</h3>`);
  for (const L of OPTS){
    const mark = (L===q.ans) ? "✅" : (L===picked ? "❌" : "•");
    lines.push(`<p><b>${mark} ${L}:</b> ${escapeHtml(q.expEach[L])}</p>`);
  }
  return `<div class="explain">${lines.join("")}</div>`;
}

function renderResults(){
  const app = $("#app");
  const st = stats();
  const pct = st.total ? Math.round((st.right / st.total) * 100) : 0;

  app.innerHTML = `
    <section class="card">
      <div class="cardHeader">
        <div>
          <p class="title">Results</p>
          <p class="desc">Review or retry. Test Mode reveals correctness here.</p>
        </div>
        <div class="actions" style="margin-top:0">
          <button class="btn small" id="btnBackQuiz">← Back to Quiz</button>
          <button class="btn small" id="btnBackImport">← Import</button>
          <button class="btn small" id="btnShareLink">Share Link</button>
        </div>
      </div>

      <div class="kv">
        <small>Score: <b>${st.right}</b> right • <b>${st.wrong}</b> wrong • <b>${st.unanswered}</b> unanswered • Total <b>${st.total}</b></small>
        <small>${state.settings.timerOn ? `Time: <b>${fmtTime(state.elapsed)}</b>` : ""}</small>
      </div>

      <div class="hr"></div>

      <div class="actions">
        <button class="btn primary" id="btnReviewAll">Review All</button>
        <button class="btn" id="btnReviewMissed">Review Missed</button>
        <button class="btn" id="btnReviewFlagged">Review Flagged</button>
        <button class="btn danger" id="btnRetry">Retry (reset answers)</button>
      </div>

      <p class="notice">In Review, click minimap to jump. In Retry, your question set stays the same.</p>
    </section>
  `;

  $("#btnBackQuiz").onclick = ()=>{ state.route="quiz"; saveState(state); render(); };
  $("#btnBackImport").onclick = ()=>{ state.route="import"; saveState(state); render(); };
  $("#btnShareLink").onclick = shareLinkCurrent;

  $("#btnRetry").onclick = ()=>{
    state.answers = {};
    state.flags = {};
    state.index = 0;
    state.startMs = nowMs();
    state.elapsed = 0;
    state.route = "quiz";
    saveState(state);
    render();
  };

  const review = (mode)=>{
    const ids = state.quiz.questions.map(q=>q.id);
    const missed = ids.filter(id => state.answers[id] && !state.answers[id].correct);
    const flagged = ids.filter(id => state.flags[id]);

    const list = mode==="missed" ? missed : mode==="flagged" ? flagged : ids;
    // map to indices in quiz.questions
    const idxs = list.map(id => state.quiz.questions.findIndex(q=>q.id===id)).filter(i=>i>=0);
    state.order = idxs.length ? idxs : state.order;
    state.index = 0;
    state.route = "quiz";
    saveState(state);
    render();
  };

  $("#btnReviewAll").onclick = ()=> review("all");
  $("#btnReviewMissed").onclick = ()=> review("missed");
  $("#btnReviewFlagged").onclick = ()=> review("flagged");
}

function render(){
  renderSettingsDrawer();
  if (state.route === "import") return renderImport();
  if (state.route === "quiz") return renderQuiz();
  return renderResults();
}

// ---- settings drawer ----
function renderSettingsDrawer(){
  const overlay = $("#drawerOverlay");
  const form = $("#settingsForm");

  const tags = getAllTags();
  form.innerHTML = `
    <div>
      <label class="desc">Mode</label>
      <select id="setMode">
        <option value="study">Study (instant feedback)</option>
        <option value="test">Test (reveal at end)</option>
      </select>
    </div>
    <div>
      <label class="desc">Timer</label>
      <select id="setTimer">
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </div>
    <div>
      <label class="desc">Shuffle questions</label>
      <select id="setShuffleQ">
        <option value="off">Off</option>
        <option value="on">On</option>
      </select>
    </div>
    <div>
      <label class="desc">Shuffle answers</label>
      <select id="setShuffleA">
        <option value="off">Off</option>
        <option value="on">On</option>
      </select>
    </div>
    <div>
      <label class="desc">Option feedback</label>
      <select id="setOptFb">
        <option value="all">Show EXP_A–D</option>
        <option value="correctOnly">Show EXP_CORRECT only</option>
      </select>
    </div>
    <div>
      <label class="desc">Tag filter (minimap)</label>
      <select id="setTagFilter">
        <option value="All">All</option>
        ${tags.map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}
      </select>
    </div>
  `;

  $("#setMode").value = state.settings.mode;
  $("#setTimer").value = state.settings.timerOn ? "on" : "off";
  $("#setShuffleQ").value = state.settings.shuffleQuestions ? "on" : "off";
  $("#setShuffleA").value = state.settings.shuffleAnswers ? "on" : "off";
  $("#setOptFb").value = state.settings.showAllOptionFeedback ? "all" : "correctOnly";
  $("#setTagFilter").value = state.settings.tagFilter;

  $("#setMode").onchange = (e)=>{ state.settings.mode=e.target.value; saveState(state); render(); };
  $("#setTimer").onchange = (e)=>{ state.settings.timerOn=(e.target.value==="on"); saveState(state); render(); };
  $("#setShuffleQ").onchange = (e)=>{ state.settings.shuffleQuestions=(e.target.value==="on"); saveState(state); };
  $("#setShuffleA").onchange = (e)=>{ state.settings.shuffleAnswers=(e.target.value==="on"); saveState(state); render(); };
  $("#setOptFb").onchange = (e)=>{ state.settings.showAllOptionFeedback=(e.target.value==="all"); saveState(state); render(); };
  $("#setTagFilter").onchange = (e)=>{ state.settings.tagFilter=e.target.value; saveState(state); render(); };

  $("#btnOpenSettings").onclick = ()=> overlay.classList.remove("hidden");
  $("#btnCloseSettings").onclick = ()=> overlay.classList.add("hidden");

  $("#btnResetAll").onclick = ()=>{
    if (!confirm("Reset everything? This clears your quiz + progress.")) return;
    clearState();
    state = structuredClone(defaultState);
    location.hash = "";
    render();
  };

  $("#btnDownloadState").onclick = ()=>{
    downloadJson("quizcraft-state.json", state);
  };
}

// ---- boot: load hash → localStorage → default ----
(async function boot(){
  const hash = location.hash || "";
  const m = hash.match(/#q=([^&]+)/);
  if (m?.[1]){
    const decoded = await decodeFromHash(m[1]);
    if (decoded?.quiz?.questions?.length){
      state = decoded;
      saveState(state);
      render();
      return;
    }
  }
  const saved = loadState();
  if (saved?.version === 1){
    state = saved;
  }
  render();

  // timer tick
  setInterval(()=>{
    if (state.route==="quiz" && state.settings.timerOn && state.startMs){
      state.elapsed = nowMs() - state.startMs;
      saveState(state);
      const timeSlot = document.querySelector(".progressTop .muted:last-child");
      if (timeSlot) timeSlot.innerHTML = `⏱ ${fmtTime(state.elapsed)}`;
    }
  }, 500);

  // keyboard shortcuts
  window.addEventListener("keydown", (e)=>{
    if (state.route!=="quiz") return;
    const q = currentQuestion();
    if (!q) return;

    if (e.key==="ArrowLeft"){ e.preventDefault(); goPrev(); }
    if (e.key==="ArrowRight"){ e.preventDefault(); goNext(); }
    if (e.key.toLowerCase()==="f"){ e.preventDefault(); toggleFlag(q.id); }

    const n = parseInt(e.key,10);
    if (n>=1 && n<=4){
      e.preventDefault();
      const L = ["A","B","C","D"][n-1];
      if (L) chooseAnswer(q.id, L);
    }
  });
})();
