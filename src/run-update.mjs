import {createHash} from 'node:crypto';
import Model from './race-model.cjs';
import {poll,publish,jsonObject,writeJson} from './source-updater.mjs';
export function checkSeed(seedBytes,tableBytes,integrity){
  for(const[name,bytes]of [['seed.json',seedBytes],['source-tables.json',tableBytes]])if(createHash('sha256').update(bytes).digest('hex')!==integrity[name])throw Error('Included seed integrity check failed; restore the supplied seed files.');
  const seed=JSON.parse(seedBytes),tables=JSON.parse(tableBytes);Model.validateTables(tables,seed.year,seed.chart.completedRounds);return {seed,tables};
}
export async function refreshPublic(bucket){
  for(let attempt=0;attempt<2;attempt++){
    const object=await bucket.get('public/manifest.json');if(!object)throw Error('The initial snapshot is not published yet');
    const current=await object.json(),state=await jsonObject(bucket,'private/poll-state.json');
    const manifest={...current,checkedAt:state?.lastSuccessfulCheckAt||current.checkedAt||null,lastAttemptAt:state?.checkedAt||null,nextCheckAt:state?.nextCheckAt||null,updateError:Boolean(state?.error),updater:'github-actions-free'};
    const written=await writeJson(bucket,'public/manifest.json',manifest,{onlyIf:{etagMatches:object.etag}});if(!written)continue;
    await writeJson(bucket,'public/status.json',{schemaVersion:1,events:manifest.events,sourceVersion:manifest.sourceVersion,sourceDataAt:manifest.dataAt,checkedAt:manifest.checkedAt,lastAttemptAt:manifest.lastAttemptAt,nextCheckAt:manifest.nextCheckAt,updateError:manifest.updateError,raceStatus:null,updater:'github-actions-free'});
    return manifest;
  }
  throw Error('Another publisher changed the manifest; retry the workflow.');
}
export async function runUpdate({bucket,seed,tables,seedHash,fetcher=fetch,now=Date.now(),force=false,githubToken=''}){
  const stored=await jsonObject(bucket,'private/seed-integrity.json');
  if(stored&&stored.sha256!==seedHash)throw Error('The bucket belongs to a different seed. Review before replacing its data.');
  if(!stored){await writeJson(bucket,'private/seed.json',seed);await writeJson(bucket,'private/seed-integrity.json',{sha256:seedHash,year:seed.year});}
  if(!await bucket.get('public/manifest.json')){
    const bundle=Model.makeBundle(tables,seed,seed.sourceVersion,Date.parse(seed.sourceDataAt));
    const manifest=await publish(bundle,seed,bucket,Date.parse(seed.sourceDataAt),seed.sourceDigest);
    manifest.checkedAt=null;await writeJson(bucket,'public/manifest.json',manifest);
  }
  const result=await poll({RG_DATA:bucket,RETRY_MINUTES:'5',GITHUB_TOKEN:githubToken},{fetcher,now,force});
  const manifest=await refreshPublic(bucket);
  return {result,manifest};
}
