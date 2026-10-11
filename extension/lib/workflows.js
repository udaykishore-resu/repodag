/* RepoDAG GitHub Actions reader: one node per job, edges from `needs:`, reusable-workflow calls and workflow_run triggers. */
(function () {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const yamlLib = () => (inNode ? require('./js-yaml.min.js') : globalThis.jsyaml);

  function isWorkflowPath(path) {
    return /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);
  }

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
  const oneLine = (s, max) => {
    const first = String(s).trim().split('\n')[0].trim();
    return first.length > max ? first.slice(0, max - 1) + '…' : first;
  };

  function describeRunsOn(v) {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(String).join(', ');
    if (isObject(v)) {
      const parts = [];
      if (v.group) parts.push('group ' + v.group);
      if (v.labels) parts.push(asList(v.labels).join(', '));
      return parts.join('; ');
    }
    return '';
  }

  function triggersOf(on) {
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on.map(String);
    if (isObject(on)) return Object.keys(on);
    return [];
  }

  /* files: Map(path -> text). Returns
     { workflows: [{ path, name, triggers, error }],
       jobs: [{ id, workflow, key, name, runsOn, steps: [{ label, uses }], uses: [refs], calls, needs: [keys] }],
       edges: [{ from, to, kind: 'needs' | 'calls' | 'workflow_run' }]   (from runs before to)
       notes: [string] } */
  function analyze(files) {
    const workflows = [];
    const jobs = [];
    const edges = [];
    const notes = [];
    const byPath = new Map();
    const paths = [...files.keys()].filter(isWorkflowPath).sort();
    for (const path of paths) {
      const wf = { path, name: path.split('/').pop(), triggers: [], error: null, jobIds: [], workflowRun: [] };
      workflows.push(wf);
      byPath.set(path, wf);
      let doc;
      try {
        doc = yamlLib().load(files.get(path));
      } catch (e) {
        wf.error = e && e.reason ? e.reason + (e.mark ? ' at line ' + (e.mark.line + 1) : '') : String(e && e.message ? e.message : e).split('\n')[0];
        notes.push(path + ' is not valid YAML (' + wf.error + ').');
        continue;
      }
      if (!isObject(doc)) {
        wf.error = 'the file is empty or not a mapping';
        notes.push(path + ' has no workflow in it.');
        continue;
      }
      if (typeof doc.name === 'string' && doc.name.trim()) wf.name = doc.name.trim();
      // YAML 1.1 parsers read the key `on` as boolean true; accept both spellings.
      const on = doc.on !== undefined ? doc.on : doc.true;
      wf.triggers = triggersOf(on);
      if (isObject(on) && isObject(on.workflow_run)) wf.workflowRun = asList(on.workflow_run.workflows).map(String);
      if (!isObject(doc.jobs)) {
        notes.push(path + ' has no jobs.');
        continue;
      }
      for (const key of Object.keys(doc.jobs)) {
        const def = doc.jobs[key];
        if (!isObject(def)) continue;
        const job = {
          id: path + '#' + key,
          workflow: path,
          key,
          name: typeof def.name === 'string' && def.name.trim() ? def.name.trim() : key,
          runsOn: describeRunsOn(def['runs-on']),
          needs: asList(def.needs).map(String),
          steps: [],
          uses: [],
          calls: typeof def.uses === 'string' ? def.uses.trim() : null,
          condition: typeof def.if === 'string' ? oneLine(def.if, 120) : null,
          matrix: isObject(def.strategy) && def.strategy.matrix !== undefined,
          environment: typeof def.environment === 'string' ? def.environment : isObject(def.environment) && def.environment.name ? String(def.environment.name) : null,
        };
        for (const step of asList(def.steps)) {
          if (!isObject(step)) continue;
          const uses = typeof step.uses === 'string' ? step.uses.trim() : null;
          let label = '';
          if (typeof step.name === 'string' && step.name.trim()) label = oneLine(step.name, 90);
          else if (uses) label = uses;
          else if (typeof step.run === 'string') label = oneLine(step.run, 90);
          else label = '(step)';
          job.steps.push({ label, uses });
          if (uses && !job.uses.includes(uses)) job.uses.push(uses);
        }
        jobs.push(job);
        wf.jobIds.push(job.id);
      }
    }

    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const needed = new Set();
    for (const job of jobs) {
      for (const need of job.needs) {
        const target = job.workflow + '#' + need;
        if (jobById.has(target)) {
          edges.push({ from: target, to: job.id, kind: 'needs' });
          needed.add(target);
        } else {
          notes.push(job.workflow + ': job "' + job.key + '" needs "' + need + '", which is not defined in that file.');
        }
      }
    }
    const firstJobs = (wf) => wf.jobIds.filter((id) => jobById.get(id).needs.every((n) => !jobById.has(wf.path + '#' + n)));
    const lastJobs = (wf) => wf.jobIds.filter((id) => !needed.has(id));

    // reusable workflows in the same repository: the calling job starts the called workflow's first jobs
    for (const job of jobs) {
      if (!job.calls) continue;
      const m = /^\.\/(\.github\/workflows\/[^@\s]+)$/.exec(job.calls);
      if (!m) continue;
      const target = byPath.get(m[1]);
      if (!target) {
        notes.push(job.workflow + ': job "' + job.key + '" calls ' + job.calls + ', which is not in the repository.');
        continue;
      }
      for (const id of firstJobs(target)) edges.push({ from: job.id, to: id, kind: 'calls' });
    }

    // workflow_run: this workflow starts after the named workflows finish
    const byName = new Map();
    for (const wf of workflows) {
      if (!byName.has(wf.name)) byName.set(wf.name, []);
      byName.get(wf.name).push(wf);
    }
    for (const wf of workflows) {
      for (const name of wf.workflowRun) {
        const sources = byName.get(name) || workflows.filter((w) => w.path === name || w.path.endsWith('/' + name));
        if (sources.length === 0) {
          notes.push(wf.path + ' runs after "' + name + '", which does not match any workflow name in the repository.');
          continue;
        }
        for (const source of sources) {
          if (source === wf) continue;
          for (const a of lastJobs(source)) for (const b of firstJobs(wf)) edges.push({ from: a, to: b, kind: 'workflow_run' });
        }
      }
    }
    for (const wf of workflows) {
      delete wf.workflowRun;
    }
    return { workflows, jobs, edges, notes };
  }

  const api = { analyze, isWorkflowPath };
  globalThis.RepoDagWorkflows = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
