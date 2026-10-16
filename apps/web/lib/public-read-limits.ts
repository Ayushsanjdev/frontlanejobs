import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import {reservePublicRead,PublicReadLimitError} from '@frontlanejobs/core/public-read-limits';
import {publicReadStore} from './public-read-store';

export async function enforcePublicRead(request:Request):Promise<Response|null>{
  try{
    const salt=process.env.PUBLIC_READ_LIMIT_SALT;
    if(!salt||salt.length<32)throw Error('Read limiter not configured');
    let ip='local-development';
    if(process.env.VERCEL==='1'){
      const value=request.headers.get('x-vercel-forwarded-for')?.trim();
      if(!value||!isIP(value))throw Error('Missing trusted client IP');
      ip=value;
    }else if(process.env.NODE_ENV==='production')throw Error('A trusted production IP adapter is required');
    const hash=createHmac('sha256',salt).update(ip).digest('hex');
    await reservePublicRead(publicReadStore(),hash);
    return null;
  }catch(error){
    const limited=error instanceof PublicReadLimitError;
    return Response.json({error:limited?error.message:'Job search is temporarily unavailable. Please try again shortly.'},{status:limited?429:503,headers:{'Cache-Control':'no-store','Retry-After':String(limited?error.retryAfter:60)}});
  }
}
