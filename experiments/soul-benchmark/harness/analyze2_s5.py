import re,sys,os,glob
RES=sys.argv[1]
RL=re.compile(r'usage limit|rate.?limit|reached your|overloaded|too many requests|quota|429',re.I)
def contaminated(task,cond):
    lg=f"/tmp/tb_agent_{task}_{cond}_s5.log"
    try: return bool(RL.search(open(lg,encoding='utf-8',errors='ignore').read()))
    except: return False
rows={}; bad=0
for line in open(RES):
    m=re.match(r'RESULT (\S+) (\S+) reward=(\S+)',line)
    if not m: continue
    t,c,r=m.groups()
    if r not in('0','1'): continue
    if contaminated(t,c): bad+=1; continue   # drop rate-limited runs
    rows.setdefault(t,{})[c]=int(r)
C=['C1_baseline','C2_fresh','C3_scarred']
comp={t:v for t,v in rows.items() if all(c in v for c in C)}
nC=len(comp)
print(f"valid results (rate-limited dropped: {bad}) | fully-complete tasks: {nC}")
if nC:
    s={c:sum(v[c] for v in comp.values()) for c in C}
    print(f"  baseline {s['C1_baseline']}/{nC} ({s['C1_baseline']*100//nC}%)   fresh {s['C2_fresh']}/{nC} ({s['C2_fresh']*100//nC}%)   scarred {s['C3_scarred']}/{nC} ({s['C3_scarred']*100//nC}%)")
    div=[(t,v) for t,v in comp.items() if len({v[c] for c in C})>1]
    print(f"  divergent: {len(div)}")
    for t,v in div: print(f"    {t}: base={v['C1_baseline']} fresh={v['C2_fresh']} scar={v['C3_scarred']}")
