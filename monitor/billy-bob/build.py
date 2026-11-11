"""Builds Billy Bob's new code: original + StormCheck health panel routes. Prints nothing; writes new.ts and new.b64."""
import base64, json

src = open('original.ts', encoding='utf-8').read()

def sub(old, new):
    global src
    assert src.count(old) == 1, old[:80]
    src = src.replace(old, new)

# 1. Link from the main page header.
sub('<a href="https://command.thepublicadjustertx.com">Animated office ↗</a>',
    '<span><a href="/stormcheck">StormCheck health ↗</a> &nbsp; <a href="https://command.thepublicadjustertx.com">Animated office ↗</a></span>')

# 2. Panel page + status proxy (server side, behind the existing CEO sign-in).
helpers = '''
const monBase=()=>(Bun.env.MONITOR_URL||"http://stormcheck-monitor.railway.internal:8080").replace(/\\/$/,"");
const overduePage=(why:string)=>'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StormCheck Health</title><body style="margin:0;background:#081321;color:#eaf5ff;font:16px system-ui;padding:18px"><a href="/" style="color:#84dff1">\u2190 Billy Bob</a><div style="margin-top:14px;border:1px solid #55606e;border-radius:14px;padding:16px;background:#262d37"><b style="font-size:18px">Monitor overdue</b><p>'+why.replace(/[<>&]/g,"")+'</p><p>No StormCheck status can be shown until the monitor reports again.</p></div>';
async function stormStatus(){
  const fetchedAt=new Date().toISOString();
  if(!Bun.env.MONITOR_STATUS_TOKEN)return {fetchedAt,overdue:true,overdueReason:"Billy Bob is missing MONITOR_STATUS_TOKEN, so he can't read the monitor.",data:null};
  try{
    const r=await fetch(monBase()+"/api/status",{headers:{authorization:"Bearer "+Bun.env.MONITOR_STATUS_TOKEN},signal:AbortSignal.timeout(8000)});
    if(!r.ok)return {fetchedAt,overdue:true,overdueReason:"The monitor answered HTTP "+r.status+".",data:null};
    const data:any=await r.json();
    const every=(data.monitor&&data.monitor.expectedEveryMin)||10;
    const hb=data.monitor&&data.monitor.heartbeat;
    const late=!hb||Date.now()-Date.parse(hb)>(every*2+5)*60000;
    return {fetchedAt,overdue:late,overdueReason:late?"The monitor is running but hasn't finished a check cycle since "+(hb||"it started")+".":null,data};
  }catch(e:any){return {fetchedAt,overdue:true,overdueReason:"The monitor isn't answering ("+(e&&e.message||"no response")+").",data:null}}
}
async function stormPanel(){try{const r=await fetch(monBase()+"/panel",{headers:{authorization:"Bearer "+(Bun.env.MONITOR_STATUS_TOKEN||"")},signal:AbortSignal.timeout(8000)});if(r.ok)return await r.text();return overduePage("The monitor answered HTTP "+r.status+".")}catch(e:any){return overduePage("The monitor isn't answering ("+(e&&e.message||"no response")+").")}}
'''
sub('const json=(d:any,s=200)=>', helpers + 'const json=(d:any,s=200)=>')

sub('if(url.pathname==="/api/status")return json(',
    'if(url.pathname==="/stormcheck"&&req.method==="GET")return new Response(await stormPanel(),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","x-frame-options":"DENY"}});'
    'if(url.pathname==="/api/stormcheck")return json(await stormStatus());'
    'if(url.pathname==="/api/status")return json(')

# 3. Billy Bob's chat: when asked about StormCheck or issues, he reads the live monitor status first.
summary_fn = '''
async function stormBrief(){const s:any=await stormStatus();if(!s.data)return "StormCheck monitor: "+(s.overdueReason||"not reporting")+" I can't vouch for StormCheck right now.";
const c=(s.data.checks||[]);const bad=c.filter((x:any)=>x.status==="fail");const setup=c.filter((x:any)=>x.status==="setup");const open=(s.data.incidents||[]).filter((i:any)=>!i.closedAt);
let t="StormCheck monitor"+(s.overdue?" (OVERDUE: "+s.overdueReason+")":"")+": ";
if(open.length||bad.length)t+=(open.length||bad.length)+" issue(s). "+(open.length?open:bad).slice(0,4).map((x:any)=>"- "+x.name+": "+x.problem+(x.link?" Inspect: "+x.link:"")).join(" ");
else t+="all running checks passing.";
if(setup.length)t+=" Needs setup: "+setup.map((x:any)=>x.name).join(", ")+".";
return t+" Full panel: /stormcheck";}
'''
sub('const json=(d:any,s=200)=>', summary_fn + 'const json=(d:any,s=200)=>')
sub('const match=bots.map(', 'const scAsk=/storm|issue|problem|broken|down|health|status|alert|outage/i.test(message);const scBrief=scAsk?await stormBrief():"";const match=bots.map(')
sub('content:rules}', 'content:rules+(scBrief?" Live monitor data you can rely on (do not invent beyond it): "+scBrief:"")}')
sub('return json({owner,reply,executed:false})', 'if(scBrief)reply=scBrief+"\\n\\n"+reply;return json({owner,reply,executed:false})')

# 4. Tell Billy Bob's planner about the new monitor (it still can't execute other bots).
sub('SEO Ranking API and Animated Office.', 'SEO Ranking API and Animated Office, plus the StormCheck Monitor, which checks NOAA feeds and customer workflows and reports at /stormcheck.')

open('new.ts', 'w', encoding='utf-8').write(src)
open('new.b64', 'w').write(base64.b64encode(src.encode('utf-8')).decode())
