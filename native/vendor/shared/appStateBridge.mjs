/**
 * Sandboxed app bridge protocol (web + native):
 * - The iframe/WebView emits `rabbithole:snapshot:ready` with a per-load nonce.
 * - The host sends `rabbithole:snapshot` with nonce, requestId, maxWidth, width,
 *   and height. Web passes the iframe's layout size; native must pass the
 *   WebView's current layout size because sandboxed content may report zero.
 * - The iframe/WebView replies `rabbithole:snapshot:result` with dataUrl+hash or error.
 * - DOM capture uses dom-to-image's same-document SVG foreignObject path, which
 *   works when the sandbox gives srcdoc an opaque origin.
 * Web uses postMessage; the later native lane forwards requests through
 * `window.__rabbitholeSnapshotReceive` and receives replies via ReactNativeWebView.
 */
import {
  APP_ACTION_NAME_PATTERN,
  FORBIDDEN_APP_ACTION_NAME_PATTERN,
  MAX_APP_ACTIONS,
  MAX_APP_ACTION_DESCRIPTION_CHARS,
  MAX_APP_ACTION_ERROR_CHARS,
  MAX_APP_ACTION_NAME_CHARS,
  MAX_APP_ACTION_RESULT_BYTES,
  jsonByteLength,
  normalizeAppActionRegistry,
} from "../shared/appActionPolicy.ts";
import { DOM_TO_IMAGE_SOURCE } from "../shared/domToImageSource.ts";
import { RABBITHOLE_APP_STYLE_ELEMENT } from "../shared/rabbitholeAppStyles.ts";
import {
  MAX_APP_TUTOR_CONTEXT_BYTES,
  MAX_APP_TUTOR_MESSAGE_CHARS,
  normalizeAppTutorRequest,
} from "../shared/appTutorRequest.ts";
import {
  APP_BRIDGE_ERROR_CODES,
  APP_JUDGE_ID_PATTERN,
  APP_REQUEST_TIMEOUT_MS,
  MAX_CHARACTER_LINE_CHARS,
  MAX_JUDGE_ANSWER_CHARS,
  normalizeAppAiContext,
} from "../shared/appAiPolicy.ts";

export const APP_STATE_PROTOCOL = "rabbithole:app-state";
export const APP_STATE_PROTOCOL_VERSION = 1;
export const APP_STATE_WRITE_DEBOUNCE_MS = 250;
export const APP_STATE_MAX_WRITE_LATENCY_MS = 2_000;
export const APP_STATE_MAX_LOG_ENTRIES = 30;
export const APP_STATE_MAX_LOG_CHARS = 300;
export const APP_SNAPSHOT_READY_TYPE = "rabbithole:snapshot:ready";
export const APP_SNAPSHOT_REQUEST_TYPE = "rabbithole:snapshot";
export const APP_SNAPSHOT_RESULT_TYPE = "rabbithole:snapshot:result";
export const APP_SNAPSHOT_MAX_WIDTH = 800;
export const APP_SNAPSHOT_TIMEOUT_MS = 6_000;

