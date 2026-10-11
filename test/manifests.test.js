// Dependency manifests: every reader, then the combined graph.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../extension/lib/manifests.js');
const Views = require('../extension/lib/views.js');

const list = (deps) => deps.map((d) => d.name + '@' + (d.version || '') + ' ' + d.kind);

test('which files are manifests', () => {
  const kind = M.manifestKind;
  assert.equal(kind('go.mod'), 'gomod');
  assert.equal(kind('web/package.json'), 'npm');
  assert.equal(kind('requirements.txt'), 'requirements');
  assert.equal(kind('requirements-dev.txt'), 'requirements');
  assert.equal(kind('requirements/test.txt'), 'requirements');
  assert.equal(kind('docs/notes.txt'), null);
  assert.equal(kind('pyproject.toml'), 'pyproject');
  assert.equal(kind('crates/a/Cargo.toml'), 'cargo');
  assert.equal(kind('pom.xml'), 'pom');
  assert.equal(kind('app/build.gradle'), 'gradle');
  assert.equal(kind('app/build.gradle.kts'), 'gradle');
  assert.equal(kind('build.sbt'), 'sbt');
  assert.equal(kind('package-lock.json'), null);
  assert.equal(kind('Cargo.lock'), null);
});

test('go.mod: direct and indirect requirements, blocks, replace', () => {
  const p = M.parseGoMod(`module example.com/app // the module

go 1.22
toolchain go1.22.3

require github.com/single/line v1.0.0

require (
	github.com/a/b v1.2.3
	github.com/c/d/v2 v2.0.1 // indirect
	"github.com/quoted/x" v0.1.0
	example.com/local v0.0.0 // some note; indirect
)

replace example.com/local => ../local
replace github.com/a/b v1.2.3 => github.com/fork/b v1.2.4

exclude github.com/bad/x v1.0.0
retract v0.9.0
`);
  assert.equal(p.name, 'example.com/app');
  assert.deepEqual(list(p.deps), [
    'github.com/single/line@v1.0.0 runtime',
    'github.com/a/b@v1.2.3 runtime',
    'github.com/c/d/v2@v2.0.1 indirect',
    'github.com/quoted/x@v0.1.0 runtime',
    'example.com/local@v0.0.0 indirect',
  ]);
  assert.equal(p.deps[1].replacedBy, 'github.com/fork/b v1.2.4');
  assert.equal(p.deps[4].replacedBy, '../local');
});

test('package.json: the four dependency fields', () => {
  const p = M.parsePackageJson(JSON.stringify({
    name: '@acme/web',
    workspaces: ['packages/*'],
    dependencies: { react: '^18.2.0', '@acme/core': 'workspace:*' },
    devDependencies: { vitest: '^1.0.0' },
    peerDependencies: { 'react-dom': '>=18' },
    optionalDependencies: { fsevents: '2.3.3' },
    scripts: { build: 'x' },
  }));
  assert.equal(p.name, '@acme/web');
  assert.equal(p.hasWorkspaces, true);
  assert.deepEqual(list(p.deps), ['react@^18.2.0 runtime', '@acme/core@workspace:* runtime', 'vitest@^1.0.0 dev', 'react-dom@>=18 peer', 'fsevents@2.3.3 optional']);
  assert.throws(() => M.parsePackageJson('{ not json'));
});

test('requirements.txt: pins, extras, markers, options, URLs, comments', () => {
  const p = M.parseRequirementsTxt(`# comment
requests==2.31.0
Flask[async]>=2.0,<3.0 ; python_version >= "3.8"   # trailing
typing_extensions
uvicorn [standard] ~= 0.23
zope.interface>=5

-r other.txt
-c constraints.txt
--index-url https://example.org/simple
-e git+https://github.com/acme/tool.git@main#egg=acme-tool
-e .
https://example.org/pkg.whl
name-at @ https://example.org/name_at.tar.gz
hashes==1.0 --hash=sha256:abc \\
    --hash=sha256:def
not a requirement line
`, 'requirements.txt');
  assert.deepEqual(list(p.deps), [
    'requests@==2.31.0 runtime',
    'flask@>=2.0,<3.0 runtime',
    'typing-extensions@ runtime',
    'uvicorn@~=0.23 runtime',
    'zope-interface@>=5 runtime',
    'acme-tool@from URL runtime',
    'name-at@from URL runtime',
    'hashes@==1.0 runtime',
  ]);
  assert.equal(M.parseRequirementsTxt('pytest\n', 'requirements-dev.txt').deps[0].kind, 'dev');
  assert.equal(M.parseRequirementsTxt('pytest\n', 'requirements/test.txt').deps[0].kind, 'dev');
  assert.equal(M.parseRequirementsTxt('django\n', 'requirements/base.txt').deps[0].kind, 'runtime');
});

