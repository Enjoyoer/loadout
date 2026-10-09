#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

// Count the complete Markdown source (including frontmatter and link titles),
// conservatively charging syntax as words rather than hiding it from the budget.
export const wordCount = text => text.trim().split(/\s+/u).filter(Boolean).length;

export function documentLinks(text) {
  return [...text.matchAll(/\]\(([^\s)]+)(?:\s+"([^"]+)")?\)/g)]
    .map(([, target, route]) => ({ target, route }));
}

export function instructionPath(documents, branches = []) {
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    assert.ok(documents[file], `missing instruction document: ${file}`);
    visited.add(file);
    for (const { target, route } of documentLinks(documents[file])) {
      if (/^[a-z]+:/i.test(target)) continue;
      const link = target.split('#')[0];
      if (!link) continue;
      const next = posix.normalize(posix.join(posix.dirname(file), link));
      if (!next.endsWith('.md')) continue;
      assert.ok(route === 'runtime' || /^branch:[a-z-]+$/.test(route ?? ''),
        `${file}: classify instruction link ${target} as runtime or branch`);
      if (route === 'runtime' || branches.includes(route.slice(7))) visit(next);
    }
  }
  visit('SKILL.md');
  return { files: [...visited], words: [...visited].reduce((sum, file) => sum + wordCount(documents[file]), 0) };
}

export function validateInstructions(documents) {
  const entryWords = wordCount(documents['SKILL.md']);
  assert.ok(entryWords >= 500 && entryWords <= 700, `entrypoint word budget: ${entryWords} (500..700)`);
  const normal = instructionPath(documents);
  assert.ok(normal.words <= 1500, `normal-path word budget: ${normal.words} (<=1500)`);
  const conditional = ['exploration-swarm', 'planner', 'web-reviewer', 'simplifier-review',
    'web-lane', 'web-large-inputs', 'codex-sites', 'web-models-not-approved', 'recovery', 'maintenance', 'cloud-lane', 'pr-evidence', 'routing'];
  for (const name of conditional) assert.ok(!normal.files.includes(`references/${name}.md`),
    `conditional reference leaked into normal path: ${name}`);
  const scouted = instructionPath(documents, ['scouting']);
  assert.ok(scouted.words <= 1500, `scouted normal-path word budget: ${scouted.words} (<=1500)`);
  const all = instructionPath(documents, ['scouting', 'planning', 'review', 'sites', 'recovery', 'risk', 'maintenance', 'cloud', 'evidence', 'large-input', 'routing']);
  assert.deepEqual(new Set(all.files), new Set(Object.keys(documents)), 'every instruction document needs a reachable branch');
  return { entryWords, normalWords: normal.words, scoutedNormalWords: scouted.words, normalFiles: normal.files };
}

export async function validatePackage(root = defaultRoot) {
  const paths = ['SKILL.md', ...(await readdir(resolve(root, 'references')))
    .filter(file => file.endsWith('.md')).map(file => `references/${file}`)];
  const documents = Object.fromEntries(await Promise.all(paths.map(async relative =>
    [relative, await readFile(resolve(root, relative), 'utf8')])));
  for (const [relative, text] of Object.entries(documents)) {
    assert.ok(text.trim(), relative + ' is empty');
    for (const { target } of documentLinks(text)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [link, anchor] = target.split('#');
      const absolute = resolve(root, dirname(relative), link || relative.split('/').at(-1));
      await access(absolute);
      if (anchor && absolute.endsWith('.md')) {
        const headings = (await readFile(absolute, 'utf8')).match(/^#+ .+$/gm) ?? [];
        const anchors = headings.map(heading => heading.replace(/^#+ /, '').toLowerCase()
          .replace(/[^\p{L}\p{N} _-]/gu, '').replaceAll(' ', '-'));
        assert.ok(anchors.includes(anchor), `${relative}: missing anchor ${target}`);
      }
    }
  }
  const instructions = validateInstructions(documents);
  await access(resolve(root, 'agents/openai.yaml'));
  const contracts = {
    'delivery.mjs': ['runTests', 'verifyDelivery', 'mergeDelivery', 'reconcileMerge'],
    'task-state.mjs': ['createTask', 'readTask', 'updateTask'],
    'agent-routing.mjs': ['resolveAgentRoute', 'selectWorkerRoute', 'buildDelegatedBrief', 'selectTopology', 'isGptOrWebRoute'],
    'quota-pace.mjs': ['readRoutingSettings', 'validateRoutingSettings', 'readQuota', 'poolPace', 'paceLevel'],
    'route.mjs': ['resolveWorkerRoute', 'recordWorkerRoute', 'resolveCloudFallback'],
    'planner.mjs': ['buildPlannerPrompt', 'preparePlannerLaunch', 'bindPlannerAgent',
      'recordPlannerLaunchFailure', 'collectPlanner', 'authorizePlannerFallback'],
    'web-reviewer.mjs': ['buildReviewPrompt', 'prepareReviewLaunch', 'bindReviewAgent',
      'recordReviewLaunchFailure', 'collectReview', 'requireReviewApproval', 'requireReviewDelivery'],
    'cloud-lane.mjs': ['readCloudToggle', 'setCloudToggle', 'readCloudRepos', 'isCloudRepo', 'setCloudRepo', 'classifyCloudFailure', 'checkCloudEligibility', 'resolveCloudWorkerRoute',
      'buildCloudBrief', 'buildCloudLaunchCommand', 'buildCloudHeartbeatRequest', 'assessCloudProgress',
      'recordCloudLaunch', 'recordCloudProgress', 'authorizeCloudFallback', 'readCloudProfile', 'setCloudProfile'],
    'paseo-worker.mjs': ['managedWorkerNames', 'selectUnattendedMode', 'buildManagedWorkspaceRequest',
      'buildManagedWorkerRequest', 'validateManagedWorkerLaunch', 'buildManagedWorkerFollowupRequest',
      'archiveManagedWorkerWorkspace'],
  };
  for (const [file, names] of Object.entries(contracts)) {
    const module = await import(pathToFileURL(resolve(root, 'scripts', file)));
    for (const name of names) assert.equal(typeof module[name], 'function', file + ': ' + name);
  }
  return { status: 'passed', modules: Object.keys(contracts).length, documents: paths.length, ...instructions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await validatePackage(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