export function hashAppSnapshotDataUrl(dataUrl) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < dataUrl.length; index++) {
    hash ^= dataUrl.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const APP_SNAPSHOT_HASH_FUNCTION = `(${hashAppSnapshotDataUrl.toString()})`;
// The vendored source is injected first. If that invariant is ever broken, the
// legacy loader branch fails closed without making a network request.
const DOM_TO_IMAGE_URL = "data:text/javascript,";

export const RABBITHOLE_APP_SNAPSHOT_SDK = String.raw`(()=>{const P="${APP_STATE_PROTOCOL}",V=${APP_STATE_PROTOCOL_VERSION},R="${APP_SNAPSHOT_READY_TYPE}",Q="${APP_SNAPSHOT_REQUEST_TYPE}",O="${APP_SNAPSHOT_RESULT_TYPE}",N=!!window.ReactNativeWebView,B=N&&window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView),J=JSON.stringify,r=crypto.getRandomValues(new Uint32Array(4)).join("-"),H=${APP_SNAPSHOT_HASH_FUNCTION};let L=null;const x=(t,v={})=>{const m={protocol:P,version:V,nonce:r,type:t,...v};N?B(J(m)):parent.postMessage(m,"*")},d=(c,m)=>{if(!c.width||!c.height)throw new Error("Empty");if(c.width<=m)return c.toDataURL("image/jpeg",.7);const o=document.createElement("canvas"),s=m/c.width;o.width=m;o.height=Math.ceil(c.height*s);const g=o.getContext("2d");if(!g)throw new Error("Canvas unavailable");g.drawImage(c,0,0,o.width,o.height);return o.toDataURL("image/jpeg",.7)},k=(w,h)=>{const q=document.querySelectorAll("canvas");if(q.length!==1)return null;const c=q[0];return c.width*c.height>=w*h*.6?c:null},l=()=>window.domtoimage?Promise.resolve(window.domtoimage):L??=new Promise((a,j)=>{const s=document.createElement("script");s.integrity="sha384-zESinL+vR3OR5XGFqKjneclbVKOL8SfP+fKKO3K9BHAaPtboci56Vu3g5flevHk9";s.crossOrigin="anonymous";s.src="${DOM_TO_IMAGE_URL}";s.onload=()=>window.domtoimage?a(window.domtoimage):j(new Error("dom-to-image unavailable"));s.onerror=()=>j(new Error("dom-to-image load failed"));(document.head||document.documentElement).appendChild(s)}),c=async(m,w,h)=>{try{const f=await l(),b=document.body||document.documentElement,s=Math.min(1,m/w),W=Math.ceil(w*s),T=Math.ceil(h*s);if([...document.querySelectorAll("canvas")].some(c=>!(c.width&&c.height)&&c.getBoundingClientRect().width)){dispatchEvent(new Event("resize"));await new Promise(r=>setTimeout(r,1500))}const p=await f.toPng(b,{bgcolor:"#fff",width:W,height:T,filter:n=>n.tagName!=="CANVAS"&&n.tagName!=="SCRIPT",style:{transform:"scale("+s+")",transformOrigin:"top left",width:w+"px",height:h+"px"}}),i=new Image;await new Promise((a,j)=>{i.onload=a;i.onerror=()=>j(new Error("Render failed"));i.src=p});const o=document.createElement("canvas");o.width=W;o.height=T;const g=o.getContext("2d");if(!g)throw new Error("Canvas unavailable");g.drawImage(i,0,0);const M=[];for(const c of document.querySelectorAll("canvas")){const r=c.getBoundingClientRect();if(c.width&&c.height&&r.width&&r.height)try{g.drawImage(c,r.left*s,r.top*s,r.width*s,r.height*s);M.push([c.width,c.height,r.width,r.height,"ok"])}catch(e){M.push([c.width,c.height,String(e)])}else M.push([c.width,c.height,r.width,r.height,"skip"])}return{u:o.toDataURL("image/jpeg",.7),M}}catch(e){const q=k(w,h);if(q)return d(q,m);throw e}},z=m=>{const i=typeof m.requestId==="string"?m.requestId.trim():"";if(!i)return;const a=Number.isFinite(m.maxWidth)?Math.max(1,Math.min(1600,Math.round(m.maxWidth))):${APP_SNAPSHOT_MAX_WIDTH},E=document.documentElement,b=document.body,w=Number.isFinite(m.width)&&m.width>0?m.width:Math.max(innerWidth,E.clientWidth,b?.clientWidth||0)||800,h=Number.isFinite(m.height)&&m.height>0?m.height:Math.max(innerHeight,E.clientHeight,b?.clientHeight||0)||600;let t;Promise.race([c(a,w,h),new Promise((_,j)=>{t=setTimeout(()=>j(new Error("Timeout")),${APP_SNAPSHOT_TIMEOUT_MS})})]).then(v=>{const u=typeof v==="string"?v:v.u;x(O,{requestId:i,dataUrl:u,hash:H(u),meta:typeof v==="string"?null:v.M})},e=>x(O,{requestId:i,error:String(e&&e.message?e.message:e).slice(0,300)})).finally(()=>clearTimeout(t))},h=m=>{if(typeof m==="string")try{m=JSON.parse(m)}catch{return}if(!m||m.protocol!==P||m.version!==V||m.nonce!==r||m.type!==Q)return;z(m)},y=()=>x(R);if(N)Object.defineProperty(window,"__rabbitholeSnapshotReceive",{value:h});else addEventListener("message",e=>{if(e.source===parent)h(e.data)},true);addEventListener("DOMContentLoaded",y);addEventListener("load",y);y()})();true;`;

// `character.say` and `judge` share one request/response pair: the frame posts
// `request` {requestId, method, params}; the host answers `response`
// {requestId, ok, result|error}. One call per method in flight, a client-side
// timeout, and a user-activation gate live in the SDK; the host and server own
// everything else. An optional `{ context }` second/third argument rides along
// as a JSON-safe copy; the host parser is where its rules are enforced.
// Tutor-spoken character lines arrive on init/update as `characterLine` and
// fire `character.onLine` once per id per page load.
export const RABBITHOLE_APP_STATE_SDK = String.raw`(()=>{const P="${APP_STATE_PROTOCOL}",V=${APP_STATE_PROTOCOL_VERSION},N=!!window.ReactNativeWebView,B=N&&window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView),J=JSON.stringify,r=crypto.getRandomValues(new Uint32Array(4)).join("-"),R=${APP_ACTION_NAME_PATTERN},Q=${FORBIDDEN_APP_ACTION_NAME_PATTERN},Y=navigator.userActivation;let s={},i=false,p={},l=[],f=new Set,u={},a=false,d=null,g={},w=new Set,e=[],z=new Set,M=new Map,L=null,G=new Map,U=new Set,W=new Set,X=0;const o=x=>x&&typeof x==="object"&&!Array.isArray(x),n=()=>f.forEach(c=>c(s)),q=()=>w.forEach(c=>c(u)),k=()=>z.forEach(c=>c(e)),x=(t,v={})=>{const m={protocol:P,version:V,nonce:r,type:t,...v};N?B(J(m)):parent.postMessage(m,"*")},Z=(c,j)=>Object.assign(new Error(j),{code:c}),K=(c,j)=>Promise.reject(Z(c,j)),O=v=>{try{return{context:JSON.parse(J(v.context))}}catch{return{}}},E=(m,v)=>{if(Y&&Y.hasBeenActive===false)return K("needs-gesture","rabbithole."+m+" must follow a tap or key press");for(const c of G.values())if(c.m===m)return K("busy","rabbithole."+m+" is already waiting for a reply");const c="q"+ ++X;return new Promise((b,j)=>{G.set(c,{m,b,j,t:setTimeout(()=>{G.delete(c);j(Z("timeout","rabbithole."+m+" timed out"))},${APP_REQUEST_TIMEOUT_MS})});x("request",{requestId:c,method:m,params:v})})},D=v=>{if(!o(v)||typeof v.id!=="string"||typeof v.line!=="string"||U.has(v.id))return;U.add(v.id);W.forEach(c=>c(v))},F=()=>x("actions",{actions:[...M].map(([name,v])=>({name,description:v.description}))}),y=()=>{if(!i){x("ready");F()}},C=v=>{const j=J(v===undefined?null:v);if(j===undefined||new TextEncoder().encode(j).length>${MAX_APP_ACTION_RESULT_BYTES})throw new Error("Action result is too large or not JSON-serializable");return JSON.parse(j)},T=(m,v={})=>{m=typeof m==="string"?m.trim():"";if(!m||m.length>${MAX_APP_TUTOR_MESSAGE_CHARS})throw new TypeError("rabbithole.askTutor requires a short message");const c=v&&v.context;if(c!==undefined&&!o(c))throw new TypeError("rabbithole.askTutor context must be an object");let j;if(c!==undefined){try{j=J(c)}catch{}if(j===undefined||new TextEncoder().encode(j).length>${MAX_APP_TUTOR_CONTEXT_BYTES})throw new TypeError("rabbithole.askTutor context is too large or not JSON-serializable")}x("askTutor",{message:m,...(j===undefined?{}:{context:JSON.parse(j)})})},I=async v=>{if(!o(v)||typeof v.id!=="string"||typeof v.name!=="string"||v.id===L)return;L=v.id;const c=M.get(v.name);if(!c){x("actionResult",{requestId:v.id,ok:false,error:"Action is no longer registered"});return}try{x("actionResult",{requestId:v.id,ok:true,result:C(await c.fn(v.args))})}catch(t){x("actionResult",{requestId:v.id,ok:false,error:String(t&&t.message?t.message:t).slice(0,${MAX_APP_ACTION_ERROR_CHARS})})}},A=m=>{if(m.shared===null){d=null;u={};e=[];a=false;q();k();return}if(!o(m.shared))return;d=typeof m.shared.roomId==="string"?m.shared.roomId:null;u={...(o(m.shared.doc)?m.shared.doc:{}),...g};e=Array.isArray(m.shared.presence)?m.shared.presence:[];a=!!d;q();k();if(a&&Object.keys(g).length)x("sharedChange",{roomId:d,patch:g});g={}},h=m=>{if(typeof m==="string")try{m=JSON.parse(m)}catch{return}if(!m||m.protocol!==P||m.version!==V||m.nonce!==r)return;if(m.type==="init"&&!i){s={...(o(m.doc)?m.doc:{}),...p};i=true;n();A(m);I(m.actionRequest);D(m.characterLine);if(Object.keys(p).length||l.length)x("change",{patch:p,logs:l});p={};l=[]}else if(m.type==="update"&&i){s=o(m.doc)?m.doc:{};n();A(m);I(m.actionRequest);D(m.characterLine)}else if(m.type==="response"){const c=G.get(m.requestId);if(c){G.delete(m.requestId);clearTimeout(c.t);m.ok?c.b(m.result):c.j(Z(m.error?.code||"failed",m.error?.message||"Request failed"))}}};const S={getState:()=>u,setState:v=>{if(!o(v))throw new TypeError("rabbithole.shared.setState expects an object patch");if(!a||!d)throw new Error("No shared room is connected");u={...u,...v};q();x("sharedChange",{roomId:d,patch:v})},subscribe:c=>{w.add(c);if(a)c(u);return()=>w.delete(c)},getPresence:()=>e,subscribePresence:c=>{z.add(c);if(a)c(e);return()=>z.delete(c)},isAvailable:()=>a,connect:v=>{if(typeof v!=="string"||!v.trim())throw new TypeError("rabbithole.shared.connect expects a room id");d=v.trim();u={};e=[];a=false;q();k();x("sharedSelect",{roomId:d})}};window.rabbithole={getState:()=>s,setState:v=>{if(!o(v))throw new TypeError("rabbithole.setState expects an object patch");s={...(o(s)?s:{}),...v};if(i){n();x("change",{patch:v})}else p={...p,...v}},subscribe:c=>{f.add(c);if(i)c(s);return()=>f.delete(c)},askTutor:T,registerAction:(name,description,fn)=>{name=typeof name==="string"?name.trim():"";description=typeof description==="string"?description.trim():"";if(!name||name.length>${MAX_APP_ACTION_NAME_CHARS}||!R.test(name)||Q.test(name))throw new TypeError("rabbithole.registerAction requires a stage-setting identifier name");if(!description||description.length>${MAX_APP_ACTION_DESCRIPTION_CHARS})throw new TypeError("rabbithole.registerAction requires a short description");if(typeof fn!=="function")throw new TypeError("rabbithole.registerAction requires a function");if(!M.has(name)&&M.size>=${MAX_APP_ACTIONS})throw new Error("Too many registered app actions");M.set(name,{description,fn});F();return()=>{if(M.get(name)?.fn===fn){M.delete(name);F()}}},shared:S,character:{say:(t,v)=>{t=typeof t==="string"?t.trim():"";return t?E("character.say",{text:t.slice(0,${MAX_CHARACTER_LINE_CHARS}),...O(v)}):K("invalid","rabbithole.character.say requires text")},onLine:c=>{if(typeof c!=="function")throw new TypeError("rabbithole.character.onLine requires a function");W.add(c);return()=>W.delete(c)}},judge:(c,t,v)=>{c=typeof c==="string"?c.trim():"";t=typeof t==="string"?t.trim():"";return ${APP_JUDGE_ID_PATTERN}.test(c)&&t?E("judge",{judgeId:c,answer:t.slice(0,${MAX_JUDGE_ANSWER_CHARS}),...O(v)}):K("invalid","rabbithole.judge requires a judge id and an answer")}};["log","warn","error"].forEach(t=>{const c=console[t].bind(console);console[t]=(...b)=>{c(...b);const v={level:t,message:b.map(j=>{if(typeof j==="string")return j;try{const m=J(j);return m===undefined?String(j):m}catch{return String(j)}}).join(" ").slice(0,${APP_STATE_MAX_LOG_CHARS})};if(i)x("change",{logs:[v]});else{l.push(v);l=l.slice(-${APP_STATE_MAX_LOG_ENTRIES})}}});if(N)Object.defineProperty(window,"__rabbitholeReceive",{value:h});else addEventListener("message",v=>{if(v.source===parent)h(v.data)},true);addEventListener("DOMContentLoaded",y);addEventListener("load",y);y()})();true;`;

export const RABBITHOLE_APP_STATE_SDK_BYTES =
  new TextEncoder().encode(RABBITHOLE_APP_STATE_SDK).byteLength;
export const RABBITHOLE_APP_SNAPSHOT_SDK_BYTES =
  new TextEncoder().encode(RABBITHOLE_APP_SNAPSHOT_SDK).byteLength;

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function mergeAppStateDoc(doc, patches) {
  return Object.assign(
    {},
    isObject(doc) ? doc : {},
    ...patches.filter(isObject),
  );
}

export function appActionRegistryWriteDecision(previousActions, nextActions) {
  if (previousActions === undefined) return "defer";
  return nextActions.length > 0 ||
    normalizeAppActionRegistry(previousActions).length > 0
    ? "persist"
    : "skip";
}

export function appStateFlushDelay(oldestPendingAt, now = Date.now()) {
  if (oldestPendingAt === undefined) return APP_STATE_WRITE_DEBOUNCE_MS;
  return Math.max(
    0,
    Math.min(
      APP_STATE_WRITE_DEBOUNCE_MS,
      APP_STATE_MAX_WRITE_LATENCY_MS - (now - oldestPendingAt),
    ),
  );
}

export function parseAppStateBridgeMessage(value) {
  let message = value;
  if (typeof message === "string") {
    try {
      message = JSON.parse(message);
    } catch {
      return null;
    }
  }
  if (
    !isObject(message) ||
    message.protocol !== APP_STATE_PROTOCOL ||
    message.version !== APP_STATE_PROTOCOL_VERSION
  ) {
    return null;
  }
  if (typeof message.nonce !== "string" || !message.nonce) return null;
  if (message.type === APP_SNAPSHOT_READY_TYPE) {
    return { type: APP_SNAPSHOT_READY_TYPE, nonce: message.nonce };
  }
  if (message.type === APP_SNAPSHOT_RESULT_TYPE) {
    const requestId =
      typeof message.requestId === "string" ? message.requestId.trim() : "";
    if (!requestId) return null;
    if (
      typeof message.dataUrl === "string" &&
      /^data:image\/(?:jpeg|png);base64,/.test(message.dataUrl) &&
      typeof message.hash === "string" &&
      message.hash
    ) {
      return {
        type: APP_SNAPSHOT_RESULT_TYPE,
        nonce: message.nonce,
        requestId,
        dataUrl: message.dataUrl,
        hash: message.hash,
      };
    }
    if (typeof message.error === "string" && message.error) {
      return {
        type: APP_SNAPSHOT_RESULT_TYPE,
        nonce: message.nonce,
        requestId,
        error: message.error.slice(0, 300),
      };
    }
    return null;
  }
  if (message.type === "ready") {
    return { type: "ready", nonce: message.nonce };
  }
  if (message.type === "sharedSelect") {
    const roomId =
      typeof message.roomId === "string" ? message.roomId.trim() : "";
    return roomId
      ? { type: "sharedSelect", nonce: message.nonce, roomId }
      : null;
  }
  if (message.type === "sharedChange") {
    const roomId =
      typeof message.roomId === "string" ? message.roomId.trim() : "";
    const patch = isObject(message.patch) ? message.patch : undefined;
    return roomId && patch
      ? { type: "sharedChange", nonce: message.nonce, roomId, patch }
      : null;
  }
  if (message.type === "actions") {
    if (!Array.isArray(message.actions)) return null;
    return {
      type: "actions",
      nonce: message.nonce,
      actions: normalizeAppActionRegistry(message.actions),
    };
  }
  if (message.type === "askTutor") {
    const request = normalizeAppTutorRequest(message);
    return request
      ? { type: "askTutor", nonce: message.nonce, ...request }
      : null;
  }
  if (message.type === "actionResult") {
    const requestId =
      typeof message.requestId === "string" ? message.requestId.trim() : "";
    if (!requestId || typeof message.ok !== "boolean") return null;
    if (message.ok) {
      try {
        if (jsonByteLength(message.result) > MAX_APP_ACTION_RESULT_BYTES) {
          return {
            type: "actionResult",
            nonce: message.nonce,
            requestId,
            ok: false,
            error: "Action result exceeded the size limit",
          };
        }
      } catch {
        return {
          type: "actionResult",
          nonce: message.nonce,
          requestId,
          ok: false,
          error: "Action result was not JSON-serializable",
        };
      }
      return {
        type: "actionResult",
        nonce: message.nonce,
        requestId,
        ok: true,
        result: message.result,
      };
    }
    const error =
      typeof message.error === "string"
        ? message.error.slice(0, MAX_APP_ACTION_ERROR_CHARS)
        : "Action failed";
    return {
      type: "actionResult",
      nonce: message.nonce,
      requestId,
      ok: false,
      error,
    };
  }
  if (message.type === "request") {
    return parseAppBridgeRequest(message);
  }
  if (message.type !== "change") return null;

  const patch = isObject(message.patch) ? message.patch : undefined;
  const logs = Array.isArray(message.logs)
    ? message.logs.filter(
        (entry) =>
          isObject(entry) &&
          ["log", "warn", "error"].includes(entry.level) &&
          typeof entry.message === "string",
      ).map((entry) => ({
        level: entry.level,
        message: entry.message.slice(0, APP_STATE_MAX_LOG_CHARS),
      })).slice(-APP_STATE_MAX_LOG_ENTRIES)
    : undefined;
  return patch || logs?.length
    ? { type: "change", nonce: message.nonce, patch, logs }
    : null;
}

const trimmedString = (value) =>
  typeof value === "string" ? value.trim() : "";

// A frame→host request for one server-backed AI call (shared/appAiPolicy.ts).
// Only the two known methods parse; params are trimmed and clamped here so a
// host never forwards an unbounded or malformed payload to Convex.
function parseAppBridgeRequest(message) {
  const requestId = trimmedString(message.requestId);
  if (!requestId || requestId.length > 64 || !isObject(message.params)) {
    return null;
  }
  const base = { type: "request", nonce: message.nonce, requestId };
  if (message.method === "character.say") {
    const text = trimmedString(message.params.text);
    if (!text) return null;
    return {
      ...base,
      method: "character.say",
      params: {
        text: text.slice(0, MAX_CHARACTER_LINE_CHARS),
        ...contextParam(message.params.context),
      },
    };
  }
  if (message.method === "judge") {
    const judgeId = trimmedString(message.params.judgeId);
    const answer = trimmedString(message.params.answer);
    if (!APP_JUDGE_ID_PATTERN.test(judgeId) || !answer) return null;
    return {
      ...base,
      method: "judge",
      params: {
        judgeId,
        answer: answer.slice(0, MAX_JUDGE_ANSWER_CHARS),
        ...contextParam(message.params.context),
      },
    };
  }
  return null;
}

// Junk context is dropped, never a reason to refuse the call: the app's text
// still reaches the character, just without the facts it tried to attach.
function contextParam(value) {
  const context = normalizeAppAiContext(value);
  return context ? { context } : {};
}

export function matchesAppStateBridgeNonce(message, activeNonce) {
  return (
    typeof activeNonce === "string" &&
    activeNonce.length > 0 &&
    message.nonce === activeNonce
  );
}

export function createAppStateHostMessage(
  type,
  doc,
  nonce,
  shared,
  actionRequest,
  characterLine,
) {
  if (type !== "init" && type !== "update") {
    throw new Error(`Unsupported app-state host message: ${type}`);
  }
  if (typeof nonce !== "string" || !nonce) {
    throw new Error("App-state host message requires a bridge nonce");
  }
  const message = {
    protocol: APP_STATE_PROTOCOL,
    version: APP_STATE_PROTOCOL_VERSION,
    nonce,
    type,
    doc: isObject(doc) ? doc : {},
  };
  if (shared === null) {
    message.shared = null;
  } else if (
    isObject(shared) &&
    typeof shared.roomId === "string" &&
    shared.roomId
  ) {
    message.shared = {
      roomId: shared.roomId,
      doc: isObject(shared.doc) ? shared.doc : {},
      presence: Array.isArray(shared.presence) ? shared.presence : [],
    };
  }
  if (
    isObject(actionRequest) &&
    typeof actionRequest.id === "string" &&
    typeof actionRequest.name === "string"
  ) {
    message.actionRequest = actionRequest;
  }
  if (
    isObject(characterLine) &&
    typeof characterLine.id === "string" &&
    characterLine.id &&
    typeof characterLine.line === "string"
  ) {
    message.characterLine = {
      id: characterLine.id,
      line: characterLine.line,
      ...(typeof characterLine.mood === "string"
        ? { mood: characterLine.mood }
        : {}),
      ...(typeof characterLine.verdict === "string"
        ? { verdict: characterLine.verdict }
        : {}),
    };
  }
  return message;
}

// Host→frame reply to one `request`. An unknown error code degrades to
// "failed" so the in-frame Promise always rejects with a documented code.
export function createAppBridgeResponseMessage(nonce, requestId, payload) {
  if (typeof nonce !== "string" || !nonce) {
    throw new Error("App bridge response requires a bridge nonce");
  }
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("App bridge response requires a request id");
  }
  const message = {
    protocol: APP_STATE_PROTOCOL,
    version: APP_STATE_PROTOCOL_VERSION,
    nonce,
    type: "response",
    requestId,
  };
  if (isObject(payload) && payload.ok === true) {
    return { ...message, ok: true, result: payload.result };
  }
  const error = isObject(payload) && isObject(payload.error)
    ? payload.error
    : {};
  return {
    ...message,
    ok: false,
    error: {
      code: APP_BRIDGE_ERROR_CODES.includes(error.code) ? error.code : "failed",
      message:
        typeof error.message === "string" && error.message
          ? error.message.slice(0, 300)
          : "Request failed",
    },
  };
}

