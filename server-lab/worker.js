/**
 * CLAQE cloud-rendering integration — PRIVATE DEVELOPMENT ONLY.
 *
 * Deploy as a NEW Cloudflare Worker, never over the existing shotlist-api Worker.
 * Requires secrets SHOTSTACK_API_KEY and CLAQE_DEV_TOKEN.
 * DO NOT publish CLAQE_DEV_TOKEN or allow ordinary users to discover it.
 *
 * For a public launch this must gain proper login, atomic quotas / spend caps,
 * upload ownership, retention cleanup, and provider error handling.
 *
 * Ingest source URLs are link-accessible on Shotstack until deleted.
 * Do not invite confidential footage into this dev environment.
 */
const INGEST = "https://api.shotstack.io/ingest/stage";
const EDIT = "https://api.shotstack.io/edit/stage";
const PERMITTED_ORIGINS = new Set(["https://claqe.com", "https://www.claqe.com", "http://localhost:8000", "http://127.0.0.1:8000"]);
const MAX_CLIPS=4, MAX_SECONDS=30, MAX_FILE=500*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i;
const SOURCE_ID=/^[a-zA-Z0-9-]{12,80}$/;
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
function cors(origin){
  if(!PERMITTED_ORIGINS.has(origin))return {};
  return {"Access-Control-Allow-Origin":origin,"Vary":"Origin","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,X-CLAQE-DEV-TOKEN","Access-Control-Max-Age":"180"};
}
function err(message,status,origin){return json({error:message},status,cors(origin));}
async function provider(base,path,env,method="GET",body){
  const response=await fetch(base+path,{
    method,headers:{"x-api-key":env.SHOTSTACK_API_KEY,"Accept":"application/json",...(body?{"Content-Type":"application/json"}:{})},
    body:body?JSON.stringify(body):undefined
  });
  let data;try{data=await response.json()}catch{data=null}
  if(!response.ok)throw new Error("Rendering provider returned HTTP "+response.status+": "+JSON.stringify(data).slice(0,380));
  return data;
}
function styleFor(s){return {cinematic:"muted",dynamic:"boost",vintage:"contrast"}[s]||"muted";}
function effectFor(s,i){return s==="dynamic"?(i%2?"zoomInFast":"slideLeftSlow"):s==="vintage"?"none":i%2?"zoomOutSlow":"zoomInSlow";}
function editOf(sources,style,aspect){
  const maxPer=Math.min(6,MAX_SECONDS/sources.length);
  let time=0;
  const clips=sources.map((s,i)=>{
    const duration=Math.min(maxPer,Math.max(.4,Number(s.duration)-.3));
    const clip={asset:{type:"video",src:s.src,trim:Math.min(.2,Math.max(0,s.duration-duration))},start:Number(time.toFixed(3)),length:Number(duration.toFixed(3)),fit:"cover",filter:styleFor(style)};
    if(duration>1.5&&effectFor(style,i)!=="none")clip.effect=effectFor(style,i);
    time+=duration;
    return clip;
  });
  const total=Number(time.toFixed(3));
  if(total>MAX_SECONDS+0.001)throw new Error("Film exceeds free limit");
  const watermark={asset:{type:"title",text:"claqe.",style:"minimal",color:"#ffffff",size:"x-small",position:"bottomRight"},start:0,length:total};
  return {timeline:{background:"#101216",tracks:[{clips:[watermark]},{clips}]},output:{format:"mp4",resolution:"sd",aspectRatio:aspect==="wide"?"16:9":"9:16",mute:false}};
}
export default {
  async fetch(request,env){
    const origin=request.headers.get("Origin")||"";
    const headers=cors(origin);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers});
    const url=new URL(request.url);
    if(url.pathname==="/health"&&request.method==="GET")return json({ok:true,environment:"private-development",editingAI:false},200,headers);
    if(!env.SHOTSTACK_API_KEY||!env.CLAQE_DEV_TOKEN)return err("Development backend is not configured",503,origin);
    const token=request.headers.get("X-CLAQE-DEV-TOKEN")||"";
    if(token.length<20||token!==env.CLAQE_DEV_TOKEN)return err("Private development access required",401,origin);
    if(origin&&!PERMITTED_ORIGINS.has(origin))return err("Origin not allowed",403,origin);
    if(!["GET","POST"].includes(request.method))return err("Method not allowed",405,origin);
    try{
      if(url.pathname==="/api/upload-ticket"&&request.method==="POST"){
        const body=await request.json();
        if(!body||typeof body.filename!=="string"||body.filename.length>160||typeof body.size!=="number"||body.size<=0||body.size>MAX_FILE) return err("Invalid file or file exceeds 500 MB test limit",400,origin);
        if(!/\.(mp4|mov|m4v|webm)$/i.test(body.filename))return err("Unsupported file extension",400,origin);
        const response=await provider(INGEST,"/upload",env,"POST",{filename:body.filename});
        const d=response.data||{},attr=d.attributes||{};
        if(!d.id||!attr.url)return err("Upload ticket unavailable",502,origin);
        return json({id:d.id,uploadUrl:attr.url,expires:attr.expires},200,headers);
      }
      if(url.pathname==="/api/render"&&request.method==="POST"){
        const body=await request.json();
        const ids=body?.sourceIds;
        if(!Array.isArray(ids)||ids.length<2||ids.length>MAX_CLIPS||ids.some(x=>typeof x!=="string"||!SOURCE_ID.test(x)))return err("Provide 2 to 4 valid source IDs",400,origin);
        if(!["cinematic","dynamic","vintage"].includes(body.style)||!["vertical","wide"].includes(body.format))return err("Invalid editing options",400,origin);
        if(new Set(ids).size!==ids.length)return err("Duplicate sources",400,origin);
        const sources=[];
        for(const id of ids){
          const response=await provider(INGEST,"/sources/"+encodeURIComponent(id),env);
          const attr=response.data?.attributes||{};
          if(attr.status!=="ready")return err("One or more uploads are not ready yet. Try again shortly.",409,origin);
          if(typeof attr.source!=="string"||!attr.source.startsWith("https://")||!Number.isFinite(Number(attr.duration))||Number(attr.duration)<1.5)return err("Invalid video source",422,origin);
          sources.push({src:attr.source,duration:Number(attr.duration)});
        }
        const payload=editOf(sources,body.style,body.format);
        const response=await provider(EDIT,"/render",env,"POST",payload);
        const id=response.response?.id;
        if(!id)return err("Render request was not accepted",502,origin);
        return json({id,status:"queued",duration:payload.timeline.tracks[1].clips.reduce((n,c)=>n+c.length,0)},202,headers);
      }
      if(url.pathname==="/api/status"&&request.method==="GET"){
        const id=url.searchParams.get("id");
        if(!id||!UUID.test(id))return err("Invalid render ID",400,origin);
        const response=await provider(EDIT,"/render/"+encodeURIComponent(id)+"?data=false",env);
        const r=response.response||{};
        return json({id,status:r.status||"unknown",videoUrl:r.status==="done"?(r.url||null):null,error:r.status==="failed"?(r.error||"Unknown render error"):null},200,headers);
      }
      return err("Not found",404,origin);
    }catch(e){return err("Render backend error: "+String(e.message||e).slice(0,450),502,origin);}
  }
};
