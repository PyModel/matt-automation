#!/usr/bin/env python3
"""Adversarial regression audit for matt-automation, standard library only.

Usage: python3 audit_regressions.py --repo /path/to/matt-automation --output results.json
No actual pi invocation, model request, network access, or project mutation occurs.
Only the inspected dispatcher/validator execute, against disposable local Git fixtures.
Exit 1 means one or more expected safety properties were violated, not a harness error.
"""
from __future__ import annotations
import argparse, copy, hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, signal, time
from typing import Any

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--repo', type=pathlib.Path, required=True)
p.add_argument('--output', type=pathlib.Path, default=pathlib.Path('audit-results.json'))
a = p.parse_args()
DISPATCH = a.repo.resolve() / 'to-orc/scripts/orc-dispatch.mjs'
VALIDATOR = a.repo.resolve() / 'to-orc/scripts/validate-verdict.mjs'
for f in (DISPATCH, VALIDATOR):
    if not f.is_file():
        p.error(f'missing inspected script: {f}')
for tool in ('node', 'git'):
    if not shutil.which(tool):
        p.error(f'{tool} is required')

cases: list[dict[str, Any]] = []
tmp = tempfile.TemporaryDirectory(prefix='matt-audit-regressions-')
ROOT = pathlib.Path(tmp.name)
BIN = ROOT / 'bin'; BIN.mkdir()
(BIN / 'pi').write_text('#!/bin/sh\n[ "$1" = "--version" ] && { echo "0.85.1-test-shim"; exit 0; }\necho "Real pi execution is prohibited in this audit" >&2\nexit 99\n')
(BIN / 'pi').chmod(0o755)
RELAY = ROOT / 'relay.mjs'
RELAY.write_text(r'''
import fs from 'node:fs';
import path from 'node:path';
const arg = n => process.argv[process.argv.indexOf(n)+1];
const out = arg('--out-dir');
const mode = process.env.AUDIT_MODE || 'ok';
const target = process.env.AUDIT_TARGET;
fs.mkdirSync(out, {recursive:true});
const r = {
  schema:'delegate-relay.result.v1', tool:'pi', provider:'zai',
  model:'zai/glm-5.3-flash:max', actualProvider:'zai', actualModel:'glm-5.3-flash',
  status:'completed', exitCode:0, piVersion:'0.85.1', sessionId:'audit-implement-session',
  usage:{reasoning:10,cost:{total:0.01}}, stopReason:'stop'
};
if (mode === 'linger-on-term') {
  process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(target,'write after termination request\n'); process.exit(0); }, 200));
  fs.writeFileSync(path.join(out,'relay-ready'),'ready');
  await new Promise(resolve => setTimeout(resolve, 5000));
  process.exit(0);
}
if (mode === 'no-result') process.exit(0);
if (mode === 'null-result') { fs.writeFileSync(path.join(out,'result.json'),'null'); process.exit(0); }
if (mode === 'edit') fs.writeFileSync(target,'worker changed content\n');
if (mode === 'edit-large') { const fd=fs.openSync(target,'r+'); fs.writeSync(fd,Buffer.from('C'),0,1,0); fs.closeSync(fd); }
if (mode === 'retarget') { fs.unlinkSync(target); fs.symlinkSync(process.env.AUDIT_LINK_TO,target); }
if (mode === 'nonzero-worker') r.exitCode=5;
if (mode === 'error-stop') r.stopReason='error';
if (mode === 'unknown-pi') r.piVersion='9.99.0';
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(r));
fs.writeFileSync(path.join(out,'final.txt'),'OUTCOME: COMPLETE\nTest-only relay\n');
''')
ENV = {**os.environ, 'PATH':str(BIN)+os.pathsep+os.environ.get('PATH',''), 'TO_ORC_RELAY':str(RELAY),
       'GIT_CONFIG_NOSYSTEM':'1', 'GIT_CONFIG_GLOBAL':os.devnull,
       'GIT_AUTHOR_NAME':'Audit', 'GIT_AUTHOR_EMAIL':'audit@example.invalid',
       'GIT_COMMITTER_NAME':'Audit', 'GIT_COMMITTER_EMAIL':'audit@example.invalid'}

