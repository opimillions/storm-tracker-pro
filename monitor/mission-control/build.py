"""Mission Control: add the StormCheck Monitor agent and a secret-protected incident intake."""
import base64
s = open('original.ts', encoding='utf-8').read()
def sub(old, new):
    global s
    assert s.count(old) == 1, old[:60]
    s = s.replace(old, new)
sub('agents=[', 'agents=[ ["stormmon","StormCheck Monitor","\U0001fa7a","Checks NOAA feeds and the customer workflow (sign-in to PDF); reports issues to Billy Bob","Every 10 min",1],')
endpoint = r'''if(path==="/api/monitor/incident"&&method==="POST"){const token=String(Bun.env.MONITOR_EVENT_SECRET||"");const provided=req.headers.get("x-monitor-secret")||"";if(!token||token.length<24||!same(provided,token))return respond({error:"Unauthorized"},401);try{const j=await body(req);const key=text(j.key,120).replace(/[^\w.-]/g,"");const kind=j.kind;if(!key||!["open","recover"].includes(kind))return respond({error:"Invalid incident"},422);const id="mon-"+key,title=text(j.title,160)||"StormCheck issue",details=text(j.details,1800),link=text(j.link,400),d=now();const existing=db.query("SELECT * FROM tasks WHERE id=?").get(id);if(kind==="open"){const desc=details+(link?"\nInspect: "+link:"")+"\nReported by the StormCheck monitor. Billy Bob: review and decide the next step.";if(existing)db.prepare("UPDATE tasks SET title=?,description=?,status=?,priority=?,updated_at=? WHERE id=?").run(title,desc,"in_progress","urgent",d,id);else db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,title,desc,"StormCheck","billy","in_progress","urgent","","StormCheck Monitor",d,d);event("StormCheck issue → Billy Bob",title+" · "+details.slice(0,400))}else{if(existing)db.prepare("UPDATE tasks SET status=?,description=?,updated_at=? WHERE id=?").run("done",String(existing.description||"")+"\nRecovered "+d+": "+details,d,id);event("StormCheck recovered",title+" · "+details.slice(0,400))}return respond({ok:true,id})}catch(ex){return respond({error:String(ex.message||ex)},400)}}
'''
sub('if(path==="/api/stormcheck/worker"&&method==="POST")', endpoint + 'if(path==="/api/stormcheck/worker"&&method==="POST")')
open('new.ts', 'w', encoding='utf-8').write(s)
open('new.b64', 'w').write(base64.b64encode(s.encode('utf-8')).decode())
