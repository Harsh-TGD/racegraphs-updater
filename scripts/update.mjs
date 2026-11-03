import fs from 'node:fs/promises';
import {S3Bucket,parseConfig} from '../src/r2-s3.mjs';
import {checkSeed,runUpdate} from '../src/run-update.mjs';
const base=new URL('../',import.meta.url);
try{
  const config=parseConfig(process.env.RG_R2_CONFIG);
  for(const value of [config.accessKeyId,config.secretAccessKey])if(process.env.GITHUB_ACTIONS==='true')console.log('::add-mask::'+value);
  const [seedBytes,tableBytes,integrityText]=await Promise.all(['seed/seed.json','seed/source-tables.json','seed/integrity.json'].map(p=>fs.readFile(new URL(p,base),'utf8')));
  const integrity=JSON.parse(integrityText),{seed,tables}=checkSeed(seedBytes,tableBytes,integrity);
  const {result,manifest}=await runUpdate({bucket:new S3Bucket(config),seed,tables,seedHash:integrity['seed.json'],force:process.env.RG_FORCE==='true',githubToken:process.env.GITHUB_TOKEN||''});
  const receipt={sourceVersion:manifest.sourceVersion,completedRounds:manifest.completedRounds,checkedAt:manifest.checkedAt,nextCheckAt:manifest.nextCheckAt,updateError:manifest.updateError,action:result.published?'published':result.skipped?'not due yet':'checked',pendingResults:result.pending?.length||0};
  console.log(JSON.stringify(receipt));
  if(process.env.GITHUB_STEP_SUMMARY){const esc=s=>String(s??'Awaiting first successful source check').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'### RaceGraphs result updater\n\n'+Object.entries(receipt).map(([k,v])=>'- **'+k+'**: '+esc(v)).join('\n')+'\n');}
  if(result.retainedLastValid){console.error('Published data retained. '+String(result.error||'Source temporarily unavailable').slice(0,200));process.exitCode=1;}
}catch(error){console.error('Updater: '+String(error.message).slice(0,240));process.exitCode=1;}
