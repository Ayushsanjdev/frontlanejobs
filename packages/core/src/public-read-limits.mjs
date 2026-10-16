import {discoveryTransaction} from './discovery-store.mjs';

export class PublicReadLimitError extends Error {
  constructor(retryAfter){super('Job request limit reached. Please try again after '+retryAfter+' seconds.');this.retryAfter=retryAfter}
}
export async function reservePublicRead(db,ipHash,clock){
  if(!/^[a-f0-9]{64}$/.test(ipHash))throw Error('Invalid public read identity');
  return discoveryTransaction(db,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext('frontlanejobs:public-read'))");
    const now=clock||new Date((await client.query('SELECT clock_timestamp()::text AS now')).rows[0].now);
    const day=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
    const hour=new Date(Math.floor(now.getTime()/3600000)*3600000);
    const windows=[{scope:'day',subject:'all',start:day,limit:2000,ms:86400000},{scope:'hour',subject:ipHash,start:hour,limit:60,ms:3600000}];
    let retry=0;
    for(const w of windows){
      const result=await client.query('SELECT count FROM public_read_limits WHERE scope=$1 AND subject=$2 AND window_start=$3',[w.scope,w.subject,w.start]);
      if((result.rows[0]?.count||0)>=w.limit)retry=Math.max(retry,Math.ceil((w.start.getTime()+w.ms-now.getTime())/1000));
    }
    if(retry)throw new PublicReadLimitError(retry);
    for(const w of windows)await client.query('INSERT INTO public_read_limits(scope,subject,window_start,reset_at,count) VALUES($1,$2,$3,$4,1) ON CONFLICT(scope,subject,window_start) DO UPDATE SET count=public_read_limits.count+1',[w.scope,w.subject,w.start,new Date(w.start.getTime()+w.ms)]);
    // Only the first admission of each UTC hour performs bounded retention work.
    const initial=await client.query('SELECT count FROM public_read_limits WHERE scope=$1 AND subject=$2 AND window_start=$3',['hour',ipHash,hour]);
    if(initial.rows[0]?.count===1)await client.query('DELETE FROM public_read_limits WHERE (scope,subject,window_start) IN (SELECT scope,subject,window_start FROM public_read_limits WHERE reset_at<$1 ORDER BY reset_at LIMIT 100)',[new Date(now.getTime()-86400000)]);
    return {hourReset:Math.floor((hour.getTime()+3600000)/1000),dayReset:Math.floor((day.getTime()+86400000)/1000)};
  });
}