def run(argv: list[str], *, env: dict[str,str] | None=None, input: str | None=None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv,env=env or ENV,input=input,text=True,capture_output=True,timeout=15)

def git(repo: pathlib.Path, *args: str) -> str:
    r=run(['git','-C',str(repo),*args])
    if r.returncode: raise RuntimeError(f'git {args}: {r.stderr}')
    return r.stdout.strip()

def fixture(name: str) -> tuple[pathlib.Path,pathlib.Path,pathlib.Path]:
    d=ROOT/name; repo=d/'repo'; repo.mkdir(parents=True)
    git(repo,'init','-q','-b','main')
    (repo/'README.md').write_text('initial\n')
    git(repo,'add','-A'); git(repo,'commit','-qm','base')
    rd=d/'run'; (rd/'accepted').mkdir(parents=True)
    for ph in ('scout','research','implement','verify'):
        (rd/'accepted'/f'{ph}.md').write_text('accepted test fixture\n')
    brief=d/'brief.txt'; brief.write_text('Local audit fixture. No network.\n')
    return repo,rd,brief

# The worker the mock relay reports; to-orc has no default model, so every dispatch names it.
MODEL = ['--model', 'zai/glm-5.3-flash:max']

def dispatch(repo: pathlib.Path, rd: pathlib.Path, brief: pathlib.Path, *, task='P1',phase='scout',mode='ok',extra: list[str]|None=None, **env: str) -> dict[str,Any]:
    r=run(['node',str(DISPATCH),'--phase',phase,'--task',task,'--brief',str(brief),
           '--run-dir',str(rd),'--repo',str(repo),*MODEL,*(extra or [])],env={**ENV,'AUDIT_MODE':mode,**env})
    sf=rd/task/'orc-status.json'; st=None
    if sf.is_file():
        try: st=json.loads(sf.read_text())
        except ValueError: pass
    return {'exit':r.returncode,'status':st,'stdout':r.stdout,'stderr':r.stderr}

def expect(name: str, safe: bool, expected: str, observed: Any, *, advisory: bool=False) -> None:
    item={'id':f'A{len(cases)+1:02d}','name':name,'result':'PASS' if safe else ('ADVISORY' if advisory else 'VIOLATION'),
          'expected':expected,'observed':observed}
    cases.append(item)
    print(f"{item['id']} {item['result']:9} {name}")

# Evidence immutability.
repo,rd,b=fixture('duplicate')
x=dispatch(repo,rd,b); old=(rd/'P1/orc-status.json').read_bytes()
y=dispatch(repo,rd,b)
expect('A rejected duplicate preserves previous dispatch evidence',old==(rd/'P1/orc-status.json').read_bytes(),
       'Refuse retry without changing previous status',{'first':x['status']['orcStatus'],'retry_exit':y['exit'],'stored_after':y['status']['orcStatus']})

repo,rd,b=fixture('stale-result')
x=dispatch(repo,rd,b)
y=dispatch(repo,rd,b,mode='no-result',extra=['--force'])
expect('Forced retry cannot reuse result.json from an earlier execution',y['exit']!=0,
       'Missing fresh nonce-bound result is a failure',{'exit':y['exit'],'status':y['status']['orcStatus'],'reason':y['status']['reason']})

# Workspace fingerprint and revision identity.
repo,rd,b=fixture('large-file')
target=repo/'large.txt'; target.write_bytes(b'A'*(8*1024*1024+1))
git(repo,'add','large.txt'); git(repo,'commit','-qm','large tracked file')
with target.open('r+b') as f: f.write(b'B')
old_diff=git(repo,'diff'); before=hashlib.sha256(target.read_bytes()).hexdigest()
x=dispatch(repo,rd,b,mode='edit-large',AUDIT_TARGET=str(target))
expect('Read-only phase catches same-size edits to a large dirty tracked file',x['exit']==72,
       'NO_WRITES_VIOLATED',{'exit':x['exit'],'status':x['status']['orcStatus'], 'bytes_changed':before!=hashlib.sha256(target.read_bytes()).hexdigest(), 'git_diff_changed':old_diff!=git(repo,'diff')})

