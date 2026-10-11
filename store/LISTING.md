# Chrome Web Store listing: RepoDAG

Everything to paste into the developer dashboard. URLs assume the repo is `github.com/udaykishore-resu/repodag`; change them if you name it differently.

## Store listing tab

| Field | Value |
|---|---|
| Category | Developer Tools |
| Language | English |
| Store icon | `repodag-store-icon-128.png` |
| Screenshots | `repodag-screenshot-1.png`, `repodag-screenshot-2.png` |
| Small promo tile | `repodag-promo-440x280.png` |
| Marquee promo tile | leave empty |
| Global promo video | leave empty |
| Official URL | None |
| Homepage URL | `https://github.com/udaykishore-resu/repodag` |
| Support URL | `https://github.com/udaykishore-resu/repodag/issues` |
| Mature content | No |

### Description

```
RepoDAG draws the structure of a source code repository as a graph you read from left to right.

Open a repository on GitHub, click the toolbar icon and choose "Map this repository". A new tab downloads the source archive, reads it in your browser and shows three graphs.

Code imports shows which files and folders depend on which. Everything sits to the left of the things it depends on, so entry points end up on the left and shared building blocks on the right.

CI pipeline shows the jobs of the repository's workflows in the order they run, including jobs that wait for other jobs and workflows that start other workflows.

Third-party packages shows each dependency file found in the repository and the packages it asks for directly, with the versions requested. A package used in several places appears once, so shared dependencies stand out. Packages needed only for development and tests are marked and can be hidden.

Loops are found and listed. Choose one to see exactly which files depend on each other in a circle. The edge that closes a loop is drawn in red and dashed, pointing against the flow.

Large repositories start grouped by folder so the picture stays readable. You can switch between files, packages and folders at a depth you choose, search by name, and click anything to see what it depends on and what uses it.

The current view can be saved as an image, as text for common diagram tools, or as data.

It also works without GitHub: drop a zip file or pick a folder from your computer, and it is read in the tab without being uploaded.

Privacy: the only network request is the download of the repository archive from GitHub, made when you ask for it. There are no analytics, no accounts and no server.

Limits: imports are found by reading source text, not by running a compiler, so unusual build setups and imports created at run time can be missed. The page tells you how many imports it found for each language and how many it could not match to a file, so you can judge the result.
```

## Privacy tab

**Single purpose**

```
Draws the dependency graph of a source code repository: which files import which, how its CI jobs depend on each other, and which third-party packages its dependency files ask for.
```

**Permission justifications**

| Permission | Justification |
|---|---|
| `activeTab` | Reads the address of the current tab when the user clicks the toolbar icon, to see whether it is a GitHub repository page and which repository it is. Nothing on the page is read or changed. |
| Host permission `https://github.com/*` | Downloads the source archive of the repository the user asked to map (`https://github.com/<owner>/<repo>/archive/<ref>.zip`) from the extension's viewer page. Cookies are included so private repositories the user is signed in to can be downloaded. |
| Host permission `https://codeload.github.com/*` | GitHub answers the archive request with a redirect to `codeload.github.com`, which serves the file. Without this host the download is blocked. |

**Remote code:** No, I am not using remote code. All scripts are packaged with the extension; the content security policy is `script-src 'self'`.

**Data usage:** tick **Website content** (the extension downloads and reads the source files of the repository the user chooses). Tick nothing else. Certify all three statements. Nothing is transmitted to the developer or to any third party; the only request goes to GitHub.

**Privacy policy URL:** `https://github.com/udaykishore-resu/repodag/blob/main/PRIVACY.md`

## Distribution tab

Free · Public · All regions.

## Test instructions tab (optional, helps review)

```
No account needed.
1. Open https://github.com/udaykishore-resu/idem
2. Click the RepoDAG toolbar icon, then "Map this repository".
3. A new tab opens and draws the graph. Use the three tabs at the top to switch between code imports, CI pipeline and third-party packages. Click any box to see its details on the right.
To try it without GitHub: click the toolbar icon on any page, choose "Open a zip or folder from your computer", and drop a zip of any source project.
```