export function createAppSnapshotRequestMessage(
  nonce,
  requestId,
  maxWidth = APP_SNAPSHOT_MAX_WIDTH,
  width,
  height,
) {
  if (typeof nonce !== "string" || !nonce) {
    throw new Error("App snapshot request requires a bridge nonce");
  }
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("App snapshot request requires a request id");
  }
  return {
    protocol: APP_STATE_PROTOCOL,
    version: APP_STATE_PROTOCOL_VERSION,
    nonce,
    type: APP_SNAPSHOT_REQUEST_TYPE,
    requestId,
    maxWidth,
    width,
    height,
  };
}

export function appStateHostInjectionScript(
  type,
  doc,
  nonce,
  shared,
  actionRequest,
  characterLine,
) {
  const message = JSON.stringify(
    createAppStateHostMessage(
      type,
      doc,
      nonce,
      shared,
      actionRequest,
      characterLine,
    ),
  ).replaceAll("<", "\\u003c");
  return `window.__rabbitholeReceive?.(${message});true;`;
}

export function appBridgeResponseInjectionScript(nonce, requestId, payload) {
  const message = JSON.stringify(
    createAppBridgeResponseMessage(nonce, requestId, payload),
  ).replaceAll("<", "\\u003c");
  return `window.__rabbitholeReceive?.(${message});true;`;
}

export function injectAppStateSdk(html) {
  const script =
    `<script>${DOM_TO_IMAGE_SOURCE}</script>` +
    `<script>${RABBITHOLE_APP_SNAPSHOT_SDK}</script>` +
    `<script>${RABBITHOLE_APP_STATE_SDK}</script>`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  const prefix = doctype?.[0] ?? "";
  const body = doctype ? html.slice(prefix.length) : html;
  // Literal source order is the security boundary: HTML permits executable
  // content before a declared <head>, so inserting "inside head" can still run
  // after app code. Immediately after the doctype is always first execution.
  //
  // The brand stylesheet (rabbithole-app.css) follows the scripts but still
  // precedes ALL app markup/styles, so its element defaults stay overridable by
  // an app that deliberately restyles a control (source-order cascade), while
  // an app that doesn't inherits the Rabbithole look and the inlined font.
  return `${prefix}\n${script}${RABBITHOLE_APP_STYLE_ELEMENT}${body}`;
}