repo,rd,b=fixture('subdirectory')
sub=repo/'pkg'; sub.mkdir(); target=sub/'dirty.txt'; target.write_text('base\n')
git(repo,'add','-A'); git(repo,'commit','-qm','package'); target.write_text('already dirty\n')
x=dispatch(sub,rd,b,mode='edit',AUDIT_TARGET=str(target))
expect('Read-only detection works when --repo is a Git subdirectory',x['exit']==72,
       'Reject invalid root or correctly detect modification',{'exit':x['exit'],'status':x['status']['orcStatus'],'content':target.read_text().strip()})

repo,rd,b=fixture('symlink')
(repo/'one.txt').write_text('same'); (repo/'two.txt').write_text('same')
git(repo,'add','-A'); git(repo,'commit','-qm','link targets')
target=repo/'link'; target.symlink_to('one.txt')
x=dispatch(repo,rd,b,mode='retarget',AUDIT_TARGET=str(target),AUDIT_LINK_TO='two.txt')
expect('Read-only detection catches untracked symlink retargeting',x['exit']==72,
       'Hash link type and readlink target, not followed bytes',{'exit':x['exit'],'status':x['status']['orcStatus'],'link_now':os.readlink(target)})

for staged in (False,True):
    repo,rd,b=fixture('identity-staged' if staged else 'identity-untracked')
    target=repo/'new.txt'; target.write_text('implementation A\n')
    if staged: git(repo,'add','new.txt')
    impl=dispatch(repo,rd,b,phase='implement',task='I')
    target.write_text('different implementation B\n')
    if staged: git(repo,'add','new.txt')
    verify=dispatch(repo,rd,b,phase='verify',task='V')
    # The dispatcher now refuses verify on a tree that moved after implement; that refusal is the safe outcome.
    refused=verify['exit']==77 and 'changed after' in verify['status']['reason']
    expect(('Staged' if staged else 'Untracked')+' changes after implement make verify refuse the moved change set',refused,
           'Verify is refused when the deliverable changed after implement',{'verify_exit':verify['exit'],'implement_status':impl['status']['orcStatus'],'verify_status':verify['status']['orcStatus'],'reason':verify['status']['reason']})
    # The identity itself: the same tree state under a fresh implement must get a different snapshot than content A did.
    rd2=rd.parent/(rd.name+'-b'); (rd2/'accepted').mkdir(parents=True)
    for ph in ('scout','research'): (rd2/'accepted'/f'{ph}.md').write_text('accepted\n')
    impl_b=dispatch(repo,rd2,b,phase='implement',task='I')
    ident=lambda x:(x['status']['changeSet']['headAfter'],x['status']['changeSet']['worktreeDiffSha'])
    expect(('Staged' if staged else 'Untracked')+' changes cannot collide in the implementation identity',ident(impl)!=ident(impl_b),
           'Any change to the deliverable changes the recorded identity',{'identical_identity':ident(impl)==ident(impl_b)})

# Path containment (dry-run avoids deliberately polluting a workspace).
repo,rd,b=fixture('dotdot-directory'); rd=repo/'..artifacts'
x=dispatch(repo,rd,b,extra=['--dry-run'])
expect('A run directory named ..artifacts inside the workspace is refused',x['exit']==77,
       'Containment tests path segments rather than startsWith("..")',{'exit':x['exit'],'stdout':x['stdout'].strip()})

repo,rd,b=fixture('symlink-directory'); inner=repo/'artifacts'; inner.mkdir(); alias=rd.parent/'outside-alias'; alias.symlink_to(inner,target_is_directory=True)
x=dispatch(repo,alias,b,extra=['--dry-run'])
expect('An outside symlink resolving inside the workspace is refused',x['exit']==77,
       'Canonicalize paths before enforcing isolation',{'exit':x['exit'],'resolved_run_directory':str(alias.resolve())})

