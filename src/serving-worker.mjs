/* RaceGraphs v0.04.2 Free — paste this entire file into the Cloudflare Worker editor.
   Add one R2 binding: RG_DATA -> racegraphs-data. No cron or credentials here.
   GitHub Actions imports and validates data; this Worker only serves public files. */
const ORIGINS=['https://racegraphs.com','https://www.racegraphs.com'];
function decorate(response,request){
  const h=new Headers(response.headers),origin=request.headers.get('Origin');
  h.set('Access-Control-Allow-Origin',ORIGINS.includes(origin)?origin:ORIGINS[0]);h.set('Vary','Origin');h.set('X-Content-Type-Options','nosniff');
  h.set('Cache-Control',request.method==='OPTIONS'?'no-store':h.get('X-RG-Immutable')?'public, max-age=31536000, immutable':'no-store');h.delete('X-RG-Immutable');
  return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers:h});
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});}
export async function handle(request,env,ctx={waitUntil:()=>{}},cache=globalThis.caches?.default){
  const reply=r=>decorate(r,request),url=new URL(request.url);
  if(request.method==='OPTIONS')return reply(new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET,HEAD,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}}));
  if(!['GET','HEAD'].includes(request.method))return reply(json({error:'Method not allowed'},405));
  if(url.pathname==='/')return reply(json({service:'RaceGraphs v0.04.2 Free updater',status:'/status',manifest:'/manifest.json',liveTiming:false}));
  if(/^\/live\/\d+$/.test(url.pathname))return reply(json({eventId:Number(url.pathname.slice(6)),phase:'unavailable',rows:[],checkedAt:null}));
  let key,immutable=false;
  if(url.pathname==='/manifest.json')key='public/manifest.json';else if(url.pathname==='/status')key='public/status.json';
  else if(/^\/versions\/[a-zA-Z0-9.-]+\/data\/[a-zA-Z0-9_./~-]+\.json$/.test(url.pathname)&&!url.pathname.includes('..')){key=url.pathname.slice(1);immutable=true;}
  else return reply(json({error:'Not found'},404));
  if(!env.RG_DATA)return reply(json({error:'Add the RG_DATA R2 bucket binding in this Worker’s Bindings tab.'},503));
  // Strip query strings from cache keys. Cache public bodies without visitor-specific CORS headers.
  const cacheKey=new Request(url.origin+url.pathname),cached=cache?await cache.match(cacheKey):null;
  if(cached)return reply(cached);
  try{
    const object=await env.RG_DATA.get(key);if(!object)return reply(json({error:key.startsWith('public/')?'Run the GitHub workflow once to initialize updates.':'Not found'},key.startsWith('public/')?503:404));
    const h={'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age='+(immutable?86400:30)};
    if(object.httpEtag)h.ETag=object.httpEtag;if(immutable)h['X-RG-Immutable']='1';
    const response=new Response(object.body,{headers:h});if(cache)ctx.waitUntil(cache.put(cacheKey,response.clone()).catch(()=>{}));return reply(response);
  }catch{return reply(json({error:'Updates temporarily unavailable; the website retains its bundled data.'},503));}
}
export default {fetch:handle};