test('pyproject.toml: PEP 621, optional groups, dependency groups, build requirements', () => {
  const p = M.parsePyproject(`
[build-system]
requires = ["hatchling>=1.18"]
build-backend = "hatchling.build"

[project]
name = "My_Project"
dependencies = [
  "httpx>=0.25",
  "pydantic[email]>=2,<3; python_version>='3.9'",
]

[project.optional-dependencies]
cli = ["click>=8"]
dev = ["pytest", "ruff==0.1.0"]

[dependency-groups]
docs = ["sphinx", {include-group = "other"}]

[tool.uv]
dev-dependencies = ["mypy>=1"]
`);
  assert.equal(p.name, 'my-project');
  assert.deepEqual(list(p.deps), [
    'httpx@>=0.25 runtime',
    'pydantic@>=2,<3 runtime',
    'click@>=8 optional',
    'pytest@ dev',
    'ruff@==0.1.0 dev',
    'sphinx@ dev',
    'hatchling@>=1.18 build',
    'mypy@>=1 dev',
  ]);
});

test('pyproject.toml: Poetry tables', () => {
  const p = M.parsePyproject(`
[tool.poetry]
name = "poetry-demo"

[tool.poetry.dependencies]
python = "^3.9"
requests = "^2.31"
rich = { version = ">=13", optional = true }
local-lib = { path = "../local-lib", develop = true }
from-git = { git = "https://github.com/acme/x.git" }
multi = [{ version = "^1.0", python = "<3.11" }, { version = "^2.0", python = ">=3.11" }]

[tool.poetry.dev-dependencies]
black = "*"

[tool.poetry.group.test.dependencies]
pytest = "^7"
`);
  assert.equal(p.name, 'poetry-demo');
  assert.deepEqual(list(p.deps), [
    'requests@^2.31 runtime',
    'rich@>=13 optional',
    'local-lib@path runtime',
    'from-git@git runtime',
    'multi@^1.0 runtime',
    'black@* dev',
    'pytest@^7 dev',
  ]);
});

test('Cargo.toml: dependency tables, renames, targets, workspace inheritance', () => {
  const p = M.parseCargo(`
[package]
name = "engine"
version = "0.1.0"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
anyhow = "1"
core-types = { path = "../core-types" }
tokio.workspace = true
alias = { package = "real-name", version = "2" }
opt = { version = "0.3", optional = true }
gitdep = { git = "https://github.com/acme/gitdep" }

[dev-dependencies]
criterion = "0.5"

[build-dependencies]
cc = "1"

[target.'cfg(windows)'.dependencies]
winapi = "0.3"
`);
  assert.equal(p.name, 'engine');
  assert.deepEqual(list(p.deps), [
    'serde@1.0 runtime',
    'anyhow@1 runtime',
    'core-types@path runtime',
    'tokio@ runtime',
    'real-name@2 runtime',
    'opt@0.3 optional',
    'gitdep@git runtime',
    'criterion@0.5 dev',
    'cc@1 build',
    'winapi@0.3 runtime',
  ]);
  assert.equal(p.deps[3].fromWorkspace, 'tokio');
});

test('pom.xml: scopes, properties, managed versions, profiles; plugin dependencies are not project dependencies', () => {
  const p = M.parsePom(`<?xml version="1.0" encoding="UTF-8"?>
<!-- header comment with <dependency> in it -->
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>parent</artifactId>
    <version>1.2.3</version>
  </parent>
  <artifactId>service</artifactId>
  <properties>
    <guava.version>33.0.0-jre</guava.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.9</version></dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>\${guava.version}</version>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
    </dependency>
    <dependency>
      <groupId>\${project.groupId}</groupId>
      <artifactId>core</artifactId>
      <version>\${project.version}</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.acme</groupId>
      <artifactId>maybe</artifactId>
      <version>1</version>
      <optional>true</optional>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <dependencies>
          <dependency><groupId>plugin.only</groupId><artifactId>not-a-project-dep</artifactId><version>1</version></dependency>
        </dependencies>
      </plugin>
    </plugins>
  </build>
  <profiles>
    <profile>
      <id>extra</id>
      <dependencies>
        <dependency><groupId>com.acme</groupId><artifactId>profiled</artifactId><version>9</version></dependency>
      </dependencies>
    </profile>
  </profiles>
</project>`);
  assert.equal(p.name, 'com.acme:service');
  assert.deepEqual(list(p.deps), [
    'com.google.guava:guava@33.0.0-jre runtime',
    'org.slf4j:slf4j-api@2.0.9 runtime',
    'com.acme:core@1.2.3 runtime',
    'junit:junit@4.13.2 dev',
    'com.acme:maybe@1 optional',
    'com.acme:profiled@9 runtime',
  ]);
});

