/* Runs in GitHub Actions Node, never inside the Free Worker. */
import Model from './race-model.cjs';
import {readArchive,digest} from './archive.mjs';
const CURRENT='public/manifest.json',STATE='private/poll-state.json',SEED='private/seed.json';
const encode=d=>JSON.stringify(d);
export async function jsonObject(bucket,key){const o=await bucket.get(key);return o?await o.json():null;}
export async function writeJson(bucket,key,value,extra={}){return bucket.put(key,encode(value),{httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'no-store'},...extra});}
export async function lease(bucket,key,ttl,now,run){
  const old=await bucket.get(key),previous=old?await old.json():null;
  if(previous?.until>now)return {busy:true};
  const id=crypto.randomUUID(),value={id,until:now+ttl};const lock=await writeJson(bucket,key,value,{onlyIf:old?{etagMatches:old.etag}:{etagDoesNotMatch:'*'}});
  if(!lock)return {busy:true};
  try{return await run();}finally{const current=await jsonObject(bucket,key);if(current?.id===id)await bucket.delete(key);}
}
export async function publish(bundle,seed,bucket,now,sourceDigest){
  const generation=bundle.sourceVersion.replace(/[^a-zA-Z0-9.-]/g,'_')+'-'+sourceDigest.slice(0,12),paths={};
  const entries=Object.entries(bundle.files);
  for(let i=0;i<entries.length;i+=4)await Promise.all(entries.slice(i,i+4).map(async([path,data])=>{const key='versions/'+generation+'/'+path;await writeJson(bucket,key,data,{httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'public, max-age=31536000, immutable'}});paths['/'+path]='/'+key;}));
  const manifest={schemaVersion:1,version:'0.04.2',generation,source:'F1DB',sourceVersion:bundle.sourceVersion,sourceDigest,year:bundle.year,completedRounds:bundle.completedRounds,dataAt:bundle.dataAt||new Date(now).toISOString(),checkedAt:new Date(now).toISOString(),paths,events:bundle.events};
  // The pointer changes only after every versioned file is safely stored.
  await writeJson(bucket,CURRENT,manifest);return manifest;
}
export async function poll(env,{fetcher=fetch,now=Date.now(),force=false}={}){
  if(!env.RG_DATA)throw Error('R2 binding RG_DATA is not configured');
  const queued=await jsonObject(env.RG_DATA,STATE);if(!force&&queued?.nextCheckAt&&Date.parse(queued.nextCheckAt)>now)return {skipped:true,nextCheckAt:queued.nextCheckAt};
  return lease(env.RG_DATA,'private/import-lock.json',3*60000,now,async()=>{
    const seed=await jsonObject(env.RG_DATA,SEED);if(!seed)throw Error('Seed the updater before enabling the schedule');
    const state=await jsonObject(env.RG_DATA,STATE)||{},current=await jsonObject(env.RG_DATA,CURRENT),events=current?.events||seed.events;
    const policy=Model.retryPolicy(events,state,now,Number(env.RETRY_MINUTES)||2);if(!force&&!policy.due)return {skipped:true,nextCheckAt:state.nextCheckAt};
    state.checkedAt=new Date(now).toISOString();state.pending=policy.pending;state.nextCheckAt=policy.nextCheckAt;
    try{
      const h={Accept:'application/vnd.github+json','User-Agent':'RaceGraphs/0.04.2'};if(env.GITHUB_TOKEN)h.Authorization='Bearer '+env.GITHUB_TOKEN;if(state.etag&&!force)h['If-None-Match']=state.etag;
      const response=await fetcher('https://api.github.com/repos/f1db/f1db/releases/latest',{headers:h,signal:AbortSignal.timeout(20000)});
      if(response.status===304){state.error=null;state.lastSuccessfulCheckAt=state.checkedAt;await writeJson(env.RG_DATA,STATE,state);return {unchanged:true,pending:state.pending,nextCheckAt:state.nextCheckAt};}
      if(!response.ok)throw Error('Source release check failed ('+response.status+')');
      const release=await response.json();if(release.prerelease||release.draft||!/^v\d{4}\.\d{1,2}\.\d+$/.test(release.tag_name))throw Error('Source is not a stable F1DB release');
      if(Number(release.tag_name.slice(1,5))!==seed.year)throw Error('A new season needs a refreshed seed; existing data retained');
      const asset=release.assets?.find(a=>a.name==='f1db-json-splitted.tgz');if(!asset)throw Error('Source archive is not available yet');
      const fingerprint=release.tag_name+'|'+(asset.digest||asset.updated_at||'');
      const matchingSeedDigest=!current?.assetFingerprint&&asset.digest==='sha256:'+current?.sourceDigest;
      if(current?.sourceVersion===release.tag_name&&(current.assetFingerprint===fingerprint||matchingSeedDigest)){
        if(!current.assetFingerprint){current.assetFingerprint=fingerprint;current.sourcePublishedAt=release.published_at;await writeJson(env.RG_DATA,CURRENT,current);}
        state.etag=response.headers.get('etag');state.error=null;state.lastSuccessfulCheckAt=state.checkedAt;await writeJson(env.RG_DATA,STATE,state);return {unchanged:true,pending:state.pending,nextCheckAt:state.nextCheckAt};
      }
      const data=await fetcher(asset.browser_download_url,{headers:{'User-Agent':'RaceGraphs/0.04.2'},signal:AbortSignal.timeout(60000)});if(!data.ok)throw Error('Source archive download failed ('+data.status+')');
      const bytes=await data.arrayBuffer();if(bytes.byteLength>16*1024*1024)throw Error('Compressed source exceeds the import limit');
      const sha=await digest(bytes);if(asset.digest?.startsWith('sha256:')&&asset.digest.slice(7)!==sha)throw Error('Source archive checksum mismatch');
      const tables=await readArchive(bytes,seed.year),bundle=Model.makeBundle(tables,{...seed,minimumCompletedRounds:Math.max(seed.chart.completedRounds,current?.completedRounds||0)},release.tag_name,Date.parse(release.published_at)||now);
      if(bundle.completedRounds<Number(release.tag_name.split('.')[1]))throw Error('The source release does not contain its advertised completed round yet');
      const manifest=await publish(bundle,seed,env.RG_DATA,now,sha);manifest.assetFingerprint=fingerprint;manifest.sourcePublishedAt=release.published_at;await writeJson(env.RG_DATA,CURRENT,manifest);
      state.etag=response.headers.get('etag');state.error=null;state.lastSuccessfulCheckAt=state.checkedAt;state.lastPublishedAt=state.checkedAt;state.pending=Model.retryPolicy(bundle.events,{},now,Number(env.RETRY_MINUTES)||2).pending;await writeJson(env.RG_DATA,STATE,state);
      return {published:manifest.sourceVersion,completedRounds:manifest.completedRounds,pending:state.pending,nextCheckAt:state.nextCheckAt};
    }catch(error){state.error=error.message;state.nextCheckAt=new Date(now+(Number(env.RETRY_MINUTES)||2)*60000).toISOString();await writeJson(env.RG_DATA,STATE,state);return {retainedLastValid:true,error:error.message,nextCheckAt:state.nextCheckAt};}
  });
}
