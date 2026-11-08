/* Runs in GitHub Actions Node, never inside the Free Worker. */
import Model from './race-model.cjs';
import {readArchive,digest} from './archive.mjs';
const CURRENT='public/manifest.json',STATE='private/poll-state.json',SEED='private/seed.json';
const encode=d=>JSON.stringify(d);
const F1DB_REPO='https://api.github.com/repos/f1db/f1db';
const practiceWindow=(event,now)=>{
  const hours=(Date.parse(event.startUtc)-now)/3600000;
  return !event.cancelled&&hours>=-24&&hours<=72;
};
const yamlValue=value=>{
  const text=value.trim();
  if(!text||text==='null'||text==='~')return null;
  if(text.startsWith('"'))return JSON.parse(text);
  if(text.startsWith("'")&&text.endsWith("'"))return text.slice(1,-1).replaceAll("''","'");
  return text;
};
const fields=text=>Object.fromEntries([...text.matchAll(/^([a-zA-Z]\w*):[ \t]*([^\r\n]*)/gm)]
  .map(([,key,value])=>[key,yamlValue(value)]));
const validId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(value);

export function practiceSchedule(race){
  const sessions=[];
  for(const number of [1,2,3]){
    const date=race['freePractice'+number+'Date'];
    const time=race['freePractice'+number+'Time'];
    if(!date||!time)continue;
    const utc=date+'T'+time+':00Z';
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(utc)||
      !Number.isFinite(Date.parse(utc))||new Date(utc).toISOString().slice(0,16)!==utc.slice(0,16)){
      throw Error('Invalid F1DB practice start time');
    }
    sessions.push({number,startUtc:utc});
  }
  return sessions;
}

export function practiceRows(text){
  // The F1DB practice source is a sequence of flat scalar records.
  if(text.length>64000)throw Error('F1DB practice source exceeds its expected size');
  const source=[];
  let row;
  for(const line of text.split(/\r?\n/)){
    if(!line.trim()||line.trimStart().startsWith('#'))continue;
    if(line.startsWith('- ')){row={};source.push(row);}
    const field=/^(?:- |  )([a-zA-Z]\w*):[ \t]*(.*)$/.exec(line);
    if(!row||!field||Object.hasOwn(row,field[1]))throw Error('Unrecognized F1DB practice row');
    row[field[1]]=yamlValue(field[2]);
  }
  const rows=source.map(row=>{
    const position=/^[1-9]\d?$/.test(row.position)?Number(row.position):null;
    const laps=row.laps==null?null:Number(row.laps);
    if(!validId(row.driverId)||!validId(row.constructorId)||
      position==null&&!/^[A-Z]{1,8}$/.test(row.position||'')||
      laps!=null&&(!Number.isInteger(laps)||laps<0)){
      throw Error('Invalid F1DB practice result');
    }
    return {driverId:row.driverId,constructorId:row.constructorId,position,status:row.position,time:row.time??null,gap:row.gap??null,laps};
  });
  const classified=rows.filter(row=>row.position!=null).map(row=>row.position);
  if(rows.length<10||rows.length>60||new Set(rows.map(row=>row.driverId)).size!==rows.length||
    new Set(classified).size!==classified.length||classified.length&&!classified.includes(1)){
    throw Error('Incomplete or duplicate F1DB practice classification');
  }
  return rows;
}