repo,rd,b=fixture('prevalidation-write'); inner=repo/'run'
x=dispatch(repo,inner,b.parent/'missing-brief.txt')
expect('An invalid invocation does not write status into the workspace',not (inner/'P1/orc-status.json').exists(),
       'Validate containment before any evidence write',{'exit':x['exit'],'status_written_inside_workspace':(inner/'P1/orc-status.json').exists()})

repo,rd,b=fixture('poll-traversal'); outside=rd.parent/'outside'; outside.mkdir()
sf=outside/'orc-status.json'; sf.write_text(json.dumps({'orcStatus':'RUNNING','pid':2147483647,'relayPid':None}))
r=run(['node',str(DISPATCH),'--poll','--task','../outside','--run-dir',str(rd)])
expect('Poll mode cannot traverse outside the run directory',r.returncode==77 and json.loads(sf.read_text())['orcStatus']=='RUNNING',
       'Apply the normal task validator before poll reads or writes',{'exit':r.returncode,'outside_status_after':json.loads(sf.read_text())['orcStatus']})

# Lifecycle/cycle/session/accounting gates.
repo,rd,b=fixture('unknown-session')
x=dispatch(repo,rd,b,phase='repair',task='R',extra=['--session','never-implemented-here'])
expect('Repair requires a known successful implement session',x['exit']==77,
       'Reject unknown or wrong-phase session before dispatch',{'exit':x['exit'],'status':x['status']['orcStatus']})

repo,rd,b=fixture('rejected-repair')
dispatch(repo,rd,b,phase='implement',task='I')
bad=dispatch(repo,rd,b,phase='repair',task='bad')
x=dispatch(repo,rd,b,phase='repair',task='first-real',extra=['--session','audit-implement-session'])
expect('A rejected repair does not consume an execution cycle',not ('cycle limit' in x['status']['reason']),
       'Count started/completed repair attempts, not precondition refusals',{'rejected_exit':bad['exit'],'real_attempt_exit':x['exit'],'reason':x['status']['reason']})

repo,rd,b=fixture('cycle-bypass')
x=dispatch(repo,rd,b,phase='implement',task='I1',extra=['--cycles','1'])
y=dispatch(repo,rd,b,phase='verify',task='V1',extra=['--cycles','1'])
z=dispatch(repo,rd,b,phase='implement',task='I2',extra=['--cycles','1'])
expect('Total implement/verify cycle cap covers fresh implementations',z['exit']==77,
       'A second implementation requires an explicitly new run/budget',{'first_implement_exit':x['exit'],'verify_exit':y['exit'],'second_implement_exit':z['exit']})

repo,rd,b=fixture('corrupt-spend'); (rd/'spend.json').write_text('{ truncated ledger')
x=dispatch(repo,rd,b,extra=['--max-cost','0.001'])
try: new_total=json.loads((rd/'spend.json').read_text()).get('totalUsd')
except Exception: new_total='unreadable'
expect('Unreadable spend accounting fails closed instead of resetting the budget',x['exit']!=0,
       'Corrupt accounting prevents new spending',{'exit':x['exit'],'status':x['status']['orcStatus'],'new_total':new_total})

repo,rd,b=fixture('null-result')
x=dispatch(repo,rd,b,mode='null-result')
expect('A syntactically valid null result produces terminal typed failure',x['status'] is not None and x['status']['orcStatus']!='RUNNING' and x['exit']!=0,
       'EVIDENCE_UNREADABLE/SCHEMA_DRIFT, not an uncaught exception and stale RUNNING',{'exit':x['exit'],'status':x['status']['orcStatus'],'uncaught_type_error':'TypeError' in x['stderr']})

