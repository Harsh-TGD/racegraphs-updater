/* RaceGraphs race-day calculations. Shared by the browser and scheduled updater. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.RGRaceModel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x));
  const num=x=>typeof x==='number'&&Number.isFinite(x);
  const sum=xs=>Math.round(xs.reduce((a,b)=>a+(Number(b)||0),0)*1000)/1000;
  const by=(rows,key)=>Object.fromEntries(rows.map(r=>[r[key],r]));
  const entry=r=>r.constructorId+'~'+r.engineManufacturerId;
  const iso=x=>new Date(x).toISOString();
  const normalize=x=>String(x||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  function zone(value){try{new Intl.DateTimeFormat('en',{timeZone:value}).format(0);return value;}catch(_){return 'UTC';}}
  function localTime(start,timeZone,locale='en-CA'){
    if(!start||!Number.isFinite(Date.parse(start)))return {date:'Schedule to be confirmed',time:'',zone:zone(timeZone)};
    const z=zone(timeZone),d=new Date(start);
    return {date:new Intl.DateTimeFormat(locale,{timeZone:z,weekday:'short',month:'short',day:'numeric',year:'numeric'}).format(d),time:new Intl.DateTimeFormat(locale,{timeZone:z,hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(d),zone:z};
  }
  function countdown(start,now=Date.now()){
    const ms=Date.parse(start)-now;if(!Number.isFinite(ms))return {valid:false,text:'Start time to be confirmed',remaining:null};
    if(ms<=0)return {valid:true,text:'Awaiting race start',remaining:0};
    const secs=Math.ceil(ms/1000),days=Math.floor(secs/86400),hours=Math.floor(secs%86400/3600),minutes=Math.floor(secs%3600/60),seconds=secs%60;
    return {valid:true,remaining:ms,days,hours,minutes,seconds,text:(days?days+'d ':'')+String(hours).padStart(2,'0')+'h '+String(minutes).padStart(2,'0')+'m '+String(seconds).padStart(2,'0')+'s'};
  }
  function chooseEvent(events,now=Date.now(),selected=null){
    if(selected!=null){const requested=events.find(e=>String(e.id)===String(selected)||String(e.round)===String(selected));if(requested)return requested;}
    const ordered=[...events].filter(e=>Number.isFinite(Date.parse(e.startUtc))).sort((a,b)=>Date.parse(a.startUtc)-Date.parse(b.startUtc));
    const active=ordered.find(e=>!e.completed&&Date.parse(e.startUtc)<=now&&now-Date.parse(e.startUtc)<8*3600000);
    if(active)return active;
    const justFinished=ordered.filter(e=>e.completed&&Date.parse(e.startUtc)<=now&&now-Date.parse(e.startUtc)<8*3600000).at(-1);
    return justFinished||ordered.find(e=>Date.parse(e.startUtc)>now)||ordered.at(-1)||events.at(-1)||null;
  }
  function phase(event,live,now=Date.now()){
    if(!event)return 'unavailable';if(event.cancelled)return 'cancelled';if(event.completed)return 'completed';
    if(live&&String(live.eventId)===String(event.id)){
      if(live.phase==='completed'||live.phase==='provisional')return live.phase;
      if(live.phase==='live'&&now-Date.parse(live.checkedAt||live.dataAt||0)<180000)return 'live';
      if(live.phase==='awaiting_results')return 'awaiting_results';
    }
    if(!event.startUtc)return 'scheduled';
    return Date.parse(event.startUtc)>now?'countdown':'awaiting';
  }
  function retryPolicy(events,state,now,minutes=2){
    const waiting=events.filter(e=>!e.completed&&e.startUtc&&Date.parse(e.startUtc)<=now);
    const near=events.some(e=>e.startUtc&&Math.abs(Date.parse(e.startUtc)-now)<8*3600000);
    const interval=waiting.length||near?Math.max(1,minutes)*60000:30*60000;
    return {pending:waiting.map(e=>e.id),due:!state?.nextCheckAt||Date.parse(state.nextCheckAt)<=now,nextCheckAt:iso(now+interval),intervalMs:interval};
  }
  function identity(catalog,constructorId,year,round){return catalog.identities.find(i=>i.constructorId===constructorId&&(i.fromYear*100+(i.fromRound||1))<=year*100+round&&((i.toYear||9999)*100+(i.toRound||99))>=year*100+round)?.id||null;}
  function validateTables(t,year,previousRounds=0){
    for(const k of ['races','drivers','constructors','races-race-results','races-driver-standings','races-constructor-standings'])if(!Array.isArray(t[k]))throw Error('Missing source table: '+k);
    const races=t.races.filter(r=>r.year===year),ds=new Set(t.drivers.map(d=>d.id)),cs=new Set(t.constructors.map(c=>c.id));
    if(!races.length||new Set(races.map(r=>r.id)).size!==races.length)throw Error('Invalid race calendar');
    const complete=[];
    for(const race of races){
      const rr=t['races-race-results'].filter(r=>r.raceId===race.id);if(!rr.length)continue;
      if(rr.length<10||new Set(rr.map(r=>r.driverId)).size!==rr.length||rr.filter(r=>r.positionNumber===1).length!==1)throw Error('Incomplete or duplicate race classification for R'+race.round);
      for(const row of rr)if(!ds.has(row.driverId)||!cs.has(row.constructorId)||row.points!=null&&(!num(row.points)||row.points<0))throw Error('Invalid result identity or points');
      for(const key of ['races-driver-standings','races-constructor-standings']){
        const rows=t[key].filter(r=>r.raceId===race.id),ids=rows.map(r=>key.includes('driver')?r.driverId:entry(r));
        if(rows.length<(key.includes('driver')?10:5)||new Set(ids).size!==rows.length||!rows.some(r=>r.positionNumber===1)||rows.some(r=>!num(r.points)||r.points<0))throw Error('Incomplete championship snapshot for R'+race.round);
      }
      complete.push(race);
    }
    complete.sort((a,b)=>a.round-b.round);
    if(complete.length<previousRounds)throw Error('Source would remove published rounds');
    if(complete.some((r,i)=>r.round!==i+1))throw Error('Source contains a missing completed round');
    return complete;
  }
  function makeBundle(t,seed,sourceVersion,now=Date.now()){
    const year=seed.year,complete=validateTables(t,year,seed.minimumCompletedRounds||seed.chart.completedRounds),chart=copy(seed.chart),catalog=copy(seed.catalog),ds=by(t.drivers,'id'),cs=by(t.constructors,'id');
    const rr=t['races-race-results'].filter(r=>r.year===year),sr=(t['races-sprint-race-results']||[]).filter(r=>r.year===year),qr=(t['races-qualifying-results']||[]).filter(r=>r.year===year),sqr=(t['races-sprint-qualifying-results']||[]).filter(r=>r.year===year),all=[...rr.map(r=>({...r,session:'race'})),...sr.map(r=>({...r,session:'sprint'}))];
    const races=t.races.filter(r=>r.year===year).sort((a,b)=>a.round-b.round),completed=new Set(complete.map(r=>r.id)),dr=t['races-driver-standings'].filter(r=>r.year===year),cr=t['races-constructor-standings'].filter(r=>r.year===year),at=(rows,id)=>rows.filter(r=>r.raceId===id).sort((a,b)=>a.positionDisplayOrder-b.positionDisplayOrder);
    const priorRounds=seed.chart.completedRounds;chart.completedRounds=complete.length;chart.scheduledRounds=races.length;chart.sourceVersion=sourceVersion;chart.asOf=iso(now).slice(0,10);chart.version='0.04.2';chart.driverSeries={};chart.constructorSeries={};chart.resultStrips={};
    chart.calendar=races.map(r=>{const prior=chart.calendar.find(c=>c.raceId===r.id)||{};return {...prior,raceId:r.id,round:r.round,date:r.round===21&&year===2026?'2026-11-21':r.date,sourceDate:r.date,completed:completed.has(r.id)};});
    for(const row of dr)if(!chart.drivers[row.driverId])chart.drivers[row.driverId]={id:row.driverId,name:ds[row.driverId]?.name||row.driverId,code:ds[row.driverId]?.abbreviation||''};
    for(const row of cr)if(!chart.constructorEntries[entry(row)])chart.constructorEntries[entry(row)]={id:entry(row),constructorId:row.constructorId,engineManufacturerId:row.engineManufacturerId,name:cs[row.constructorId]?.name||row.constructorId,shortName:cs[row.constructorId]?.name||row.constructorId};
    for(const race of complete){
      const drivers=at(dr,race.id),constructors=at(cr,race.id),leader=Math.max(...drivers.map(r=>r.points)),teamLeader=Math.max(...constructors.map(r=>r.points));
      for(const row of drivers){const id=row.driverId,prev=chart.driverSeries[id]?.at(-1),awards=all.filter(r=>r.driverId===id&&r.round<=race.round),scored=sum(awards.map(r=>r.points));
        const hasPrevious=prev?.[0]===race.round-1&&prev?.[9]==='published';const record={round:race.round,points_counted:row.points,position:row.positionNumber,points_scored_to_date:scored,points_scored_this_round:sum(awards.filter(r=>r.round===race.round).map(r=>r.points)),recomputed_counted:scored,gap_to_leader:row.points-leader,position_change:hasPrevious&&prev[2]!=null&&row.positionNumber!=null?prev[2]-row.positionNumber:null,counted_points_change:hasPrevious?row.points-prev[1]:null,points_record_kind:'published',position_text:row.positionText,display_order:row.positionDisplayOrder};
        (chart.driverSeries[id]??=[]).push(chart.driverColumns.map(k=>record[k]??null));
      }
      for(const id of new Set(all.filter(r=>r.round<=race.round).map(r=>r.driverId))){if(drivers.some(r=>r.driverId===id))continue;const awards=all.filter(r=>r.driverId===id&&r.round<=race.round),scored=sum(awards.map(r=>r.points)),zero=!dr.some(r=>r.driverId===id)&&all.filter(r=>r.driverId===id).every(r=>!r.points),record={round:race.round,points_counted:zero?0:null,position:null,points_scored_to_date:scored,points_scored_this_round:sum(awards.filter(r=>r.round===race.round).map(r=>r.points)),recomputed_counted:scored,gap_to_leader:zero?-leader:null,position_change:null,counted_points_change:null,points_record_kind:zero?'derived_zero':'unavailable',position_text:null,display_order:null};(chart.driverSeries[id]??=[]).push(chart.driverColumns.map(k=>record[k]??null));}
      for(const row of constructors){const id=entry(row),prev=chart.constructorSeries[id]?.at(-1),scored=sum(all.filter(r=>entry(r)===id&&r.round<=race.round).map(r=>r.points));const record={round:race.round,points_counted:row.points,position:row.positionNumber,gap_to_leader:row.points-teamLeader,points_change:row.points-(prev?.[1]||0),position_change:prev&&prev[2]!=null&&row.positionNumber!=null?prev[2]-row.positionNumber:null,reconstructed_points_scored_to_date:scored,reconstructed_counted:scored,official_minus_reconstructed:row.points-scored,position_text:row.positionText,display_order:row.positionDisplayOrder};(chart.constructorSeries[id]??=[]).push(chart.constructorColumns.map(k=>record[k]??null));}
    }
    const notStarted=new Set(['DNS','DNQ','DNPQ','DNP','EX']);
    const analysis=copy(seed.analysis);analysis.races=races.map(r=>({id:r.id,year,round:r.round,name:chart.calendar.find(c=>c.raceId===r.id)?.name||r.officialName,date:chart.calendar.find(c=>c.raceId===r.id)?.date||r.date,circuitId:r.circuitId,format:r.qualifyingFormat,sprint:Boolean(r.sprintRaceDate),completed:completed.has(r.id)}));
    const compact=[];
    for(const r of all){const q=(r.session==='race'?qr:sqr).find(q=>q.raceId===r.raceId&&q.driverId===r.driverId),i=identity(catalog,r.constructorId,year,r.round),e=entry(r),started=r.sharedCar||r.positionText==='DSQ'&&!(r.laps>0)?null:!notStarted.has(r.positionText),finished=started==null?null:started&&!r.reasonRetired&&r.positionNumber!=null,record={year,raceId:r.raceId,round:r.round,session:r.session,driverId:r.driverId,entryId:e,identityId:i,entrantId:seed.entrantIds?.[r.driverId+'|'+r.constructorId]||null,order:r.positionDisplayOrder,position:r.positionNumber,status:r.positionText,points:r.points,started,finished,shared:Boolean(r.sharedCar),multiple:false,qualPos:q?.positionNumber??null,grid:r.gridPositionNumber,pole:Boolean(r.polePosition),retired:r.reasonRetired,circuitId:races.find(x=>x.id===r.raceId)?.circuitId};compact.push(analysis.resultColumns.map(k=>record[k]??null));
      const strip={round:r.round,session:r.session,position:r.positionNumber,status:r.positionText,qualifying_position:q?.positionNumber,grid_position:r.gridPositionNumber,official_pole:Boolean(r.polePosition),points_awarded:r.points,team_identity_id:i,constructor_entry_id:e};(chart.resultStrips[r.driverId]??=[]).push(chart.resultStripColumns.map(k=>strip[k]??null));
    }
    analysis.results=compact;analysis.qualifying=qr.map(q=>{const r={raceId:q.raceId,driverId:q.driverId,position:q.positionNumber,time:q.timeMillis,q1:q.q1Millis,q2:q.q2Millis,q3:q.q3Millis,constructorId:q.constructorId,entrantId:seed.entrantIds?.[q.driverId+'|'+q.constructorId]||null};return analysis.qualifyingColumns.map(k=>r[k]??null);});
    const last=complete.at(-1),final=(rows,kind)=>at(rows,last.id).map(r=>({id:kind==='drivers'?r.driverId:entry(r),position:r.positionNumber,positionText:r.positionText,displayOrder:r.positionDisplayOrder,points:r.points,championshipWon:Boolean(r.championshipWon),source:'F1DB'}));chart.finalStandings={drivers:final(dr,'drivers'),constructors:final(cr,'constructors')};analysis.final=chart.finalStandings;
    catalog.sourceVersion=sourceVersion;catalog.version='0.04.2';catalog.cutoff={year,round:last.round,date:last.date};catalog.counts.completedRaces=seed.catalog.counts.completedRaces+complete.length-priorRounds;
    for(const d of catalog.drivers){const raw=ds[d.id];if(raw){d.starts=raw.totalRaceStarts;d.wins=raw.totalRaceWins;}}
    for(const c of catalog.teams)if(cs[c.id])c.wins=cs[c.id].totalRaceWins;
    const files={['data/charts/'+year+'.json']:chart,['data/analysis/'+year+'.json']:analysis,'data/catalog.json':catalog};
    if(seed.peopleDirectory)files['data/directories/people.json']=seed.peopleDirectory.map(row=>{if(!row.url.startsWith('/drivers/'))return row;const id=row.url.split('/')[2],driver=ds[id];return driver?{...row,note:driver.totalRaceStarts+' F1 starts · '+driver.totalRaceWins+' F1 wins'+(row.series.length>1?' · endurance record connected':'')}:row;});
    const baseScenario=copy(seed.scenario);baseScenario.throughRound=last.round;baseScenario.baseline={drivers:Object.fromEntries(chart.finalStandings.drivers.map(d=>[d.id,d.points])),constructors:Object.fromEntries(chart.finalStandings.constructors.map(d=>[d.id,d.points]))};baseScenario.remainingCalendar=(baseScenario.remainingCalendar||[]).filter(r=>r.round>last.round);files['data/scenario-baseline.json']=baseScenario;
    for(const [id,base]of Object.entries(seed.driverProfiles||{})){
      const p=copy(base),rows=rr.filter(r=>r.driverId===id),sprints=sr.filter(r=>r.driverId===id),standing=chart.finalStandings.drivers.find(r=>r.id===id);if(ds[id])p.driver=copy(ds[id]);
      if(rows.length){const old=p.seasons.find(s=>s.year===year)||{},starts=rows.filter(r=>!notStarted.has(r.positionText)),wins=rows.filter(r=>r.positionNumber===1).length,podiums=rows.filter(r=>r.positionNumber>=1&&r.positionNumber<=3).length,s={...old,year,driver_id:id,entries:rows.length,confirmed_starts:starts.length,wins,podiums,official_poles:rows.filter(r=>r.polePosition).length,points_scored:sum(rows.map(r=>r.points)),championship_points:standing?.points??null,championship_position:standing?.position??null,championship_status:standing?.positionText??null,constructor_ids:[...new Set(rows.map(r=>r.constructorId))],win_rate_per_confirmed_start:starts.length?wins/starts.length:null};p.seasons=p.seasons.filter(s=>s.year!==year).concat(s).sort((a,b)=>a.year-b.year);p.results=p.results.filter(r=>r[0]!==year).concat(compact.filter(r=>r[4]===id));
        const finished=rows.filter(r=>r.positionNumber!=null&&!r.reasonRetired);s.finished=finished.length;s.retirements_recorded=rows.filter(r=>r.reasonRetired||r.positionText==='DNF').length;s.status_counts={};for(const r of rows){const k=/^\d+$/.test(r.positionText)?'classified':r.positionText;s.status_counts[k]=(s.status_counts[k]||0)+1;}s.best_classified_finish=Math.min(...rows.filter(r=>r.positionNumber!=null).map(r=>r.positionNumber));if(!Number.isFinite(s.best_classified_finish))s.best_classified_finish=null;s.finish_sample=finished.length;s.mean_finishing_position_both_finish_definition=finished.length?sum(finished.map(r=>r.positionNumber))/finished.length:null;p.currentChampionship=standing;
        const stints={};for(const r of rows){const i=identity(catalog,r.constructorId,year,r.round),en=seed.entrantIds?.[id+'|'+r.constructorId]||null,k=i+'|'+en;const stint=stints[k]??={id:year+':'+id+':'+i+':'+entry(r)+':'+(en||'unknown'),year,driver_id:id,team_identity_id:i,constructor_entry_id:entry(r),entrant_id:en,rounds:[],race_ids:[],scope:'observed_result_entries'};stint.rounds.push(r.round);stint.race_ids.push(r.raceId);stint.from_round=Math.min(...stint.rounds);stint.to_round=Math.max(...stint.rounds);}p.stints=p.stints.filter(s=>s.year!==year).concat(Object.values(stints));
      }
      files['data/drivers/'+id+'.json']=p;
    }
    for(const [id,base]of Object.entries(seed.teamProfiles||{})){const p=copy(base),rows=rr.filter(r=>r.constructorId===id),stand=chart.finalStandings.constructors.filter(r=>r.id.split('~')[0]===id);p.constructor=copy(cs[id]||p.constructor);p.officialSeasonClassifications=p.officialSeasonClassifications.filter(r=>r.year!==year).concat(stand.map(r=>({year,championship:'constructors',competitor_id:r.id,position:r.position,position_text:r.positionText,display_order:r.displayOrder,points:r.points,championship_won:r.championshipWon,phase:'current',source:'F1DB'})));p.performance=(p.performance||[]).filter(r=>r.year!==year).concat({year,starts:new Set(rows.filter(r=>!notStarted.has(r.positionText)).map(r=>r.raceId)).size,wins:new Set(rows.filter(r=>r.positionNumber===1).map(r=>r.raceId)).size,podiums:rows.filter(r=>r.positionNumber>=1&&r.positionNumber<=3).length});files['data/teams/'+id+'.json']=p;}
    const events=races.map(r=>({...(seed.events.find(e=>e.id===r.id)||{}),id:r.id,round:r.round,year,startUtc:r.date&&r.time?r.date+'T'+r.time+':00Z':null,completed:completed.has(r.id),circuitId:r.circuitId,scheduledLaps:r.scheduledLaps||r.laps}));
    for(const race of races){
      const convert=r=>({id:r.driverId,name:ds[r.driverId]?.name||r.driverId,number:r.driverNumber,constructorId:r.constructorId,team:cs[r.constructorId]?.name||r.constructorId,position:r.positionNumber,status:r.positionText,points:r.points??null,dnf:r.positionText==='DNF',dns:r.positionText==='DNS',dsq:r.positionText==='DSQ',gap:r.gap??null,laps:r.laps??null,qualifying:qr.find(q=>q.raceId===r.raceId&&q.driverId===r.driverId)?.positionNumber??null,grid:r.gridPositionNumber??r.gridPositionText??null,time:r.time||r.gap||r.reasonRetired||r.positionText,pole:Boolean(r.polePosition)});
      const grid=(t['races-starting-grid-positions']||[]).filter(r=>r.raceId===race.id).sort((a,b)=>a.positionDisplayOrder-b.positionDisplayOrder).map(convert);
      files['data/race-day/races/'+race.id+'.json']={eventId:race.id,source:'F1DB',sourceVersion,dataAt:iso(now),results:at(rr,race.id).map(convert),grid};
      files['data/races/'+year+'-'+race.round+'.json']={race:{id:race.id,year,round:race.round,date:chart.calendar.find(c=>c.raceId===race.id)?.date,source_date:race.date,date_source:'F1DB',name:chart.calendar.find(c=>c.raceId===race.id)?.name,official_name:race.officialName,grand_prix_id:race.grandPrixId,circuit_id:race.circuitId,circuit_layout_id:race.circuitLayoutId,completed:completed.has(race.id),qualifying_format:race.qualifyingFormat,sprint_qualifying_format:race.sprintQualifyingFormat,course_length_km:race.courseLength,laps:race.laps,distance_km:race.distance,scheduled_laps:race.scheduledLaps,scheduled_distance_km:race.scheduledDistance,time_utc:race.time,sprint_date:race.sprintRaceDate,rules_id:'rules-'+year,url_path:'/races/'+year+'/'+race.round+'/'},resultColumns:analysis.resultColumns,results:compact.filter(r=>r[1]===race.id)};
    }
    files['data/race-day/calendar.json']={schemaVersion:1,version:'0.04.2',source:'F1DB',sourceVersion,dataAt:iso(now),events};
    return {sourceVersion,dataAt:iso(now),year,completedRounds:complete.length,files,events};
  }
  function projections(base,order,points=[25,18,15,12,10,8,6,4,2,1]){
    const current=base.drivers.map(d=>({...d,finishes:[...(d.finishes||Array(30).fill(0))],earned:0})),idx=by(current,'id');
    for(const row of order)if(idx[row.id]&&num(row.position)&&row.position>0&&!row.dsq&&!row.dns){idx[row.id].earned=points[row.position-1]||0;idx[row.id].finishes[row.position-1]=(idx[row.id].finishes[row.position-1]||0)+1;}
    const ranks=[...current].sort((a,b)=>{const diff=(b.points+b.earned)-(a.points+a.earned);if(diff)return diff;for(let i=0;i<30;i++){const n=(b.finishes[i]||0)-(a.finishes[i]||0);if(n)return n;}return (a.position??Infinity)-(b.position??Infinity);});
    return ranks.map((r,i)=>({...r,points:sum([r.points,r.earned]),position:i+1,rankBasis:'projected; points then race-finish countback, then prior order'}));
  }
  return {copy,sum,normalize,zone,localTime,countdown,chooseEvent,phase,retryPolicy,validateTables,makeBundle,projections};
});
