import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRepository, git, gitEnvironment, ownStartTime, processIdentity, processStartTime, readTask, updateTask } from './task-state.mjs';
import { requireReviewDelivery } from './web-reviewer.mjs';

// Receipts are convenient bookkeeping, not a security boundary against trusted Workers.
export function sourceIdentity(task) {
  assertRepository(task);
  const cwd = task.repository.working_directory;
  const paths = execFileSync('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {env:gitEnvironment()})
    .toString().split('\0').filter(Boolean);
  const hash = createHash('sha256');
  hash.update(git(cwd, 'diff', '--binary', 'HEAD'));
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path + '\0');
    try {
      const file = join(cwd, path), stat = lstatSync(file);
      hash.update(String(stat.mode) + '\0');
      hash.update(stat.isSymbolicLink() ? readlinkSync(file) : stat.isFile() ? readFileSync(file) : '<directory>');
    } catch (error) { if(error.code !== 'ENOENT') throw error; hash.update('<deleted>'); }
  }
  return {head:git(cwd, 'rev-parse', 'HEAD'), fingerprint:hash.digest('hex')};
}
const same = (a,b) => a?.head === b.head && a?.fingerprint === b.fingerprint;
function idle(task) {
  if(task.status === 'cancelled' || task.tests?.status === 'running') throw Error('task is cancelled or busy');
  if(task.merge?.status === 'pending') throw Error('merge uncertain; reconcile live GitHub state before further work');
}
// The test command runs as its own process group (POSIX) or tree root (Windows). Windows has no process groups here:
// taskkill /T follows parent ids down from a live root, so a descendant orphaned after its parent exited is not found
// and keeps running.
function stopGroup(pid, signal = 'SIGKILL') {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    else process.kill(-pid, signal);
  } catch (error) { if (error.code !== 'ESRCH' && error.status !== 128) throw error; }
}
// Only the recorded process clears 'running'; once it is gone, or its pid names a process with another start time, the
// run was interrupted. A live pid whose start time cannot be read still counts as the runner. Every entry point that
// judges whether the task is busy (test, verify, merge, planner launch, reconcile) runs this first.
export function recoverTests(taskPath) {
  const stale=t=>t.tests?.status==='running'&&processIdentity(t.tests.pid,t.tests.pid_start)==='other';
  if(!stale(readTask(taskPath)))return null;
  return updateTask(taskPath,t=>{
    if(stale(t)) {
      // Kill only a test command whose start time still matches exactly; an unknown one may be a reused pid.
      if(processIdentity(t.tests.child_pid,t.tests.child_start)==='same') stopGroup(t.tests.child_pid);
      t.tests={...t.tests,status:'failed',reason:'interrupted'};
    }
  }).tests;
}
export async function runTests(taskPath, {argv}) {
  if(!Array.isArray(argv) || !argv.length || argv.some(a=>typeof a !== 'string') || !argv[0]) throw Error('test argv required');
  recoverTests(taskPath);
  const task=readTask(taskPath); idle(task);
  const source=sourceIdentity(task);
  const pidStart=ownStartTime();
  updateTask(taskPath,t=>{idle(t);t.tests={...source,argv,status:'running',pid:process.pid,pid_start:pidStart,started_at:new Date().toISOString()};});
  let code,child,signal=null;
  const stop=name=>{signal??=name;if(child?.pid)stopGroup(child.pid,name);};
  for(const name of ['SIGINT','SIGTERM'])process.on(name,stop);
  try {
    code=await new Promise((resolve,reject)=>{
      child=spawn(argv[0],argv.slice(1),{cwd:task.repository.working_directory,env:gitEnvironment(),stdio:'inherit',detached:true});
      child.once('error',reject); child.once('close',code=>resolve(code));
      // The child's own start time, read right after spawn, is what recovery later compares exactly.
      child.once('spawn',()=>{try { const start=processStartTime(child.pid); updateTask(taskPath,t=>{t.tests.child_pid=child.pid;t.tests.child_start=start;}); } catch(error) { stopGroup(child.pid); reject(error); }});
    });
  } catch(error) {
    updateTask(taskPath,t=>{t.tests.status='failed';});
    throw error;
  } finally { for(const name of ['SIGINT','SIGTERM'])process.off(name,stop); }
  if(signal)return updateTask(taskPath,t=>{t.tests={...source,argv,status:'blocked',reason:'interrupted',signal,exit_code:code};}).tests;
  const unchanged=same(source,sourceIdentity(readTask(taskPath)));
  return updateTask(taskPath,t=>{t.tests={...source,argv,status:code===0&&unchanged?'passed':'failed',exit_code:code};}).tests;
}
function repositoryName(remote) {
  const name=/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
  if(!name) throw Error('GitHub origin required');
  return name;
}
function github(args) {
  const output=execFileSync('gh',args,{encoding:'utf8',env:gitEnvironment(),maxBuffer:8*1024*1024,timeout:120000});
  return args[0]==='api'?JSON.parse(output):output;
}
function pull(task,number,query) {
  if(!Number.isSafeInteger(number)||number<1)throw Error('numeric PR required');
  const repo=repositoryName(task.repository.remote), endpoint=`repos/${repo}/pulls/${number}`;
  return {repo,endpoint,state:query(['api',endpoint])};
}
function exact(task,state,pr,head,repo) {
  if(state.number!==pr || state.head?.sha!==head || state.head?.ref!==task.repository.branch ||
    state.head?.repo?.full_name!==repo || state.base?.repo?.full_name!==repo || state.base?.ref!==task.repository.base_branch) {
    throw Error('PR repository, branch, base, or head mismatch');
  }
}
export function verifyDelivery(taskPath,{pr,query=github}={}) {
  recoverTests(taskPath);
  const task=readTask(taskPath),source=sourceIdentity(task), blockers=[];
  if(task.status==='cancelled')blockers.push('task cancelled');
  if(task.tests?.status!=='passed'||!same(task.tests,source))blockers.push('passing tests required on current bytes and head');
  // Paseo, not the task record, tracks a managed Worker's lifecycle, so this is the label managed Workers always got.
  const workflow='direct-or-incomplete';
  let publication=null,reviewStatus=task.browser_review?'required':'off';
  if(task.delivery!=='local') {
    if(git(task.repository.working_directory,'status','--porcelain'))blockers.push('worktree dirty');
    if(task.merge?.status==='pending')blockers.push('merge outcome uncertain');
    try {
      const {repo,endpoint,state}=pull(task,pr,query);
      const published=state.merged&&task.merge?.head===source.head?task.merge:null;
      exact(task,state,pr,source.head,repo);
      if(published&&state.merge_commit_sha!==published.commit)throw Error('published merge identity changed');
      if(!published)git(task.repository.working_directory,'merge-base','--is-ancestor',state.base.sha,source.head);
      if(task.browser_review) {
        const reviews=query(['api',`${endpoint}/reviews?per_page=100`]);
        reviewStatus=requireReviewDelivery(task,{pr,head:source.head,state,reviews}).status;
        const refreshed=pull(task,pr,query).state;
        exact(task,refreshed,pr,source.head,repo);
        if(refreshed.state!==state.state||refreshed.merged!==state.merged||refreshed.draft!==state.draft||refreshed.base.sha!==state.base.sha||refreshed.user?.login!==state.user?.login)throw Error('PR changed during review verification');
      }
      if(state.draft || (!state.merged&&state.state!=='open'))throw Error('PR not open for delivery');
      publication={pr,url:state.html_url,base:published?.base??state.base.sha,
        approved_head:reviewStatus==='approved'?source.head:null,review_status:reviewStatus,
        pr_head:state.head.sha,merged:state.merged,merge_commit:state.merge_commit_sha};
    } catch(error){blockers.push(error.message);}
  }
  if(!same(source,sourceIdentity(readTask(taskPath))))blockers.push('source changed during verification');
  return {status:blockers.length?'blocked':'verified',blockers,workflow,...source,publication};
}
export function mergeDelivery(taskPath,{pr,query=github}={}) {
  recoverTests(taskPath);
  let task=readTask(taskPath);
  if(task.delivery!=='merge')throw Error('merge not authorized by task');
  if(task.merge?.status==='pending')return reconcileMerge(taskPath,{query});
  const verified=verifyDelivery(taskPath,{pr,query});
  if(verified.status!=='verified')throw Error(verified.blockers.join('; '));
  if(verified.publication.merged)throw Error('PR already merged; inspect existing result');
  const {repo,state}=pull(task,pr,query); exact(task,state,pr,verified.head,repo);
  if(state.base.sha!==verified.publication.base)throw Error('base changed after verification; refresh and retest');
  git(task.repository.working_directory,'merge-base','--is-ancestor',state.base.sha,verified.head);
  if(!same(verified,sourceIdentity(readTask(taskPath))))throw Error('source changed before merge');
  const intent={pr,head:verified.head,base:state.base.sha,protocol:'github',status:'pending'};
  updateTask(taskPath,t=>{idle(t);t.merge=intent;});
  try {query(['pr','merge',String(pr),'--repo',repo,'--merge','--match-head-commit',verified.head]);}
  catch { /* Never repeat an uncertain write. Reconcile the actual result below. */ }
  return reconcileMerge(taskPath,{query});
}
export function reconcileMerge(taskPath,{query=github}={}) {
  const task=readTask(taskPath),intent=task.merge;
  if(!intent)throw Error('no merge intent');
  const {repo,state}=pull(task,intent.pr,query);
  exact(task,state,intent.pr,intent.head,repo);
  if(!state.merged)throw Error('merge not confirmed; intent retained, do not retry blindly');
  if(!/^[0-9a-f]{40}$/.test(state.merge_commit_sha??''))throw Error('GitHub merge commit missing');
  if(intent.commit&&state.merge_commit_sha!==intent.commit)throw Error('GitHub merge does not match the published commit');
  const commit=query(['api',`repos/${repo}/commits/${state.merge_commit_sha}`]);
  if(commit.parents?.length!==2||commit.parents[1].sha!==intent.head)throw Error('merge ancestry mismatch');
  // GitHub owns integration with the current base. Its native head guard is
  // not a compare-and-swap on main; record the base it actually merged.
  if(intent.protocol!=='github'&&commit.parents[0].sha!==intent.base)throw Error('merge ancestry mismatch');
  return updateTask(taskPath,t=>{t.merge={...intent,status:'merged',base:commit.parents[0].sha,commit:state.merge_commit_sha};}).merge;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command,path,...args]=process.argv.slice(2);
    let result;
    if(command==='test')result=await runTests(path,{argv:args});
    else if(command==='verify')result=verifyDelivery(path,{pr:Number(args[0])});
    else if(command==='merge')result=mergeDelivery(path,{pr:Number(args[0])});
    else if(command==='reconcile'){const tests=recoverTests(path);result=tests&&!readTask(path).merge?tests:reconcileMerge(path);}
    else throw Error('usage: delivery.mjs test <task.json> <executable> [args...] | verify <task.json> <PR> | merge <task.json> <PR> | reconcile <task.json> (interrupted tests, then merge)');
    console.log(JSON.stringify(result));
    if(['failed','blocked','pending'].includes(result.status))process.exitCode=1;
  } catch(error){console.error(error.message);process.exitCode=1;}
}
