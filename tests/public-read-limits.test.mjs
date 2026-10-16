import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {register} from 'node:module';
import {createHmac} from 'node:crypto';
import {discoveryDatabase} from './helpers/discovery-db.mjs';
import {reservePublicRead,PublicReadLimitError} from '@frontlanejobs/core/public-read-limits';
import {createApi} from '../apps/mobile/src/api.mjs';
register('./helpers/route-loader.mjs',import.meta.url);
const {enforcePublicRead}=await import('../apps/web/lib/public-read-limits.ts');
const jobs=await import('../apps/web/app/api/jobs/route.ts');
const now=new Date('2026-10-16T12:00:00Z'),hash='a'.repeat(64);
beforeEach(()=>{
  process.env.PUBLIC_READ_LIMIT_SALT='test-only-public-read-salt-32-characters';
  delete process.env.VERCEL;
  globalThis.__frontlaneRouteTest={user:null,db:{query:async()=>assert.fail('unexpected jobs query')}};
});
test('public read admission is concurrent-safe and rejected reservations roll back',async()=>{
  const f=await discoveryDatabase();
  try{
    await f.pg.exec(await readFile(new URL('../packages/database/schema/013-public-read-limits.sql',import.meta.url),'utf8'));
    const results=await Promise.allSettled(Array.from({length:62},()=>reservePublicRead(f.db,hash,now)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,60);
    assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason instanceof PublicReadLimitError&&r.reason.retryAfter===3600));
    assert.ok((await f.pg.query('SELECT count FROM public_read_limits')).rows.every(r=>r.count===60));
    await reservePublicRead(f.db,hash,new Date('2026-10-16T13:00:00Z'));
    await f.pg.query("UPDATE public_read_limits SET count=2000 WHERE scope='day'");
    await assert.rejects(()=>reservePublicRead(f.db,'b'.repeat(64),now),PublicReadLimitError);
    assert.equal((await f.pg.query("SELECT * FROM public_read_limits WHERE subject=$1",['b'.repeat(64)])).rows.length,0);
    await reservePublicRead(f.db,hash,new Date('2026-10-17T00:00:00Z'));
    await assert.rejects(()=>reservePublicRead(f.db,'raw-ip',now),/Invalid/);
  }finally{await f.close()}
});
test('trusted Vercel IP is HMACed and generic forwarded identities cannot bypass it',async()=>{
  process.env.VERCEL='1';
  let subject;
  globalThis.__frontlaneRouteTest.readLimitDb={connect:async()=>({query:async(sql,args)=>{
    if(sql.includes('clock_timestamp'))return {rows:[{now:now.toISOString()}]};
    if(sql.startsWith('INSERT')&&args[0]==='hour')subject=args[1];
    return {rows:[]};
  },release(){}})};
  const request=new Request('https://example.invalid/api/jobs',{headers:{'x-vercel-forwarded-for':'203.0.113.8','x-forwarded-for':'192.0.2.10'}});
  assert.equal(await enforcePublicRead(request),null);
  assert.equal(subject,createHmac('sha256',process.env.PUBLIC_READ_LIMIT_SALT).update('203.0.113.8').digest('hex'));
  assert.equal((await enforcePublicRead(new Request(request.url,{headers:{'x-forwarded-for':'192.0.2.10'}}))).status,503);
  assert.equal((await enforcePublicRead(new Request(request.url,{headers:{'x-vercel-forwarded-for':'1.2.3.4, 5.6.7.8'}}))).status,503);
});
test('missing salt, limiter outage and exhaustion stop jobs before data/fallback access',async()=>{
  delete process.env.PUBLIC_READ_LIMIT_SALT;
  assert.equal((await jobs.GET(new Request('http://localhost/api/jobs'))).status,503);
  process.env.PUBLIC_READ_LIMIT_SALT='test-only-public-read-salt-32-characters';
  globalThis.__frontlaneRouteTest.readLimitDb={connect:async()=>({query:async(sql)=>({rows:sql.includes('clock_timestamp')?[{now:now.toISOString()}]:sql.startsWith('SELECT count')?[{count:2000}]:[]}),release(){}})};
  const limited=await jobs.GET(new Request('http://localhost/api/jobs?id=missing'));
  assert.equal(limited.status,429);assert.ok(limited.headers.get('retry-after'));assert.equal(limited.headers.get('cache-control'),'no-store');
  assert.match((await limited.json()).error,/limit/);
});
test('mobile retains the readable 429 error without invalidating a session',async()=>{
  let unauthorized=false;
  const api=createApi('https://example.invalid',async()=>Response.json({error:'Request limit reached. Try again in 60 seconds.'},{status:429}));
  await assert.rejects(()=>api.request('/api/jobs',{token:'test',onUnauthorized:()=>{unauthorized=true}}),e=>e.status===429&&e.message.includes('60 seconds'));
  assert.equal(unauthorized,false);
});