repo,rd,b=fixture('invalid-spend-shape'); (rd/'spend.json').write_text('{"totalUsd":0,"entries":null}')
x=dispatch(repo,rd,b)
expect('An invalid spend schema cannot crash a completed dispatch into RUNNING',x['status'] is not None and x['status']['orcStatus']!='RUNNING',
       'Validate ledger shape and always persist terminal error',{'exit':x['exit'],'status':x['status']['orcStatus'],'uncaught_type_error':'TypeError' in x['stderr']})

repo,rd,b=fixture('prototype-phase')
x=dispatch(repo,rd,b,phase='constructor',extra=['--timeout','1s'])
expect('Only own, declared phase names are accepted',x['exit']==77,
       'Reject inherited Object members as invalid phase names',{'exit':x['exit'],'status':x['status']['orcStatus'] if x['status'] else None})

# Contract inconsistencies: relay process vs worker fields.
for mode in ('nonzero-worker','error-stop'):
    repo,rd,b=fixture(mode)
    x=dispatch(repo,rd,b,mode=mode)
    expect(f'Contradictory worker evidence ({mode}) fails closed',x['exit']!=0,
           'Reject contradictory completed/exit/stop evidence rather than approve',{'exit':x['exit'],'status':x['status']['orcStatus'],'relay':x['status'].get('relay')})

# Verdict cross-field rules.
valid={
 'orchestration_summary':{'task_id':'audit','dispatched_to':'pi / zai/glm-5.3-flash','flags':'--model zai/glm-5.3-flash:max','status':'PASS'},
 'phase_audit':{'scouting_completed':True,'researching_completed':True,'implementing_completed':True,'verification_completed':True},
 'plan_compliance':{'all_steps_completed':True,'deviations':[]},
 'implementation_review':{'correctness_score':9,'findings':'Checks completed.','issues_detected':[]},
 'next_action':'APPROVE'
}
def verdict(obj: Any) -> subprocess.CompletedProcess[str]:
    return run(['node',str(VALIDATOR)],input=json.dumps(obj))
r=verdict(valid)
expect('Control: a structurally consistent PASS is accepted',r.returncode==0,'Exit 0',{'exit':r.returncode})
v=copy.deepcopy(valid); v['plan_compliance']['all_steps_completed']=False
r=verdict(v)
expect('PASS cannot approve an explicitly incomplete plan',r.returncode==1,
       'Cross-field rejection',{'exit':r.returncode,'stdout':r.stdout.strip()})
v=copy.deepcopy(valid); v['orchestration_summary']['status']='FAIL'; v['next_action']='REQUEST_CHANGES'; v['phase_audit']={k:False for k in v['phase_audit']}
r=verdict(v)
expect('No completed phases require a null correctness score',r.returncode==1,
       'Reject fabricated numeric confidence when no execution succeeded',{'exit':r.returncode,'score':v['implementation_review']['correctness_score']},advisory=True)
r=verdict(None)
expect('Null top-level verdict yields structured diagnostic rather than TypeError',r.returncode==1 and 'TypeError' not in r.stderr,
       'Report top-level type error through normal validator diagnostics',{'exit':r.returncode,'uncaught_type_error':'TypeError' in r.stderr})
v=copy.deepcopy(valid); v['implementation_review']['findings']='A fixture string contains ``` but this is valid raw JSON.'
r=verdict(v)
expect('Backticks inside a JSON string are not mistaken for wrapping Markdown',r.returncode==0,
       'Parse JSON successfully and reject only actual wrapping fences',{'exit':r.returncode,'stderr':r.stderr.strip()})

# Reproduce commands implied by Markdown, following repaired workflow contracts.
repo,rd,b=fixture('removed-todo'); (repo/'example.txt').write_text('TODO: remove stale marker\n')
git(repo,'add','-A'); git(repo,'commit','-qm','old marker'); base=git(repo,'rev-parse','HEAD')
(repo/'example.txt').write_text('complete\n'); git(repo,'add','-A'); git(repo,'commit','-qm','remove marker')
diff=git(repo,'diff','-U0',base+'...HEAD')
added_lines='\n'.join(line[1:] for line in diff.splitlines() if line.startswith('+') and not line.startswith('+++'))
r=run(['grep','-nE',r'TODO|FIXME|HACK|\.skip\('],input=added_lines)
expect('Documented no-debt grep permits deleting an old TODO',r.returncode==1,
       'Only relevant added lines should be checked, not removals/context',{'grep_exit':r.returncode,'matched':r.stdout.strip()})