test('build.gradle: Groovy and Kotlin notations, platforms, projects, version catalog', () => {
  const catalog = M.parseVersionCatalog(`
[versions]
okhttp = "4.12.0"
junit = { strictly = "5.10.0" }

[libraries]
okhttp-core = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
junit-jupiter = { group = "org.junit.jupiter", name = "junit-jupiter", version.ref = "junit" }
plain = "com.acme:plain:1.0"
no_version = { module = "com.acme:bom-managed" }

[bundles]
testing = ["junit-jupiter", "plain"]

[plugins]
kotlin = { id = "org.jetbrains.kotlin.jvm", version = "2.0.0" }
`);
  const groovy = M.parseGradle(`
plugins { id 'java' }
repositories { maven { url 'https://jitpack.io' } }
dependencies {
    implementation 'com.google.guava:guava:33.0.0-jre'
    api "org.slf4j:slf4j-api:2.0.9"
    compileOnly group: 'org.projectlombok', name: 'lombok', version: '1.18.30'
    testImplementation 'junit:junit:4.13.2'
    runtimeOnly 'org.postgresql:postgresql'
    implementation project(':core')
    testImplementation project(path: ':test-support')
    implementation platform('org.springframework.boot:spring-boot-dependencies:3.2.0')
    // implementation 'commented:out:1.0'
    implementation libs.okhttp.core
    testImplementation libs.bundles.testing
    implementation libs.unknown.alias
    println 'not:a:dependency'
}
`, catalog);
  assert.deepEqual(list(groovy.deps), [
    'com.google.guava:guava@33.0.0-jre runtime',
    'org.slf4j:slf4j-api@2.0.9 runtime',
    'junit:junit@4.13.2 dev',
    'org.postgresql:postgresql@ runtime',
    'org.springframework.boot:spring-boot-dependencies@3.2.0 runtime',
    'org.projectlombok:lombok@1.18.30 runtime',
    'com.squareup.okhttp3:okhttp@4.12.0 runtime',
    'org.junit.jupiter:junit-jupiter@5.10.0 dev',
    'com.acme:plain@1.0 dev',
    'libs.unknown.alias@ runtime',
  ]);
  assert.deepEqual(groovy.projects, [{ config: 'implementation', project: ':core', dev: false }, { config: 'testImplementation', project: ':test-support', dev: true }]);

  const kts = M.parseGradle(`
dependencies {
    implementation("io.ktor:ktor-client-core:2.3.7")
    api(platform("com.acme:bom:1.0"))
    implementation(kotlin("stdlib"))
    testImplementation(kotlin("test", "2.0.0"))
    implementation(project(":shared"))
    implementation(projects.feature.loginUi)
    ksp(libs.plain)
    androidTestImplementation("androidx.test:runner:1.5.2")
    add("customConfig", "x:y:1")
}
`, catalog);
  assert.deepEqual(list(kts.deps), [
    'io.ktor:ktor-client-core@2.3.7 runtime',
    'com.acme:bom@1.0 runtime',
    'androidx.test:runner@1.5.2 dev',
    'org.jetbrains.kotlin:kotlin-stdlib@ runtime',
    'org.jetbrains.kotlin:kotlin-test@2.0.0 dev',
    'com.acme:plain@1.0 runtime',
  ]);
  assert.deepEqual(kts.projects, [{ config: 'implementation', project: ':shared', dev: false }, { config: 'implementation', accessor: 'feature.loginUi', dev: false }]);
});

