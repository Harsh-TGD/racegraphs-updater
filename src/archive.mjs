/* Stream a split F1DB tar.gz, retaining only current-season records. */
export const WANTED=new Set(['races','drivers','constructors','races-race-results','races-sprint-race-results','races-driver-standings','races-constructor-standings','races-qualifying-results','races-sprint-qualifying-results','races-starting-grid-positions']);
export async function readArchive(bytes,year){
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),reader=stream.getReader();let tail=new Uint8Array(0),done=false;
  async function take(n,retain=true){
    const pieces=[];let left=n;
    while(left){if(!tail.length){const r=await reader.read();done=r.done;if(done)throw Error('Truncated source archive');tail=r.value;}
      const length=Math.min(left,tail.length);if(retain)pieces.push(tail.subarray(0,length));tail=tail.subarray(length);left-=length;
    }
    if(!retain)return null;const out=new Uint8Array(n);let at=0;for(const p of pieces){out.set(p,at);at+=p.length;}return out;
  }
  const decoder=new TextDecoder(),tables={};
  async function arrayRows(size){
    // Do not decode and JSON.parse a complete all-time result table at once:
    // that can exceed a Worker's 128 MB isolate. Parse one object at a time.
    const textDecoder=new TextDecoder(),rows=[];let object='',depth=0,quoted=false,escaped=false,opened=false,closed=false,left=size;
    while(left){const n=Math.min(32768,left),chunk=textDecoder.decode(await take(n),{stream:left>n});left-=n;
      for(const c of chunk){
        if(depth===0){if(closed){if(/\s/.test(c))continue;throw Error('Trailing data after source array');}if(!opened){if(c==='['){opened=true;continue;}if(/\s/.test(c))continue;throw Error('Invalid source array');}
          if(c==='{'){object='{';depth=1;continue;}if(c===']'){closed=true;continue;}if(c===','||/\s/.test(c))continue;throw Error('Unexpected source array value');}
        object+=c;if(object.length>2*1024*1024)throw Error('Source row exceeds the import limit');
        if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
        if(c==='"'){quoted=true;continue;}if(c==='{'||c==='[')depth++;if(c==='}'||c===']')depth--;
        if(depth===0){const row=JSON.parse(object);if(row.year==null||row.year===year)rows.push(row);object='';}
      }
    }
    if(depth||quoted||!opened||!closed)throw Error('Truncated source array');return rows;
  }
  try{for(let files=0;files<1000;files++){
    const h=await take(512);if(h.every(x=>x===0))break;
    const name=decoder.decode(h.subarray(0,100)).split('\0')[0].split('/').at(-1),size=parseInt(decoder.decode(h.subarray(124,136)).replace(/\0/g,'').trim(),8)||0;
    if(size>64*1024*1024)throw Error('Source member exceeds import limit');
    const key=name.startsWith('f1db-')&&name.endsWith('.json')?name.slice(5,-5):null;
    if(WANTED.has(key))tables[key]=await arrayRows(size);else await take(size,false);
    if(size%512)await take(512-size%512,false);
  }}finally{await reader.cancel().catch(()=>{});}
  for(const key of WANTED)if(!tables[key])throw Error('Source archive omitted '+key);
  return tables;
}
export async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
