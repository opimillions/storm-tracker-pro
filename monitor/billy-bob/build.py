"""Builds Billy Bob's new code: original + StormCheck health panel routes. Prints nothing; writes new.ts and new.b64."""
import base64, json

src = open('original.ts', encoding='utf-8').read()
panel = open('panel.html', encoding='utf-8').read()

def sub(old, new):
    global src
    assert src.count(old) == 1, old[:80]
    src = src.replace(old, new)

# 1. Link from the main page header.
sub('<a href="https://command.thepublicadjustertx.com">Animated office ↗</a>',
    '<span><a href="/stormcheck">StormCheck health ↗</a> &nbsp; <a href="https://command.thepublicadjustertx.com">Animated office ↗</a></span>')

# 2. Panel page + status proxy (server side, behind the existing CEO sign-in).
helpers = '''
const stormPanel=''' + json.dumps(panel) + ''';
async function stormStatus(){
  const base=(Bun.env.MONITOR_URL||"http://stormcheck-monitor.railway.internal:8080").replace(/\\/$/,"");
  const fetchedAt=new Date().toISOString();
  if(!Bun.env.MONITOR_STATUS_TOKEN)return {fetchedAt,overdue:true,overdueReason:"Billy Bob is missing MONITOR_STATUS_TOKEN, so he can't read the monitor.",data:null};
  try{
    const r=await fetch(base+"/api/status",{headers:{authorization:"Bearer "+Bun.env.MONITOR_STATUS_TOKEN},signal:AbortSignal.timeout(8000)});
    if(!r.ok)return {fetchedAt,overdue:true,overdueReason:"The monitor answered HTTP "+r.status+".",data:null};
    const data:any=await r.json();
    const every=(data.monitor&&data.monitor.expectedEveryMin)||10;
    const hb=data.monitor&&data.monitor.heartbeat;
    const late=!hb||Date.now()-Date.parse(hb)>(every*2+5)*60000;
    return {fetchedAt,overdue:late,overdueReason:late?"The monitor is running but hasn't finished a check cycle since "+(hb||"it started")+".":null,data};
  }catch(e:any){return {fetchedAt,overdue:true,overdueReason:"The monitor isn't answering ("+(e&&e.message||"no response")+").",data:null}}
}
'''
sub('const json=(d:any,s=200)=>', helpers + 'const json=(d:any,s=200)=>')

sub('if(url.pathname==="/api/status")return json(',
    'if(url.pathname==="/stormcheck"&&req.method==="GET")return new Response(stormPanel,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","x-frame-options":"DENY"}});'
    'if(url.pathname==="/api/stormcheck")return json(await stormStatus());'
    'if(url.pathname==="/api/status")return json(')

# 3. Tell Billy Bob's planner about the new monitor (it still can't execute other bots).
sub('SEO Ranking API and Animated Office.', 'SEO Ranking API and Animated Office, plus the StormCheck Monitor, which checks NOAA feeds and customer workflows and reports at /stormcheck.')

open('new.ts', 'w', encoding='utf-8').write(src)
open('new.b64', 'w').write(base64.b64encode(src.encode('utf-8')).decode())