test('build.gradle: dependencies declared inside a test source set are test dependencies', () => {
  // Kotlin Multiplatform puts plain `implementation` inside commonTest { }, jvmTest { } and friends
  const groovy = M.parseGradle(`
kotlin {
  sourceSets {
    commonMain {
      dependencies {
        api 'org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0'
        implementation "com.acme:fmt:\${fmtVersion}"
      }
    }
    commonTest {
      dependencies {
        implementation 'org.jetbrains.kotlin:kotlin-test'
        implementation project(':testkit')
      }
    }
  }
}
`, null);
  assert.deepEqual(list(groovy.deps), [
    'org.jetbrains.kotlinx:kotlinx-coroutines-core@1.9.0 runtime',
    'com.acme:fmt@${fmtVersion} runtime',
    'org.jetbrains.kotlin:kotlin-test@ dev',
  ]);
  assert.deepEqual(groovy.projects, [{ config: 'implementation', project: ':testkit', dev: true }]);
  const kts = M.parseGradle(`
kotlin {
  sourceSets {
    val commonMain by getting {
      dependencies { implementation("a:main:1") }
    }
    val jvmTest by getting {
      dependencies { implementation("a:delegated:1") }
    }
    named("iosTest") {
      dependencies { implementation("a:named:1") }
    }
    commonTest.dependencies {
      implementation(kotlin("test"))
    }
    androidUnitTest.dependencies { implementation("a:android:1") }
    val latest by creating { dependencies { implementation("a:notatest:1") } }
  }
}
dependencies { implementation("a:after:1") }
`, null);
  assert.deepEqual(list(kts.deps), [
    'a:main@1 runtime',
    'a:delegated@1 dev',
    'a:named@1 dev',
    'a:android@1 dev',
    'a:notatest@1 runtime',
    'a:after@1 runtime',
    'org.jetbrains.kotlin:kotlin-test@ dev',
  ]);
});

test('build.sbt: %, %%, test scope, versions held in vals', () => {
  const p = M.parseSbt(`
name := "demo"
val catsVersion = "2.10.0"
lazy val root = (project in file(".")).settings(
  libraryDependencies ++= Seq(
    "org.typelevel" %% "cats-core" % catsVersion,
    "com.typesafe" % "config" % "1.4.3",
    "org.scalatest" %% "scalatest" % "3.2.17" % Test,
    "org.scalameta" %%% "munit" % "1.0.0" % "test",
    "javax.servlet" % "javax.servlet-api" % "4.0.1" % Provided
    // "commented" % "out" % "1"
  )
)
libraryDependencies += "ch.qos.logback" % "logback-classic" % "1.4.14"
`);
  assert.equal(p.name, 'demo');
  assert.deepEqual(list(p.deps), [
    'org.typelevel:cats-core@2.10.0 runtime',
    'com.typesafe:config@1.4.3 runtime',
    'org.scalatest:scalatest@3.2.17 dev',
    'org.scalameta:munit@1.0.0 dev',
    'javax.servlet:javax.servlet-api@4.0.1 optional',
    'ch.qos.logback:logback-classic@1.4.14 runtime',
  ]);
});

/* ---------- the combined graph ---------- */

function repo() {
  return new Map([
    ['go.mod', 'module example.com/app\nrequire (\n github.com/a/b v1.0.0\n github.com/x/y v0.1.0 // indirect\n example.com/app/tools v0.0.0\n)\n'],
    ['tools/go.mod', 'module example.com/app/tools\nrequire github.com/a/b v1.1.0\n'],
    ['package.json', '{"name":"root","workspaces":["packages/*"],"devDependencies":{"typescript":"^5"}}'],
    ['packages/core/package.json', '{"name":"@acme/core","dependencies":{"zod":"^3"}}'],
    ['packages/ui/package.json', '{"name":"@acme/ui","dependencies":{"@acme/core":"workspace:*","zod":"^3.22","react":"^18"},"devDependencies":{"react":"^18"}}'],
    ['Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\nserde = "1.0"\nshared = { path = "crates/shared" }\n'],
    ['crates/app/Cargo.toml', '[package]\nname = "app"\n[dependencies]\nserde.workspace = true\nshared.workspace = true\nengine = { path = "../engine" }\n'],
    ['crates/engine/Cargo.toml', '[package]\nname = "engine"\n[dev-dependencies]\nserde = "1.0"\n'],
    ['crates/shared/Cargo.toml', '[package]\nname = "shared"\n'],
    ['settings.gradle.kts', 'include(":app", ":lib")'],
    ['app/build.gradle.kts', 'dependencies {\n implementation(project(":lib"))\n implementation("com.acme:thing:1.0")\n}\n'],
    ['lib/build.gradle.kts', 'dependencies {\n testImplementation("junit:junit:4.13.2")\n}\n'],
    ['broken/Cargo.toml', '[package\nname = '],
    ['broken/package.json', '{ nope'],
  ]);
}