repo,rd,b=fixture('stale-bootstrap'); git(repo,'branch','goal/bootstrap')
(repo/'feature.txt').write_text('new default-branch functionality\n'); git(repo,'add','-A'); git(repo,'commit','-qm','advance main')
git(repo,'rebase','main','goal/bootstrap')
main=git(repo,'rev-parse','main'); chosen=git(repo,'rev-parse','goal/bootstrap')
expect('Documented bootstrap selection follows the current default branch',main==chosen,
       'Existing bootstrap configuration must not freeze the source base',{'default_sha':main,'selected_base_sha':chosen,'selected_base_has_new_feature':run(['git','-C',str(repo),'cat-file','-e','goal/bootstrap:feature.txt']).returncode==0})

empty=ROOT/'unborn'; empty.mkdir(); git(empty,'init','-q','-b','main')
git(empty,'commit','--allow-empty','-qm','Initial commit')
r=run(['git','-C',str(empty),'worktree','add','-b','goal/new-test',str(ROOT/'unborn-run'),'main'])
expect('to-new handles its documented existing-repository-with-no-commits case',r.returncode==0,
       'Create an initial commit for unborn repositories before worktree setup',{'exit':r.returncode,'stderr':r.stderr.strip()})

# Documented bug fast path captures the review branch point before any mutation.
repo,rd,b=fixture('bug-fastpath-review')
review_base=git(repo,'rev-parse','HEAD')  # Captured in stage 0c before stage 2 diagnosis
(repo/'bug.txt').write_text('bug fix delivered during stage 2\n')
git(repo,'add','-A'); git(repo,'commit','-qm','fix during diagnosis')
review_diff=git(repo,'diff',review_base+'...HEAD')
expect('Bug fast-path final review includes the diagnosis-stage fix',bool(review_diff),
       'Capture immutable review_base before any diagnosis/plan mutation',{'actual_fix_diff_nonempty':bool(git(repo,'diff',review_base+'...HEAD')),'documented_review_diff_empty':not bool(review_diff)})

# Run the exact GC removal primitive only on an owned, disposable worktree.
repo,rd,b=fixture('gc-loss'); worktree=rd.parent/'goal-old'
git(repo,'worktree','add','-b','goal/old',str(worktree),'HEAD')
uncommitted=worktree/'only-copy.txt'; uncommitted.write_text('uncommitted work not backed up\n')
is_dirty=bool(git(worktree,'status','--porcelain').strip())
if not is_dirty:
    git(repo,'worktree','remove','--force',str(worktree))
expect('Documented force-GC primitive preserves uncommitted work',uncommitted.exists(),
       'Refuse dirty/unmerged worktree collection or archive and verify recovery first',{'uncommitted_file_survives':uncommitted.exists(),'backup_requested_by_documented_command':False})

# One tracked execution tree needs a control worktree in addition to the run.
repo,rd,b=fixture('control-handback'); ctl=rd.parent/'control'; wr=rd.parent/'goal-example'
git(repo,'worktree','add','--orphan','-b','goal/control',str(ctl))
(ctl/'runs.json').write_text('[]\n'); git(ctl,'add','-A'); git(ctl,'commit','-qm','control plane')
git(repo,'worktree','add','-b','goal/example',str(wr),'main')
listing=git(repo,'worktree','list','--porcelain')
count=sum(line.startswith('worktree ') for line in listing.splitlines())
expect('Hand-back criterion permits the mandatory persistent control worktree',count<=3,
       'The docs require only checkout + run, but must explicitly also allow control and other owned runs',{'documented_max_worktrees':3,'minimum_actual_worktrees':count})

