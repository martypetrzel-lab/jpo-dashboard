// Bounded, single-instance limiter; the Railway edge determines req.ip.
export function createRateLimiter({max=8,windowMs=600000,maxKeys=10000,now=Date.now}={}) {
  const entries=new Map();
  return (req,res,next)=>{
    const time=now();
    for(const [key,row] of entries)if(time-row.first>=windowMs)entries.delete(key);
    const key=req.ip||req.socket?.remoteAddress||'unknown';
    let row=entries.get(key);
    if(!row){if(entries.size>=maxKeys)return res.status(429).json({ok:false,error:'too_many_attempts'});row={count:0,first:time};entries.set(key,row);}
    row.count++;
    if(row.count>max){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((windowMs-(time-row.first))/1000))));return res.status(429).json({ok:false,error:'too_many_attempts'});}
    next();
  };
}