test('graph: one node per manifest, shared dependency nodes, local links between manifests', () => {
  const r = M.analyze(repo());
  assert.equal(r.manifests.length, 11); // the two broken files are reported, not drawn
  assert.match(r.notes.join('\n'), /broken\/Cargo\.toml could not be parsed/);
  assert.match(r.notes.join('\n'), /broken\/package\.json could not be parsed/);
  const key = (d) => d.from + ' -> ' + (d.local ? '[' + d.local + ']' : d.name) + ' ' + d.versions.join('|') + ' ' + d.kind;
  assert.deepEqual(r.deps.map(key).sort(), [
    'app/build.gradle.kts -> [lib/build.gradle.kts]  runtime',
    'app/build.gradle.kts -> com.acme:thing 1.0 runtime',
    'crates/app/Cargo.toml -> [crates/engine/Cargo.toml] path runtime',
    'crates/app/Cargo.toml -> [crates/shared/Cargo.toml] path runtime',
    'crates/app/Cargo.toml -> serde 1.0 runtime',
    'crates/engine/Cargo.toml -> serde 1.0 dev',
    'go.mod -> [tools/go.mod] v0.0.0 runtime',
    'go.mod -> github.com/a/b v1.0.0 runtime',
    'go.mod -> github.com/x/y v0.1.0 indirect',
    'lib/build.gradle.kts -> junit:junit 4.13.2 dev',
    'package.json -> typescript ^5 dev',
    'packages/core/package.json -> zod ^3 runtime',
    'packages/ui/package.json -> [packages/core/package.json] workspace:* runtime',
    'packages/ui/package.json -> react ^18 runtime', // listed as both runtime and dev: runtime wins
    'packages/ui/package.json -> zod ^3.22 runtime',
    'tools/go.mod -> github.com/a/b v1.1.0 runtime',
  ].sort());
});

test('view: dev and indirect dependencies can be hidden, shared packages are one node', () => {
  const r = M.analyze(repo());
  const all = Views.packagesView(r, { includeDev: true, includeIndirect: true });
  const dflt = Views.packagesView(r, { includeDev: true, includeIndirect: false });
  const prod = Views.packagesView(r, { includeDev: false, includeIndirect: false });
  const ids = (v) => v.nodes.filter((n) => n.kind === 'dep').map((n) => n.id).sort();
  assert.deepEqual(ids(all), ['dep:Cargo:serde', 'dep:Go:github.com/a/b', 'dep:Go:github.com/x/y', 'dep:Maven:com.acme:thing', 'dep:Maven:junit:junit', 'dep:npm:react', 'dep:npm:typescript', 'dep:npm:zod']);
  assert.ok(!ids(dflt).includes('dep:Go:github.com/x/y'));
  assert.equal(dflt.hiddenIndirect, 1);
  assert.deepEqual(ids(prod), ['dep:Cargo:serde', 'dep:Go:github.com/a/b', 'dep:Maven:com.acme:thing', 'dep:npm:react', 'dep:npm:zod']);
  assert.equal(prod.hiddenDev, 3);
  const zod = all.nodes.find((n) => n.id === 'dep:npm:zod');
  assert.equal(zod.usedBy, 2);
  assert.deepEqual(zod.versions.sort(), ['^3', '^3.22']);
  const ab = all.nodes.find((n) => n.id === 'dep:Go:github.com/a/b');
  assert.equal(ab.usedBy, 2);
  assert.equal(all.nodes.filter((n) => n.kind === 'manifest').length, 11, 'every readable manifest is a node, with or without dependencies');
  assert.equal(all.nodes.find((n) => n.id === 'dep:Maven:junit:junit').label, 'junit');
  const local = all.edges.filter((e) => e.local).map((e) => e.from + ' -> ' + e.to).sort();
  assert.deepEqual(local, [
    'app/build.gradle.kts -> lib/build.gradle.kts',
    'crates/app/Cargo.toml -> crates/engine/Cargo.toml',
    'crates/app/Cargo.toml -> crates/shared/Cargo.toml',
    'go.mod -> tools/go.mod',
    'packages/ui/package.json -> packages/core/package.json',
  ]);
  const edge = all.edges.find((e) => e.from === 'crates/engine/Cargo.toml');
  assert.equal(edge.dev, true);
  assert.equal(edge.label, '1.0');
  for (const e of all.edges) assert.ok(all.nodes.some((n) => n.id === e.to), e.to);
});

test('an npm dependency that merely shares a name with a folder in the repo is not treated as local', () => {
  const r = M.analyze(new Map([
    ['package.json', '{"name":"app","dependencies":{"left-pad":"^1.3.0"}}'],
    ['test/fixtures/left-pad/package.json', '{"name":"left-pad"}'],
  ]));
  assert.equal(r.deps.length, 1);
  assert.equal(r.deps[0].local, null);
});
