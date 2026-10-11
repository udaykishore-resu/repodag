// GitHub Actions workflows: jobs, needs, reusable-workflow calls and workflow_run triggers.
const test = require('node:test');
const assert = require('node:assert/strict');
const Workflows = require('../extension/lib/workflows.js');
const Views = require('../extension/lib/views.js');

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint
        run: npm run lint
  test:
    name: Unit tests (\${{ matrix.node }})
    needs: lint
    runs-on: [self-hosted, linux]
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - run: |
          npm ci
          npm test
  build:
    needs: [lint, test]
    runs-on:
      group: big
      labels: [x64]
    if: github.event_name == 'push'
    environment:
      name: staging
    steps:
      - run: make build
  package:
    needs: [build, ghost]
    uses: ./.github/workflows/reusable-package.yml
    with:
      target: all
  external:
    uses: acme/shared/.github/workflows/scan.yml@v1
`;

const REUSABLE = `name: Package
on:
  workflow_call:
    inputs:
      target:
        type: string
jobs:
  wheel:
    runs-on: ubuntu-latest
    steps:
      - run: make wheel
  sign:
    needs: wheel
    runs-on: ubuntu-latest
    steps:
      - uses: sigstore/cosign-installer@v3
`;

const DEPLOY = `name: Deploy
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
  notify:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`;

function load() {
  return Workflows.analyze(
    new Map([
      ['.github/workflows/ci.yml', CI],
      ['.github/workflows/reusable-package.yml', REUSABLE],
      ['.github/workflows/deploy.yaml', DEPLOY],
      ['.github/workflows/broken.yml', 'name: Broken\njobs:\n  a:\n    steps: [unclosed\n'],
      ['.github/workflows/empty.yml', ''],
      ['.github/workflows/nested/ignored.yml', 'jobs: {x: {runs-on: a}}'],
      ['.github/dependabot.yml', 'version: 2'],
      ['docs/workflows/ci.yml', CI],
    ])
  );
}

test('only files directly under .github/workflows count', () => {
  assert.equal(Workflows.isWorkflowPath('.github/workflows/ci.yml'), true);
  assert.equal(Workflows.isWorkflowPath('.github/workflows/CI.YAML'), true);
  assert.equal(Workflows.isWorkflowPath('.github/workflows/sub/ci.yml'), false);
  assert.equal(Workflows.isWorkflowPath('pkg/.github/workflows/ci.yml'), false);
  assert.equal(Workflows.isWorkflowPath('.github/dependabot.yml'), false);
  const r = load();
  assert.deepEqual(r.workflows.map((w) => w.path), [
    '.github/workflows/broken.yml', '.github/workflows/ci.yml', '.github/workflows/deploy.yaml', '.github/workflows/empty.yml', '.github/workflows/reusable-package.yml',
  ]);
});

test('one node per job, labelled by name or id, with its details', () => {
  const r = load();
  const byId = new Map(r.jobs.map((j) => [j.id, j]));
  assert.equal(r.jobs.length, 9);
  const t = byId.get('.github/workflows/ci.yml#test');
  assert.equal(t.name, 'Unit tests (${{ matrix.node }})');
  assert.equal(t.runsOn, 'self-hosted, linux');
  assert.equal(t.matrix, true);
  assert.deepEqual(t.steps.map((s) => s.label), ['actions/checkout@v4', 'actions/setup-node@v4', 'npm ci']);
  assert.deepEqual(t.uses, ['actions/checkout@v4', 'actions/setup-node@v4']);
  const lint = byId.get('.github/workflows/ci.yml#lint');
  assert.equal(lint.name, 'lint');
  assert.deepEqual(lint.steps.map((s) => s.label), ['actions/checkout@v4', 'Lint']);
  const build = byId.get('.github/workflows/ci.yml#build');
  assert.equal(build.runsOn, 'group big; x64');
  assert.equal(build.condition, "github.event_name == 'push'");
  assert.equal(build.environment, 'staging');
  assert.equal(byId.get('.github/workflows/ci.yml#package').calls, './.github/workflows/reusable-package.yml');
  assert.equal(byId.get('.github/workflows/ci.yml#external').calls, 'acme/shared/.github/workflows/scan.yml@v1');
});

test('edges: needs as string or list, reusable calls, workflow_run', () => {
  const r = load();
  const edges = r.edges.map((e) => e.from.split('/').pop() + ' -> ' + e.to.split('/').pop() + ' [' + e.kind + ']').sort();
  assert.deepEqual(edges, [
    'ci.yml#build -> ci.yml#package [needs]',
    'ci.yml#external -> deploy.yaml#deploy [workflow_run]',
    'ci.yml#lint -> ci.yml#build [needs]',
    'ci.yml#lint -> ci.yml#test [needs]',
    'ci.yml#package -> deploy.yaml#deploy [workflow_run]',
    'ci.yml#package -> reusable-package.yml#wheel [calls]',
    'ci.yml#test -> ci.yml#build [needs]',
    'deploy.yaml#deploy -> deploy.yaml#notify [needs]',
    'reusable-package.yml#wheel -> reusable-package.yml#sign [needs]',
  ]);
});

test('problems are reported as notes, never thrown', () => {
  const r = load();
  const notes = r.notes.join('\n');
  assert.match(notes, /broken\.yml is not valid YAML/);
  assert.match(notes, /empty\.yml has no workflow/);
  assert.match(notes, /job "package" needs "ghost", which is not defined/);
  const broken = r.workflows.find((w) => w.path.endsWith('broken.yml'));
  assert.ok(broken.error);
});

test('triggers are listed for string, list and mapping forms', () => {
  const r = Workflows.analyze(
    new Map([
      ['.github/workflows/a.yml', 'on: push\njobs: {j: {runs-on: x}}'],
      ['.github/workflows/b.yml', 'on: [push, pull_request]\njobs: {j: {runs-on: x}}'],
      ['.github/workflows/c.yml', 'on: {schedule: [{cron: "0 0 * * *"}], workflow_dispatch: }\njobs: {j: {runs-on: x}}'],
    ])
  );
  assert.deepEqual(r.workflows.map((w) => w.triggers), [['push'], ['push', 'pull_request'], ['schedule', 'workflow_dispatch']]);
  assert.equal(r.workflows[0].name, 'a.yml', 'a workflow without a name is shown by its file name');
});

test('a call to a workflow that is missing, and a workflow_run that names nothing, are noted', () => {
  const r = Workflows.analyze(
    new Map([
      ['.github/workflows/a.yml', 'on:\n  workflow_run:\n    workflows: ["Nope"]\njobs:\n  j:\n    uses: ./.github/workflows/gone.yml\n'],
    ])
  );
  assert.equal(r.edges.length, 0);
  assert.match(r.notes.join('\n'), /calls \.\/\.github\/workflows\/gone\.yml, which is not in the repository/);
  assert.match(r.notes.join('\n'), /runs after "Nope", which does not match any workflow name/);
});

test('view: jobs are grouped by workflow and an empty repository gives an empty graph', () => {
  const v = Views.ciView(load());
  assert.equal(v.nodes.length, 9);
  assert.deepEqual(v.groups.map((g) => g.key + ':' + g.count), ['CI:5', 'Deploy:2', 'Package:2']);
  assert.ok(v.edges.every((e) => v.nodes.some((n) => n.id === e.from) && v.nodes.some((n) => n.id === e.to)));
  const empty = Views.ciView(Workflows.analyze(new Map([['README.md', 'x']])));
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
});