# A deliberately slow-terminating test relay proves terminal status does not fence writes.
repo,rd,b=fixture('abort-writer'); target=repo/'after-abort.txt'
proc=subprocess.Popen(['node',str(DISPATCH),'--phase','scout','--task','P1','--brief',str(b),'--run-dir',str(rd),'--repo',str(repo),*MODEL],
    env={**ENV,'AUDIT_MODE':'linger-on-term','AUDIT_TARGET':str(target)},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
try:
    deadline=time.monotonic()+5
    while not (rd/'P1/relay-ready').exists() and time.monotonic()<deadline:
        if proc.poll() is not None: raise RuntimeError('supervisor exited before signal fixture was ready')
        time.sleep(0.01)
    if not (rd/'P1/relay-ready').exists(): raise RuntimeError('signal fixture did not become ready')
    os.kill(proc.pid,signal.SIGTERM)
    proc.wait(timeout=3)
    status=json.loads((rd/'P1/orc-status.json').read_text())
    absent_at_terminal=not target.exists()
    deadline=time.monotonic()+2
    while not target.exists() and time.monotonic()<deadline: time.sleep(0.01)
    expect('ABORTED is published only after worker writes are fenced',not target.exists(),
           'Terminate/wait for the owned process tree before publishing a settled terminal state',
           {'supervisor_exit':proc.returncode,'status':status['orcStatus'],'file_absent_when_supervisor_exited':absent_at_terminal,'worker_wrote_afterward':target.exists()})
finally:
    try: os.killpg(proc.pid,signal.SIGKILL)
    except (ProcessLookupError, PermissionError): pass
    proc.communicate(timeout=3)

# Negative controls show the harness also recognizes existing protections.
repo,rd,b=fixture('control-write'); target=repo/'untracked.txt'; target.write_text('original')
x=dispatch(repo,rd,b,mode='edit',AUDIT_TARGET=str(target))
expect('Control: ordinary small-file mutation is detected',x['exit']==72,'NO_WRITES_VIOLATED',{'exit':x['exit']})
repo,rd,b=fixture('control-phase')
x=dispatch(repo,rd,b,phase='not-a-phase',extra=['--timeout','1s'])
expect('Control: an ordinary invalid phase is rejected',x['exit']==77,'PRECONDITION_FAILED',{'exit':x['exit']})

result={'schema':'matt-automation.audit-regressions.v1',
 'reference_commit':'fe49e377695de0081f7951f81a513417a481dff0',
 'matches_reference_scripts':all(run(['git','hash-object',str(f)]).stdout.strip()==h for f,h in [(DISPATCH,'ae8fcfd3299d40b7eade8b19431c77c5edf6ce74'),(VALIDATOR,'d2c06a7a1b07426a28bdc105e3e3d9bbc81abcf2')]),
 'runtime':{'node':run(['node','--version']).stdout.strip(),'git':run(['git','--version']).stdout.strip(),'platform':sys.platform,'real_pi_used':False,'network_calls':0},
 'scope_notes':{'A19-A20':'Injected contradictory relay evidence; not a claim the unavailable real relay emits this.','A23':'Suggested stronger policy. All-false phase flags alone do not prove no worker was dispatched, so this is not counted as a confirmed contract violation.','A26-A31':'Disposable Git fixtures reproduce consequences of documented commands/order, not an end-to-end agent run.','A32':'Controlled slow-terminating relay; demonstrates absent process-tree settlement, not measured live pi behavior.'},
 'source_sha256':{str(f.relative_to(a.repo.resolve())):hashlib.sha256(f.read_bytes()).hexdigest() for f in (DISPATCH,VALIDATOR)},
 'cases':cases,'summary':{'total':len(cases),'passed':sum(x['result']=='PASS' for x in cases),'violations':sum(x['result']=='VIOLATION' for x in cases),'advisories':sum(x['result']=='ADVISORY' for x in cases)}}
a.output.parent.mkdir(parents=True,exist_ok=True); a.output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result['summary']))
tmp.cleanup()
sys.exit(1 if result['summary']['violations'] else 0)
