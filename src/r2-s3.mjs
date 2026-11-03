import {createHash,createHmac} from 'node:crypto';
const sha=data=>createHash('sha256').update(data).digest('hex');
const hmac=(key,data)=>createHmac('sha256',key).update(data).digest();
const uri=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function parseConfig(text){
  let c;try{c=JSON.parse(text||'');}catch{throw Error('Add the RACEGRAPHS_R2 repository secret using START-HERE.html.');}
  if(!c||typeof c!=='object')throw Error('RACEGRAPHS_R2 must contain the generated JSON configuration.');
  if(!/^[a-f0-9]{32}$/i.test(c.accountId||''))throw Error('Check the Cloudflare account ID in RACEGRAPHS_R2.');
  if(!/^[A-Za-z0-9]{16,128}$/.test(c.accessKeyId||'')||!/^[A-Za-z0-9/+_=-]{20,200}$/.test(c.secretAccessKey||''))throw Error('Use the R2 S3 Access Key ID and Secret Access Key in RACEGRAPHS_R2.');
  c.bucket=c.bucket||'racegraphs-data';if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket))throw Error('Check the R2 bucket name.');
  return {accountId:c.accountId,accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey,bucket:c.bucket};
}
export function sign(config,method,key,body='',extra={},now=new Date()){
  if(key.startsWith('/')||key.split('/').some(x=>x==='.'||x==='..')||/[\r\n]/.test(key))throw Error('Invalid storage object path');
  const host=config.accountId+'.r2.cloudflarestorage.com',pathname='/'+uri(config.bucket)+'/'+key.split('/').map(uri).join('/');
  const date=now.toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),scope=day+'/auto/s3/aws4_request';
  const headers={host,'x-amz-date':date,'x-amz-content-sha256':sha(body)};
  for(const[k,v]of Object.entries(extra))if(v!=null)headers[k.toLowerCase()]=String(v).trim().replace(/\s+/g,' ');
  const names=Object.keys(headers).sort(),signedHeaders=names.join(';');
  const canonical=[method,pathname,'',names.map(k=>k+':'+headers[k]+'\n').join(''),signedHeaders,sha(body)].join('\n');
  const stringToSign=['AWS4-HMAC-SHA256',date,scope,sha(canonical)].join('\n');
  const signingKey=hmac(hmac(hmac(hmac('AWS4'+config.secretAccessKey,day),'auto'),'s3'),'aws4_request');
  headers.Authorization='AWS4-HMAC-SHA256 Credential='+config.accessKeyId+'/'+scope+', SignedHeaders='+signedHeaders+', Signature='+hmac(signingKey,stringToSign).toString('hex');
  return {url:'https://'+host+pathname,headers};
}
export class S3Bucket{
  constructor(config,{fetcher=fetch,clock=()=>new Date(),pause=ms=>new Promise(r=>setTimeout(r,ms))}={}){this.config=config;this.fetcher=fetcher;this.clock=clock;this.pause=pause;}
  async request(method,key,body='',headers={}){
    for(let attempt=0;attempt<3;attempt++){
      const signed=sign(this.config,method,key,body,headers,this.clock());let response;
      try{response=await this.fetcher(signed.url,{method,headers:signed.headers,...(['PUT','POST'].includes(method)?{body}:{}),signal:AbortSignal.timeout(30000)});}
      catch{if(attempt<2){await this.pause(300*(attempt+1));continue;}throw Error('R2 connection failed. Check the account ID and retry the workflow.');}
      if([429,500,502,503,504].includes(response.status)&&attempt<2){await response.body?.cancel();await this.pause(300*(attempt+1));continue;}
      if(response.ok||response.status===404||response.status===412)return response;
      const status=response.status;await response.body?.cancel();throw Error('R2 '+method+' failed ('+status+'). Check bucket-scoped Object Read & Write credentials.');
    }
  }
  async get(key){const r=await this.request('GET',key);if(r.status===404)return null;if(r.status===412)throw Error('Unexpected R2 read conflict');const body=await r.text(),httpEtag=r.headers.get('etag')||'';return {body,httpEtag,etag:httpEtag.replace(/^"|"$/g,''),json:async()=>JSON.parse(body)};}
  async put(key,body,options={}){
    const headers={'content-type':options.httpMetadata?.contentType||'application/json; charset=utf-8','cache-control':options.httpMetadata?.cacheControl||'no-store'};
    if(options.onlyIf?.etagMatches)headers['if-match']='"'+options.onlyIf.etagMatches.replace(/^"|"$/g,'')+'"';
    if(options.onlyIf?.etagDoesNotMatch)headers['if-none-match']=options.onlyIf.etagDoesNotMatch;
    const r=await this.request('PUT',key,body,headers);if(r.status===412)return null;if(!r.ok)throw Error('R2 bucket not found');const etag=(r.headers.get('etag')||'').replace(/^"|"$/g,'');await r.body?.cancel();return {etag};
  }
  async delete(key){const r=await this.request('DELETE',key);await r.body?.cancel();}
}
