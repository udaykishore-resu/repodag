# RepoDAG privacy policy

Last updated: 2026-10-10

RepoDAG does not collect, store, sell or share personal data, and has no server of its own.

**What leaves your browser.** One kind of request, and only when you ask for it: when you click "Map this repository" (or press "Load" in the viewer), the extension downloads that repository's source archive from GitHub, at `https://github.com/<owner>/<repository>/archive/<ref>.zip`, which GitHub redirects to `codeload.github.com`. The request is sent with your GitHub cookies so that private repositories you are signed in to can be downloaded; it goes to GitHub and nowhere else. The extension's content security policy allows connections to those two hosts only.

**What is read.** The address of the current tab, at the moment you click the toolbar icon, to see whether it is a GitHub repository page. The files inside the archive, or inside a zip or folder you choose from your computer. Local files are read in the tab and are never uploaded.

**What is stored.** Nothing. The archive and the graph live in the memory of the viewer tab and are gone when you close it. The extension does not use browser storage, cookies of its own, or sync.

**What is not done.** No analytics, no tracking, no advertising, no remote code. The extension has no content scripts and does not change any web page.

**Files you save.** Exports (SVG, Mermaid, Graphviz DOT, JSON) are written to your downloads folder or clipboard when you press the button, and go nowhere else.

Contact: open an issue on the project's repository.