async function refreshPractice(bucket,seed,current,event,fetcher,now,headers){
  const round=seed.chart.calendar.find(race=>race.raceId===event.id);
  if(!round||!validId(round.grandPrixId))return current.events;
  const head=await fetcher(F1DB_REPO+'/git/ref/heads/main',{headers,signal:AbortSignal.timeout(8000)});
  if(!head.ok)throw Error('F1DB practice revision check failed ('+head.status+')');
  const revision=(await head.json()).object?.sha;
  if(!/^[a-f0-9]{40}$/.test(revision))throw Error('Invalid F1DB practice revision');
  const folder='src/data/seasons/'+seed.year+'/races/'+String(event.round).padStart(2,'0')+'-'+round.grandPrixId;
  const raw='https://raw.githubusercontent.com/f1db/f1db/'+revision+'/'+folder+'/';
  const load=async file=>{
    const response=await fetcher(raw+file,{signal:AbortSignal.timeout(8000)});
    if(response.status===404)return null;
    if(!response.ok)throw Error('F1DB practice source read failed ('+response.status+')');
    return response.text();
  };
  const schedule=await load('race.yml');
  if(schedule==null)return current.events;
  const race=fields(schedule);
  if(Number(race.id)!==event.id||Number(race.round)!==event.round||race.grandPrixId!==round.grandPrixId){
    throw Error('F1DB practice source race identity mismatch');
  }
  const pendingWrites=[];
  const practice=await Promise.all(practiceSchedule(race).map(async session=>{
    const previous=event.practice?.find(item=>item.number===session.number);
    const existing={...previous,...session,hasResults:Boolean(previous?.hasResults)};
    if(Date.parse(session.startUtc)>now)return existing;
    const file='free-practice-'+session.number+'-results.yml';
    const source=await load(file);
    if(source==null)return existing;
    const rows=practiceRows(source);
    const data={schemaVersion:1,eventId:event.id,number:session.number,rows,
      source:'F1DB',sourceUrl:'https://github.com/f1db/f1db/blob/main/'+folder+'/'+file};
    const checksum=await digest(new TextEncoder().encode(encode(data)));
    const resultsPath='/versions/practice-'+checksum+'/data/race-day/practice/'+event.id+'-'+session.number+'.json';
    if(resultsPath!==previous?.resultsPath)pendingWrites.push([resultsPath,data]);
    return {...session,hasResults:true,resultsPath};
  }));
  if(encode(event.practice)===encode(practice))return current.events;
  await Promise.all(pendingWrites.map(([path,data])=>writeJson(bucket,path.slice(1),data,{
    httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'public, max-age=31536000, immutable'}
  })));
  return current.events.map(item=>item.id===event.id?{...item,practice}:item);
}

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
    const practiceEvent=events.find(event=>practiceWindow(event,now));
    const retryMinutes=Number(env.RETRY_MINUTES)||2;
    state.checkedAt=new Date(now).toISOString();
    state.pending=policy.pending;
    state.nextCheckAt=practiceEvent?new Date(now+retryMinutes*60000).toISOString():policy.nextCheckAt;
    const headers={Accept:'application/vnd.github+json','User-Agent':'RaceGraphs/0.04.4'};
    if(env.GITHUB_TOKEN)headers.Authorization='Bearer '+env.GITHUB_TOKEN;
    if(current&&practiceEvent){
      try{
        const eventsWithPractice=await refreshPractice(env.RG_DATA,seed,current,practiceEvent,fetcher,now,headers);
        if(eventsWithPractice!==current.events){
          const updated={...current,events:eventsWithPractice};
          await writeJson(env.RG_DATA,CURRENT,updated);
          current.events=eventsWithPractice;
        }
      }catch(error){
        // Practice is an independent source. Keep its last valid results and continue the race import.
        console.warn('Practice update retained: '+error.message);
      }
    }
    try{
      const releaseHeaders={...headers};
      if(state.etag&&!force)releaseHeaders['If-None-Match']=state.etag;
      const response=await fetcher(F1DB_REPO+'/releases/latest',{headers:releaseHeaders,signal:AbortSignal.timeout(20000)});
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
      const sessions=new Map(current?.events.map(event=>[event.id,event.practice])||[]);
      bundle.events=bundle.events.map(event=>sessions.has(event.id)&&sessions.get(event.id)
        ?{...event,practice:sessions.get(event.id)}:event);
      bundle.files['data/race-day/calendar.json'].events=bundle.events;
      const manifest=await publish(bundle,seed,env.RG_DATA,now,sha);manifest.assetFingerprint=fingerprint;manifest.sourcePublishedAt=release.published_at;await writeJson(env.RG_DATA,CURRENT,manifest);
      state.etag=response.headers.get('etag');state.error=null;state.lastSuccessfulCheckAt=state.checkedAt;state.lastPublishedAt=state.checkedAt;state.pending=Model.retryPolicy(bundle.events,{},now,Number(env.RETRY_MINUTES)||2).pending;await writeJson(env.RG_DATA,STATE,state);
      return {published:manifest.sourceVersion,completedRounds:manifest.completedRounds,pending:state.pending,nextCheckAt:state.nextCheckAt};
    }catch(error){state.error=error.message;state.nextCheckAt=new Date(now+(Number(env.RETRY_MINUTES)||2)*60000).toISOString();await writeJson(env.RG_DATA,STATE,state);return {retainedLastValid:true,error:error.message,nextCheckAt:state.nextCheckAt};}
  });
        }
