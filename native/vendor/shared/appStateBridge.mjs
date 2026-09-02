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

export const APP_STATE_PROTOCOL = "rabbithole:app-state";
export const APP_STATE_PROTOCOL_VERSION = 1;
export const APP_STATE_WRITE_DEBOUNCE_MS = 250;
export const APP_STATE_MAX_WRITE_LATENCY_MS = 2_000;
export const APP_STATE_MAX_LOG_ENTRIES = 30;
export const APP_STATE_MAX_LOG_CHARS = 300;

export const RABBITHOLE_APP_STATE_SDK = String.raw`(()=>{const P="${APP_STATE_PROTOCOL}",V=${APP_STATE_PROTOCOL_VERSION},N=!!window.ReactNativeWebView,B=N&&window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView),J=JSON.stringify,r=crypto.getRandomValues(new Uint32Array(4)).join("-"),R=${APP_ACTION_NAME_PATTERN},Q=${FORBIDDEN_APP_ACTION_NAME_PATTERN};let s={},i=false,p={},l=[],f=new Set,u={},a=false,d=null,g={},w=new Set,e=[],z=new Set,M=new Map,L=null;const o=x=>x&&typeof x==="object"&&!Array.isArray(x),n=()=>f.forEach(c=>c(s)),q=()=>w.forEach(c=>c(u)),k=()=>z.forEach(c=>c(e)),x=(t,v={})=>{const m={protocol:P,version:V,nonce:r,type:t,...v};N?B(J(m)):parent.postMessage(m,"*")},F=()=>x("actions",{actions:[...M].map(([name,v])=>({name,description:v.description}))}),y=()=>{if(!i){x("ready");F()}},C=v=>{const j=J(v===undefined?null:v);if(j===undefined||new TextEncoder().encode(j).length>${MAX_APP_ACTION_RESULT_BYTES})throw new Error("Action result is too large or not JSON-serializable");return JSON.parse(j)},I=async v=>{if(!o(v)||typeof v.id!=="string"||typeof v.name!=="string"||v.id===L)return;L=v.id;const c=M.get(v.name);if(!c){x("actionResult",{requestId:v.id,ok:false,error:"Action is no longer registered"});return}try{x("actionResult",{requestId:v.id,ok:true,result:C(await c.fn(v.args))})}catch(t){x("actionResult",{requestId:v.id,ok:false,error:String(t&&t.message?t.message:t).slice(0,${MAX_APP_ACTION_ERROR_CHARS})})}},A=m=>{if(m.shared===null){d=null;u={};e=[];a=false;q();k();return}if(!o(m.shared))return;d=typeof m.shared.roomId==="string"?m.shared.roomId:null;u={...(o(m.shared.doc)?m.shared.doc:{}),...g};e=Array.isArray(m.shared.presence)?m.shared.presence:[];a=!!d;q();k();if(a&&Object.keys(g).length)x("sharedChange",{roomId:d,patch:g});g={}},h=m=>{if(typeof m==="string")try{m=JSON.parse(m)}catch{return}if(!m||m.protocol!==P||m.version!==V||m.nonce!==r)return;if(m.type==="init"&&!i){s={...(o(m.doc)?m.doc:{}),...p};i=true;n();A(m);I(m.actionRequest);if(Object.keys(p).length||l.length)x("change",{patch:p,logs:l});p={};l=[]}else if(m.type==="update"&&i){s=o(m.doc)?m.doc:{};n();A(m);I(m.actionRequest)}};const S={getState:()=>u,setState:v=>{if(!o(v))throw new TypeError("rabbithole.shared.setState expects an object patch");if(!a||!d)throw new Error("No shared room is connected");u={...u,...v};q();x("sharedChange",{roomId:d,patch:v})},subscribe:c=>{w.add(c);if(a)c(u);return()=>w.delete(c)},getPresence:()=>e,subscribePresence:c=>{z.add(c);if(a)c(e);return()=>z.delete(c)},isAvailable:()=>a,connect:v=>{if(typeof v!=="string"||!v.trim())throw new TypeError("rabbithole.shared.connect expects a room id");d=v.trim();u={};e=[];a=false;q();k();x("sharedSelect",{roomId:d})}};window.rabbithole={getState:()=>s,setState:v=>{if(!o(v))throw new TypeError("rabbithole.setState expects an object patch");s={...(o(s)?s:{}),...v};if(i){n();x("change",{patch:v})}else p={...p,...v}},subscribe:c=>{f.add(c);if(i)c(s);return()=>f.delete(c)},registerAction:(name,description,fn)=>{name=typeof name==="string"?name.trim():"";description=typeof description==="string"?description.trim():"";if(!name||name.length>${MAX_APP_ACTION_NAME_CHARS}||!R.test(name)||Q.test(name))throw new TypeError("rabbithole.registerAction requires a stage-setting identifier name");if(!description||description.length>${MAX_APP_ACTION_DESCRIPTION_CHARS})throw new TypeError("rabbithole.registerAction requires a short description");if(typeof fn!=="function")throw new TypeError("rabbithole.registerAction requires a function");if(!M.has(name)&&M.size>=${MAX_APP_ACTIONS})throw new Error("Too many registered app actions");M.set(name,{description,fn});F();return()=>{if(M.get(name)?.fn===fn){M.delete(name);F()}}},shared:S};["log","warn","error"].forEach(t=>{const c=console[t].bind(console);console[t]=(...b)=>{c(...b);const v={level:t,message:b.map(j=>{if(typeof j==="string")return j;try{const m=J(j);return m===undefined?String(j):m}catch{return String(j)}}).join(" ").slice(0,${APP_STATE_MAX_LOG_CHARS})};if(i)x("change",{logs:[v]});else{l.push(v);l=l.slice(-${APP_STATE_MAX_LOG_ENTRIES})}}});if(N)Object.defineProperty(window,"__rabbitholeReceive",{value:h});else addEventListener("message",v=>{if(v.source===parent)h(v.data)},true);addEventListener("DOMContentLoaded",y);addEventListener("load",y);y()})();true;`;

export const RABBITHOLE_APP_STATE_SDK_BYTES =
  new TextEncoder().encode(RABBITHOLE_APP_STATE_SDK).byteLength;

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
  return message;
}

export function appStateHostInjectionScript(
  type,
  doc,
  nonce,
  shared,
  actionRequest,
) {
  const message = JSON.stringify(
    createAppStateHostMessage(type, doc, nonce, shared, actionRequest),
  ).replaceAll("<", "\\u003c");
  return `window.__rabbitholeReceive?.(${message});true;`;
}

export function injectAppStateSdk(html) {
  const script = `<script>${RABBITHOLE_APP_STATE_SDK}</script>`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  const prefix = doctype?.[0] ?? "";
  const body = doctype ? html.slice(prefix.length) : html;
  // Literal source order is the security boundary: HTML permits executable
  // content before a declared <head>, so inserting "inside head" can still run
  // after app code. Immediately after the doctype is always first execution.
  return `${prefix}\n${script}${body}`;
}
