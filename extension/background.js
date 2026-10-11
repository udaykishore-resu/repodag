/* RepoDAG does all of its work in the popup and the viewer page. This service worker has nothing to do:
   it listens to no events, keeps no state and makes no requests. It exists so the extension has a background
   context with a stable URL, which the end-to-end tests use to find the extension id. */
